import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { processMailEvent } from "../domain/processMailEvent.js";

function firstAddress(addresses) {
  return addresses?.value?.[0] ?? {};
}

function toMailPayload(parsed, uid) {
  const sender = firstAddress(parsed.from);

  return {
    message_id: parsed.messageId ?? `imap:${uid}`,
    received_at: parsed.date?.toISOString(),
    from_email: sender.address ?? "",
    from_name: sender.name ?? "",
    subject: parsed.subject ?? "",
    body: parsed.text ?? parsed.html ?? "",
    attachments: (parsed.attachments ?? []).map((item) => ({
      filename: item.filename ?? item.contentType ?? "attachment",
    })),
  };
}

function createClient(config) {
  const client = new ImapFlow({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: {
      user: config.user,
      pass: config.password,
    },
    logger: false,
    connectionTimeout: config.connectionTimeoutMs,
  });

  client.on("error", (error) => {
    console.error("[mail-hook] imap error", error.message);
  });

  return client;
}

function describeError(error) {
  if (!(error instanceof Error)) {
    return String(error);
  }

  const details = [
    error.message,
    error.code ? `code=${error.code}` : "",
    error.response ? `response=${error.response}` : "",
    error.responseText ? `responseText=${error.responseText}` : "",
  ].filter(Boolean);

  return details.join(" ");
}

function withTimeout(promise, timeoutMs, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} timeout after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function markSeen(client, uid, timeoutMs) {
  try {
    await withTimeout(client.messageFlagsAdd(uid, ["\\Seen"], { uid: true }), timeoutMs, `mark seen uid=${uid}`);
    console.log(`[mail-hook] marked seen uid=${uid}`);
  } catch (error) {
    console.error(`[mail-hook] mark seen failed uid=${uid}`, describeError(error));
  }
}

async function readProcessedIds(filePath) {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return new Set(Array.isArray(parsed.processedMessageIds) ? parsed.processedMessageIds : []);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return new Set();
    }
    throw error;
  }
}

async function writeProcessedIds(filePath, ids) {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify({ processedMessageIds: [...ids].sort() }, null, 2), "utf8");
}

async function createProcessedStore(config, options) {
  if (options.processedStore) {
    return options.processedStore;
  }

  const filePath = config.processedStorePath ?? ".codex-tmp/processed-mail-ids.json";
  const ids = await readProcessedIds(filePath);

  return {
    has(messageId) {
      return ids.has(messageId);
    },
    async add(messageId) {
      ids.add(messageId);
      await writeProcessedIds(filePath, ids);
    },
  };
}

function toMailEvent(parsed, uid) {
  return {
    source: "imap",
    type: "email.received",
    receivedAt: new Date().toISOString(),
    payload: toMailPayload(parsed, uid),
  };
}

function logWriteSummary(result) {
  console.log(
    `[mail-hook] ${result.classification.classification} -> ${result.plannedWrites
      .map((item) => item.table)
      .join(", ")}`,
  );

  if (result.actualWrites?.length > 0) {
    console.log(
      `[mail-hook] lark wrote ${result.actualWrites.map((item) => `${item.table}:${item.recordId}`).join(", ")}`,
    );
  }
}

async function processFetchedMessage(message, context) {
  console.log(`[mail-hook] fetching uid=${message.uid}`);
  const parsed = await context.parseMail(message.source);
  console.log(`[mail-hook] parsed uid=${message.uid} subject=${parsed.subject ?? ""}`);

  const event = toMailEvent(parsed, message.uid);
  const messageId = event.payload.message_id;

  if (context.processedStore.has(messageId)) {
    console.log(`[mail-hook] skip already processed message_id=${messageId}`);
    await markSeen(context.client, message.uid, context.config.markSeenTimeoutMs);
    return null;
  }

  if (context.mailEventExists && (await context.mailEventExists(messageId))) {
    console.log(`[mail-hook] skip message already in base message_id=${messageId}`);
    await context.processedStore.add(messageId);
    await markSeen(context.client, message.uid, context.config.markSeenTimeoutMs);
    return null;
  }

  const result = await context.processEvent(event);
  logWriteSummary(result);

  if (result.writeStatus === "failed") {
    console.error(`[mail-hook] lark write failed ${result.writeError}`);
    return result;
  }

  await context.processedStore.add(messageId);
  console.log(`[mail-hook] remembered processed message_id=${messageId}`);
  await markSeen(context.client, message.uid, context.config.markSeenTimeoutMs);

  return result;
}

function uidKey(uids) {
  return uids.join(",");
}

