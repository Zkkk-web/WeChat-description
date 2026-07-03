export async function fetchWechatArticles(config, deps = {}) {
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const url = new URL("/api/feed/articles.json", config.apiBase);
  url.searchParams.set("since", String(config.since ?? 0));
  url.searchParams.set("limit", String(config.limit ?? 20));
  if (config.fakeid) {
    url.searchParams.set("fakeid", config.fakeid);
  }

  const response = await fetchImpl(url);
  if (!response.ok) {
    throw new Error(`wechat feed request failed: ${response.status}`);
  }

  const body = await response.json();
  const articles = Array.isArray(body.articles) ? body.articles.map(normalizeArticle) : [];
  return {
    articles,
    nextSince: numberOr(body.next_since, config.since ?? 0),
  };
}

export async function fetchWechatSubscriptions(config, deps = {}) {
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const response = await fetchImpl(new URL("/api/rss/subscriptions", config.apiBase));
  if (!response.ok) {
    throw new Error(`wechat subscriptions request failed: ${response.status}`);
  }

  const body = await response.json();
  return Array.isArray(body.data) ? body.data.map(normalizeSubscription) : [];
}

export async function searchWechatAccounts(config, query, deps = {}) {
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const url = new URL("/api/public/searchbiz", config.apiBase);
  url.searchParams.set("query", query);

  const response = await fetchImpl(url);
  if (!response.ok) {
    throw new Error(`wechat account search failed: ${response.status}`);
  }

  const body = await response.json();
  if (body.success === false) {
    throw new Error(body.error || "wechat account search failed");
  }

  return Array.isArray(body.data?.list) ? body.data.list.map(normalizeSearchAccount) : [];
}

export async function subscribeWechatAccount(config, account, deps = {}) {
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const response = await fetchImpl(new URL("/api/rss/subscribe", config.apiBase), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      fakeid: account.fakeid,
      nickname: account.nickname,
      alias: account.alias,
      head_img: account.headImg,
    }),
  });

  if (!response.ok) {
    throw new Error(`wechat account subscribe failed: ${response.status}`);
  }

  return response.json();
}

export async function fetchWechatLoginStatus(config, deps = {}) {
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const response = await fetchImpl(new URL("/api/admin/status", config.apiBase));
  if (!response.ok) {
    throw new Error(`wechat login status request failed: ${response.status}`);
  }

  return normalizeLoginStatus(await response.json());
}

export function normalizeSubscription(input) {
  return {
    fakeid: input.fakeid ?? "",
    nickname: input.nickname ?? "",
    alias: input.alias ?? "",
    headImg: input.head_img ?? "",
  };
}

export function normalizeSearchAccount(input) {
  return {
    fakeid: input.fakeid ?? "",
    nickname: input.nickname ?? "",
    alias: input.alias ?? "",
    headImg: input.round_head_img ?? input.head_img ?? "",
  };
}

export function normalizeArticle(input) {
  return {
    id: input.id ?? "",
    fakeid: input.fakeid ?? "",
    nickname: input.nickname ?? "",
    title: input.title ?? "",
    digest: input.digest ?? "",
    author: input.author ?? "",
    publishTime: numberOr(input.publish_time, 0),
    link: input.link ?? "",
    cover: input.cover ?? "",
    contentFetched: Boolean(input.content_fetched),
  };
}

export function normalizeLoginStatus(input) {
  return {
    authenticated: input.authenticated === true ? true : input.authenticated === false ? false : undefined,
    account: input.nickname || input.account || "",
    expireTime: numberOr(input.expireTime ?? input.expire_time, 0),
  };
}

function numberOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}
