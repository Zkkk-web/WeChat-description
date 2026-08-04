export async function enrichArticleWithSummary(article, config = {}, deps = {}) {
  const summary = await summarizeArticle(article, config, deps);
  return summary ? { ...article, aiSummary: summary } : article;
}

export async function summarizeArticle(article, config = {}, deps = {}) {
  const ai = config.aiSummary ?? {};
  if (!ai.enabled) return "";
  if (!ai.apiBase || !ai.apiKey || !ai.model) return "";

  const content = await resolveArticleContent(article, config, deps);
  const prompt = buildSummaryPrompt(article, content, ai.maxInputChars);
  if (!prompt) return "";

  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ai.timeoutMs ?? 30000);

  try {
    const response = await fetchImpl(chatCompletionsUrl(ai.apiBase), {
      method: "POST",
      headers: {
        authorization: `Bearer ${ai.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: ai.model,
        temperature: 0.2,
        messages: [
          {
            role: "system",
            content: "你是公众号文章情报摘要器。只输出中文要点，短、准、可转发，不编造原文没有的信息。",
          },
          { role: "user", content: prompt },
        ],
      }),
      signal: controller.signal,
    });

    const body = await readJson(response);
    if (!response.ok) {
      throw new Error(`article summary api failed: ${response.status} ${JSON.stringify(body)}`);
    }

    return cleanSummary(body?.choices?.[0]?.message?.content ?? "");
  } finally {
    clearTimeout(timeout);
  }
}

async function resolveArticleContent(article, config, deps) {
  if (article.plainContent) return article.plainContent;
  if (article.content) return stripHtml(article.content);
  if (!article.link || !config.apiBase) return fallbackArticleText(article);

  try {
    const fetchImpl = deps.fetch ?? globalThis.fetch;
    const response = await fetchImpl(new URL("/api/article", config.apiBase), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: article.link }),
    });
    const body = await readJson(response);
    if (!response.ok || body?.success === false) return fallbackArticleText(article);
    return body?.data?.plain_content || stripHtml(body?.data?.content ?? "") || fallbackArticleText(article);
  } catch (error) {
    console.warn("wechat article content fetch failed; using digest fallback", error);
    return fallbackArticleText(article);
  }
}

function buildSummaryPrompt(article, content, maxInputChars = 6000) {
  const source = truncate(String(content ?? "").trim(), maxInputChars);
  const title = String(article.title ?? "").trim();
  const digest = String(article.digest ?? "").trim();
  const input = [
    title ? `标题：${title}` : "",
    digest ? `简介：${digest}` : "",
    source ? `正文：\n${source}` : "",
  ].filter(Boolean).join("\n\n");

  if (!input) return "";
  return `${input}\n\n请总结这篇文章的重点，输出 3 条以内。每条不超过 35 个中文字符。`;
}

function fallbackArticleText(article) {
  return [article.title, article.digest].filter(Boolean).join("\n");
}

function cleanSummary(value) {
  return String(value ?? "")
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 5)
    .join("\n");
}

function chatCompletionsUrl(apiBase) {
  const base = String(apiBase ?? "").replace(/\/+$/, "");
  if (base.endsWith("/chat/completions")) return base;
  if (base.endsWith("/v1")) return `${base}/chat/completions`;
  return `${base}/v1/chat/completions`;
}

async function readJson(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function stripHtml(value) {
  return String(value ?? "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function truncate(value, maxChars) {
  const limit = Number.isFinite(Number(maxChars)) ? Number(maxChars) : 6000;
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n[content truncated]`;
}