function shouldSkipUnchangedScan(config, scanState, selectedUids) {
  if (!config.skipUnchanged || !scanState) {
    return false;
  }

  const currentKey = uidKey(selectedUids);

  if (scanState.lastSelectedUidKey === currentKey) {
    console.log("[mail-hook] latest uid set unchanged; skip deep scan");
    return true;
  }

  scanState.pendingSelectedUidKey = currentKey;
  return false;
}

function rememberSuccessfulScan(config, scanState, selectedUids, results) {
  if (!config.skipUnchanged || !scanState) {
    return;
  }

  if (results.some((result) => result.writeStatus === "failed")) {
    console.log("[mail-hook] scan had failed writes; keep uid set retryable");
    return;
  }

  scanState.lastSelectedUidKey = scanState.pendingSelectedUidKey ?? uidKey(selectedUids);
  scanState.pendingSelectedUidKey = "";
  console.log("[mail-hook] remembered latest uid set");
}

export async function pollMailbox(config, options = {}) {
  const client = options.client ?? createClient(config);
  const parseMail = options.parseMail ?? simpleParser;
  const processEvent = options.processEvent ?? processMailEvent;
  const mailEventExists = options.mailEventExists;
  const processedStore = await createProcessedStore(config, options);
  const scanState = options.scanState;
  const mailbox = config.mailbox ?? "INBOX";
  const results = [];

  console.log(`[mail-hook] connecting ${config.host}:${config.port}`);
  await client.connect();
  console.log("[mail-hook] connected");

  console.log(`[mail-hook] opening mailbox ${mailbox}`);
  const lock = await client.getMailboxLock(mailbox);
  console.log(`[mail-hook] mailbox opened ${mailbox}`);

  try {
    const searchQuery = config.includeSeen ? { all: true } : { seen: false };
    console.log(`[mail-hook] searching ${config.includeSeen ? "all recent" : "unread"} mail`);
    const uids = await client.search(searchQuery, { uid: true });
    console.log(`[mail-hook] ${config.includeSeen ? "mailbox" : "unread"} count ${uids.length}`);

    if (uids.length === 0) {
      console.log("[mail-hook] no unread mail");
      return results;
    }

    const selectedUids = uids.slice(-config.maxMessagesPerPoll);
    console.log(`[mail-hook] selected latest ${selectedUids.length} uid(s)`);

    if (shouldSkipUnchangedScan(config, scanState, selectedUids)) {
      return results;
    }

    for await (const message of client.fetch(selectedUids, { uid: true, source: true }, { uid: true })) {
      const result = await processFetchedMessage(message, {
        client,
        config,
        mailEventExists,
        parseMail,
        processEvent,
        processedStore,
      });
      if (result) {
        results.push(result);
      }
    }

    rememberSuccessfulScan(config, scanState, selectedUids, results);
  } finally {
    lock.release();
    console.log(`[mail-hook] mailbox released ${mailbox}`);
    await client.logout();
    console.log("[mail-hook] logged out");
  }

  return results;
}

export function startMailPoller(config, options = {}) {
  if (!config.enabled) {
    return { enabled: false, stop() {}, runOnce: () => Promise.resolve([]) };
  }

  if (!config.user || !config.password) {
    console.error("[mail-hook] disabled: missing IMAP_USER or IMAP_PASSWORD");
    return { enabled: false, stop() {}, runOnce: () => Promise.resolve([]) };
  }

  let running = false;
  const scanState = options.scanState ?? { lastSelectedUidKey: "", pendingSelectedUidKey: "" };
  console.log(
    `[mail-hook] enabled user=${config.user} host=${config.host}:${config.port} mailbox=${config.mailbox} interval=${config.intervalMs}ms`,
  );

  async function runOnce() {
    if (running) {
      return [];
    }

    running = true;
    try {
      console.log("[mail-hook] polling mailbox");
      const results = await withTimeout(pollMailbox(config, { ...options, scanState }), config.pollTimeoutMs, "poll mailbox");
      console.log(`[mail-hook] poll done processed=${results.length}`);
      if (config.stopAfterProcessed && results.some((result) => result.writeStatus !== "failed")) {
        console.log("[mail-hook] stop after processed mail");
        clearInterval(timer);
      }
      return results;
    } catch (error) {
      console.error("[mail-hook] poll failed", describeError(error));
      return [];
    } finally {
      running = false;
    }
  }

  const timer = setInterval(runOnce, config.intervalMs);
  timer.unref?.();

  if (config.pollOnStart) {
    runOnce();
  }

  return {
    enabled: true,
    runOnce,
    stop() {
      clearInterval(timer);
    },
  };
}
