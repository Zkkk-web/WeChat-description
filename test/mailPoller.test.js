import assert from "node:assert/strict";
import { test } from "node:test";
import { pollMailbox } from "../src/hooks/mailPoller.js";

function fakeClient(messages, expectedSearch = { seen: false }) {
  const seen = [];
  let fetchCount = 0;

  return {
    seen,
    get fetchCount() {
      return fetchCount;
    },
    async connect() {},
    async getMailboxLock(mailbox) {
      assert.equal(mailbox, "INBOX");
      return { release() {} };
    },
    async search(query, options) {
      assert.deepEqual(query, expectedSearch);
      assert.deepEqual(options, { uid: true });
      return messages.map((item) => item.uid);
    },
    async *fetch(uids, fields, options) {
      fetchCount += 1;
      assert.deepEqual(fields, { uid: true, source: true });
      assert.deepEqual(options, { uid: true });
      for (const message of messages) {
        if (uids.includes(message.uid)) {
          yield message;
        }
      }
    },
    async messageFlagsAdd(uid, flags, options) {
      assert.deepEqual(flags, ["\\Seen"]);
      assert.deepEqual(options, { uid: true });
      seen.push(uid);
    },
    async logout() {},
  };
}

function fakeProcessedStore(initial = []) {
  const ids = new Set(initial);

  return {
    added: [],
    has(messageId) {
      return ids.has(messageId);
    },
    async add(messageId) {
      ids.add(messageId);
      this.added.push(messageId);
    },
  };
}

function parsedCandidateMail(uid) {
  return {
    messageId: `<mail-${uid}@example.com>`,
    date: new Date("2026-06-26T03:00:00.000Z"),
    from: { value: [{ address: "candidate@example.com", name: "张三" }] },
    subject: "应聘 AI 产品经理 - 张三",
    text: "你好，附件是我的简历。",
    html: "",
    attachments: [{ filename: "张三简历.pdf" }],
  };
}

test("pollMailbox converts unread IMAP messages into mail events", async () => {
  const client = fakeClient([{ uid: 7, source: Buffer.from("raw") }]);
  const results = await pollMailbox(
    {
      host: "imap.163.com",
      port: 993,
      secure: true,
      user: "user@example.com",
      password: "secret",
      mailbox: "INBOX",
      maxMessagesPerPoll: 20,
    },
    {
      client,
      processedStore: fakeProcessedStore(),
      async parseMail() {
        return parsedCandidateMail(7);
      },
    },
  );

  assert.equal(results.length, 1);
  assert.equal(results[0].classification.classification, "candidate_direct");
  assert.deepEqual(
    results[0].plannedWrites.map((item) => item.table),
    ["邮件事件", "候选人"],
  );
  assert.deepEqual(client.seen, [7]);
});

test("pollMailbox can process multiple new unread messages in one poll", async () => {
  const client = fakeClient([
    { uid: 1, source: Buffer.from("first") },
    { uid: 2, source: Buffer.from("second") },
  ]);
  const results = await pollMailbox(
    {
      host: "imap.163.com",
      port: 993,
      secure: true,
      user: "user@example.com",
      password: "secret",
      mailbox: "INBOX",
      maxMessagesPerPoll: 20,
    },
    {
      client,
      processedStore: fakeProcessedStore(),
      async parseMail(source) {
        return parsedCandidateMail(source.toString());
      },
    },
  );

  assert.equal(results.length, 2);
  assert.deepEqual(client.seen, [1, 2]);
});

test("pollMailbox still caps very large unread backlogs", async () => {
  const client = fakeClient([
    { uid: 1, source: Buffer.from("old") },
    { uid: 2, source: Buffer.from("new") },
  ]);
  const results = await pollMailbox(
    {
      host: "imap.163.com",
      port: 993,
      secure: true,
      user: "user@example.com",
      password: "secret",
      mailbox: "INBOX",
      maxMessagesPerPoll: 1,
    },
    {
      client,
      processedStore: fakeProcessedStore(),
      async parseMail() {
        return parsedCandidateMail(2);
      },
    },
  );

  assert.equal(results.length, 1);
  assert.deepEqual(client.seen, [2]);
});

test("pollMailbox keeps mail unread when writeback fails", async () => {
  const client = fakeClient([{ uid: 7, source: Buffer.from("raw") }]);
  const results = await pollMailbox(
    {
      host: "imap.163.com",
      port: 993,
      secure: true,
      user: "user@example.com",
      password: "secret",
      mailbox: "INBOX",
      maxMessagesPerPoll: 1,
    },
    {
      client,
      processedStore: fakeProcessedStore(),
      async parseMail() {
        return parsedCandidateMail(7);
      },
      async processEvent() {
        return {
          classification: { classification: "candidate_direct" },
          plannedWrites: [{ table: "邮件事件" }, { table: "候选人" }],
          actualWrites: [],
          writeStatus: "failed",
          writeError: "write failed",
        };
      },
    },
  );

  assert.equal(results.length, 1);
  assert.equal(results[0].writeStatus, "failed");
  assert.deepEqual(client.seen, []);
});

test("pollMailbox skips messages already remembered as processed", async () => {
  const client = fakeClient([{ uid: 7, source: Buffer.from("raw") }]);
  const processedStore = fakeProcessedStore(["<mail-7@example.com>"]);
  let processCount = 0;
  const results = await pollMailbox(
    {
      host: "imap.163.com",
      port: 993,
      secure: true,
      user: "user@example.com",
      password: "secret",
      mailbox: "INBOX",
      maxMessagesPerPoll: 20,
    },
    {
      client,
      processedStore,
      async parseMail() {
        return parsedCandidateMail(7);
      },
      async processEvent() {
        processCount += 1;
      },
    },
  );

  assert.equal(processCount, 0);
  assert.equal(results.length, 0);
  assert.deepEqual(client.seen, [7]);
  assert.deepEqual(processedStore.added, []);
});

