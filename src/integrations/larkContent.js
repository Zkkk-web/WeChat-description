function trimSlash(value) {
  return value.replace(/\/+$/, "");
}

function requireAccessToken(config) {
  if (!config?.enabled || !config.accessToken) {
    return "";
  }

  return config.accessToken;
}

async function readJson(response) {
  const text = await response.text();

  if (!text) {
    return {};
  }

  return JSON.parse(text);
}

async function requestJson(fetchImpl, url, options) {
  const response = await fetchImpl(url, options);
  const body = await readJson(response);

  if (!response.ok || body.code !== 0) {
    const message = body.msg ?? body.message ?? response.statusText;
    throw new Error(`lark content api failed ${body.code ?? response.status}: ${message}`);
  }

  return body;
}

async function requestText(fetchImpl, url, options) {
  const response = await fetchImpl(url, options);
  const text = await response.text();

  if (!response.ok) {
    throw new Error(`lark content api failed ${response.status}: ${text || response.statusText}`);
  }

  return text;
}

function base64UrlDecode(value) {
  if (!value) {
    return "";
  }

  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");

  return Buffer.from(padded, "base64").toString("utf8");
}

function authHeaders(token) {
  return {
    authorization: `Bearer ${token}`,
  };
}

export async function fetchFeishuMailMessage(config, event, options = {}) {
  const token = requireAccessToken(config);
  if (!token) {
    return null;
  }

  const fetchImpl = options.fetch ?? globalThis.fetch;
  const apiBase = trimSlash(config.apiBase ?? "https://open.feishu.cn/open-apis");
  const mailbox = event.payload.mail_address;
  const messageId = event.payload.message_id;

  if (!mailbox || !messageId) {
    throw new Error("missing feishu mail_address or message_id");
  }

  const url = `${apiBase}/mail/v1/user_mailboxes/${encodeURIComponent(mailbox)}/messages/${encodeURIComponent(messageId)}?format=plain_text_full`;
  const body = await requestJson(fetchImpl, url, {
    method: "GET",
    headers: authHeaders(token),
  });
  const message = body.data?.message ?? {};

  return {
    kind: "feishu_mail",
    messageId: message.message_id ?? messageId,
    subject: message.subject ?? "",
    fromEmail: message.head_from?.mail_address ?? "",
    fromName: message.head_from?.name ?? "",
    bodyPlainText: base64UrlDecode(message.body_plain_text ?? message.body_preview ?? ""),
    attachments: (message.attachments ?? []).map((item) => ({
      id: item.id ?? "",
      filename: item.filename ?? "",
      type: item.attachment_type ?? 0,
    })),
  };
}

export async function fetchFeishuMinuteTranscript(config, event, options = {}) {
  const token = requireAccessToken(config);
  if (!token) {
    return null;
  }

  const fetchImpl = options.fetch ?? globalThis.fetch;
  const apiBase = trimSlash(config.apiBase ?? "https://open.feishu.cn/open-apis");
  const minuteToken = event.payload.minute_token;

  if (!minuteToken) {
    throw new Error("missing feishu minute_token");
  }

  const minuteUrl = `${apiBase}/minutes/v1/minutes/${encodeURIComponent(minuteToken)}`;
  const transcriptUrl = `${apiBase}/minutes/v1/minutes/${encodeURIComponent(minuteToken)}/transcript?need_speaker=true&need_timestamp=true&file_format=txt`;
  const [minuteBody, transcript] = await Promise.all([
    requestJson(fetchImpl, minuteUrl, {
      method: "GET",
      headers: authHeaders(token),
    }),
    requestText(fetchImpl, transcriptUrl, {
      method: "GET",
      headers: authHeaders(token),
    }),
  ]);

  const minute = minuteBody.data?.minute ?? {};

  return {
    kind: "feishu_minute",
    minuteToken,
    title: minute.title ?? "",
    url: minute.url ?? "",
    noteId: minute.note_id ?? "",
    duration: minute.duration ?? "",
    transcript,
  };
}

export async function enrichFeishuEvent(event, config, options = {}) {
  if (event.type === "mail.user_mailbox.event.message_received_v1") {
    return fetchFeishuMailMessage(config, event, options);
  }

  if (event.type === "minutes.minute.generated_v1") {
    return fetchFeishuMinuteTranscript(config, event, options);
  }

  return null;
}
