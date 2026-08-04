export async function sendFeishuText(webhookUrl, text, deps = {}) {
  if (!webhookUrl) {
    throw new Error("missing Feishu webhook URL");
  }

  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const response = await fetchImpl(webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      msg_type: "text",
      content: { text },
    }),
  });

  const bodyText = await response.text();
  let body = {};
  try {
    body = bodyText ? JSON.parse(bodyText) : {};
  } catch {
    body = { raw: bodyText };
  }

  if (!response.ok || isWebhookError(body)) {
    throw new Error(`Feishu webhook failed: ${response.status} ${bodyText}`);
  }

  return body;
}

export function buildArticlePushText(article, config = {}) {
  const prefix = config.titlePrefix ?? "WeChat article update";
  const account =
    config.accountNames?.[article.fakeid] ||
    cleanAccountName(article.nickname) ||
    article.fakeid ||
    "Unknown account";
  const defaultFields = config.aiSummary?.enabled
    ? ["account", "title", "digest", "summary", "link"]
    : ["account", "title", "digest", "link"];
  const fields = config.pushFields?.length ? config.pushFields : defaultFields;
  const lines = fields.map((field) => articlePushLine(field, { article, account, prefix }));
  return lines.filter(Boolean).join("\n");
}

function articlePushLine(field, { article, account, prefix }) {
  if (field === "account") return `[${prefix}] ${account}`;
  if (field === "title" && article.title) return `Title: ${article.title}`;
  if (field === "digest" && article.digest) return `Digest: ${article.digest}`;
  if (field === "summary" && article.aiSummary) return `Summary:\n${article.aiSummary}`;
  if (field === "author" && article.author) return `Author: ${article.author}`;
  if (field === "published" && article.publishTime) return `Published: ${formatPublishTime(article.publishTime)}`;
  if (field === "link" && article.link) return `Link: ${article.link}`;
  if (field === "fakeid" && article.fakeid) return `FakeID: ${article.fakeid}`;
  return "";
}

function cleanAccountName(value) {
  const text = String(value ?? "").trim();
  if (!text || /^[?\s]+$/.test(text)) return "";
  return text;
}

function formatPublishTime(value) {
  const ms = Number(value) * 1000;
  if (!Number.isFinite(ms) || ms <= 0) return "";
  return new Date(ms).toISOString().slice(0, 10);
}

function isWebhookError(body) {
  if (!body || typeof body !== "object") return false;
  if (body.StatusCode !== undefined) return body.StatusCode !== 0;
  if (body.code !== undefined) return body.code !== 0;
  return false;
}