test("pollMailbox remembers successfully processed messages even when mark seen later fails", async () => {
  const client = fakeClient([{ uid: 7, source: Buffer.from("raw") }]);
  client.messageFlagsAdd = async () => {
    throw new Error("imap mark seen timeout");
  };
  const processedStore = fakeProcessedStore();
  const results = await pollMailbox(
    {
      host: "imap.163.com",
      port: 993,
      secure: true,
      user: "user@example.com",
      password: "secret",
      mailbox: "INBOX",
      maxMessagesPerPoll: 20,
      markSeenTimeoutMs: 10,
    },
    {
      client,
      processedStore,
      async parseMail() {
        return parsedCandidateMail(7);
      },
    },
  );

  assert.equal(results.length, 1);
  assert.deepEqual(processedStore.added, ["<mail-7@example.com>"]);
});

test("pollMailbox can scan already-read mail when consistency mode is enabled", async () => {
  const client = fakeClient([{ uid: 7, source: Buffer.from("raw") }], { all: true });
  const results = await pollMailbox(
    {
      host: "imap.163.com",
      port: 993,
      secure: true,
      user: "user@example.com",
      password: "secret",
      mailbox: "INBOX",
      includeSeen: true,
      maxMessagesPerPoll: 20,
    },
    {
      client,
      processedStore: fakeProcessedStore(),
      async parseMail() {
        return parsedCandidateMail(7);
      },
    },
  );

  assert.equal(results.length, 1);
  assert.deepEqual(client.seen, [7]);
});

test("pollMailbox skips mail that already exists in Feishu Base", async () => {
  const client = fakeClient([{ uid: 7, source: Buffer.from("raw") }], { all: true });
  const processedStore = fakeProcessedStore();
  let processCount = 0;
  const results = await pollMailbox(
    {
      host: "imap.163.com",
      port: 993,
      secure: true,
      user: "user@example.com",
      password: "secret",
      mailbox: "INBOX",
      includeSeen: true,
      maxMessagesPerPoll: 20,
    },
    {
      client,
      processedStore,
      async parseMail() {
        return parsedCandidateMail(7);
      },
      async mailEventExists(messageId) {
        assert.equal(messageId, "<mail-7@example.com>");
        return true;
      },
      async processEvent() {
        processCount += 1;
      },
    },
  );

  assert.equal(processCount, 0);
  assert.equal(results.length, 0);
  assert.deepEqual(processedStore.added, ["<mail-7@example.com>"]);
  assert.deepEqual(client.seen, [7]);
});

test("pollMailbox skips deep scan when latest uid set is unchanged", async () => {
  const scanState = { lastSelectedUidKey: "", pendingSelectedUidKey: "" };
  const firstClient = fakeClient([{ uid: 7, source: Buffer.from("raw") }], { all: true });
  const secondClient = fakeClient([{ uid: 7, source: Buffer.from("raw") }], { all: true });
  const config = {
    host: "imap.163.com",
    port: 993,
    secure: true,
    user: "user@example.com",
    password: "secret",
    mailbox: "INBOX",
    includeSeen: true,
    skipUnchanged: true,
    maxMessagesPerPoll: 20,
  };

  const firstResults = await pollMailbox(config, {
    client: firstClient,
    scanState,
    processedStore: fakeProcessedStore(),
    async parseMail() {
      return parsedCandidateMail(7);
    },
  });
  const secondResults = await pollMailbox(config, {
    client: secondClient,
    scanState,
    processedStore: fakeProcessedStore(),
    async parseMail() {
      throw new Error("should not parse unchanged mail");
    },
  });

  assert.equal(firstResults.length, 1);
  assert.equal(secondResults.length, 0);
  assert.equal(firstClient.fetchCount, 1);
  assert.equal(secondClient.fetchCount, 0);
});

test("pollMailbox keeps unchanged uid set retryable after failed writes", async () => {
  const scanState = { lastSelectedUidKey: "", pendingSelectedUidKey: "" };
  const firstClient = fakeClient([{ uid: 7, source: Buffer.from("raw") }], { all: true });
  const secondClient = fakeClient([{ uid: 7, source: Buffer.from("raw") }], { all: true });
  const config = {
    host: "imap.163.com",
    port: 993,
    secure: true,
    user: "user@example.com",
    password: "secret",
    mailbox: "INBOX",
    includeSeen: true,
    skipUnchanged: true,
    maxMessagesPerPoll: 20,
  };

  await pollMailbox(config, {
    client: firstClient,
    scanState,
    processedStore: fakeProcessedStore(),
    async parseMail() {
      return parsedCandidateMail(7);
    },
    async processEvent() {
      return {
        classification: { classification: "candidate_direct" },
        plannedWrites: [{ table: "邮件事件" }],
        actualWrites: [],
        writeStatus: "failed",
        writeError: "write failed",
      };
    },
  });
  const secondResults = await pollMailbox(config, {
    client: secondClient,
    scanState,
    processedStore: fakeProcessedStore(),
    async parseMail() {
      return parsedCandidateMail(7);
    },
  });

  assert.equal(firstClient.fetchCount, 1);
  assert.equal(secondClient.fetchCount, 1);
  assert.equal(secondResults.length, 1);
});
