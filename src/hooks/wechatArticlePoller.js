import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { sendArticlePush } from "../integrations/feishuArticlePush.js";
import { buildArticlePushText } from "../integrations/feishuWebhook.js";
import { fetchWechatArticles, fetchWechatLoginStatus, fetchWechatSubscriptions } from "../integrations/wechatFeed.js";

export async function pollWechatArticles(config, deps = {}) {
  const store = deps.stateStore ?? fileStateStore(config.statePath);
  const state = await store.load();
  await tryWechatLoginReminder(config, state, store, deps);

  const subscriptions = await resolveWechatSubscriptions(config, deps);
  const fakeids = subscriptions.map((item) => item.fakeid).filter(Boolean);
  const accountNames = {
    ...(config.accountNames ?? {}),
    ...Object.fromEntries(subscriptions.map((item) => [item.fakeid, item.nickname]).filter(([key, value]) => key && value)),
  };
  const resolvedConfig = { ...config, accountNames };

  if (fakeids.length > 1) {
    return pollWechatArticleAccounts(resolvedConfig, fakeids, state, store, deps);
  }

  return pollWechatArticleAccount({ ...resolvedConfig, fakeid: fakeids[0] ?? config.fakeid ?? "" }, state, store, deps);
}

export async function tryWechatLoginReminder(config, state, store, deps = {}) {
  if (config.loginReminderEnabled === false) return;
  if (!hasPushTarget(config)) return;

  let status;
  try {
    status = await fetchWechatLoginStatus({ apiBase: config.apiBase }, { fetch: deps.fetch });
  } catch (error) {
    console.warn("wechat login reminder check failed", error);
    return;
  }

  const reminder = buildWechatLoginReminder(status, config);
  if (!reminder || state.loginReminderKey === reminder.key) return;

  await sendArticlePush(config, reminder.text, { execFile: deps.execFile, fetch: deps.fetch });
  state.loginReminderKey = reminder.key;
  await store.save(trimRootState({ ...state, loginReminderKey: reminder.key }));
}

export function buildWechatLoginReminder(status, config = {}) {
  if (status.authenticated === false) {
    return {
      key: `expired:${dateKey(Date.now())}`,
      text: "微信公众号后台登录已失效，请重新扫码登录，否则公众号更新无法继续抓取。",
    };
  }
  if (status.authenticated !== true) return null;

  const expireTime = Number(status.expireTime ?? 0);
  if (!Number.isFinite(expireTime) || expireTime <= 0) return null;

  const thresholdMs = (config.loginReminderThresholdHours ?? 12) * 3_600_000;
  const msLeft = expireTime - Date.now();
  if (msLeft > thresholdMs) return null;

  const account = status.account ? `「${status.account}」` : "公众号后台";
  return {
    key: `expiring:${expireTime}`,
    text: `${account}登录态即将过期，剩余约 ${formatTimeLeft(msLeft)}。请提前重新扫码登录，避免公众号更新中断。`,
  };
}

async function pollWechatArticleAccounts(config, fakeids, state, store, deps) {
  const nextState = {
    initialized: true,
    loginReminderKey: state.loginReminderKey,
    accounts: { ...(state.accounts ?? {}) },
  };
  const results = [];

  for (const fakeid of fakeids) {
    const accountStore = {
      async load() {
        return nextState.accounts[fakeid] ?? {};
      },
      async save(accountState) {
        nextState.accounts[fakeid] = trimState(accountState);
        await store.save(trimAccountsState(nextState));
      },
    };
    const result = await pollWechatArticleAccount({ ...config, fakeid }, nextState.accounts[fakeid] ?? {}, accountStore, deps);
    results.push({ fakeid, ...result });
  }

  return {
    checked: results.reduce((sum, item) => sum + item.checked, 0),
    pushed: results.reduce((sum, item) => sum + item.pushed, 0),
    skippedInitial: results.reduce((sum, item) => sum + item.skippedInitial, 0),
    accounts: results,
  };
}

async function pollWechatArticleAccount(config, initialState, store, deps) {
  const state = initialState ?? (await store.load());
  const firstRun = !state.initialized;
  const since = state.since ?? 0;
  const pushed = new Set(state.pushedKeys ?? []);

  const feed = await fetchWechatArticles(
    {
      apiBase: config.apiBase,
      fakeid: config.fakeid,
      limit: config.limit,
      since,
    },
    { fetch: deps.fetch },
  );

  const articles = feed.articles
    .filter((article) => article.publishTime > since)
    .sort((a, b) => a.publishTime - b.publishTime);

  if (firstRun && !config.pushExistingOnFirstRun) {
    const nextSince = maxPublishTime(articles, feed.nextSince, since);
    await store.save(trimState({ initialized: true, since: nextSince, pushedKeys: [], loginReminderKey: state.loginReminderKey }));
    return { checked: articles.length, pushed: 0, skippedInitial: articles.length, since: nextSince };
  }

  const pushedArticles = [];
  let nextSince = since;
  for (const article of articles) {
    const key = articleKey(article);
    nextSince = Math.max(nextSince, article.publishTime);
    if (pushed.has(key)) continue;

    const text = buildArticlePushText(article, config);
    await sendArticlePush(config, text, { execFile: deps.execFile, fetch: deps.fetch });
    pushed.add(key);
    pushedArticles.push(article);
    await store.save(trimState({ initialized: true, since: nextSince, pushedKeys: [...pushed], loginReminderKey: state.loginReminderKey }));
  }

  if (articles.length === 0 || pushedArticles.length === 0) {
    nextSince = maxPublishTime(articles, feed.nextSince, since);
    await store.save(trimState({ initialized: true, since: nextSince, pushedKeys: [...pushed], loginReminderKey: state.loginReminderKey }));
  }

  return {
    checked: articles.length,
    pushed: pushedArticles.length,
    skippedInitial: 0,
    since: nextSince,
    articles: pushedArticles,
  };
}

export function startWechatArticlePoller(config, deps = {}) {
  let stopped = false;
  let running = false;
  let timer;

  async function runOnce() {
    if (stopped || running) return;
    running = true;
    try {
      const result = await pollWechatArticles(config, deps);
      console.log(
        `wechat article poll checked=${result.checked} pushed=${result.pushed}${pollLogSuffix(result)}`,
      );
      if (config.stopAfterPoll) {
        stopped = true;
        clearInterval(timer);
      }
    } catch (error) {
      console.error("wechat article poll failed", error);
    } finally {
      running = false;
    }
  }

  timer = setInterval(runOnce, config.intervalMs);
  if (config.pollOnStart) {
    void runOnce();
  }

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
    runOnce,
  };
}

export function articleKey(article) {
  return String(article.id || `${article.fakeid}:${article.link}:${article.publishTime}:${article.title}`);
}

export function fileStateStore(path) {
  return {
    async load() {
      try {
        return JSON.parse(await readFile(path, "utf8"));
      } catch (error) {
        if (error?.code === "ENOENT") return {};
        throw error;
      }
    },
    async save(state) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    },
  };
}

function maxPublishTime(articles, nextSince, fallback) {
  return Math.max(fallback, nextSince, ...articles.map((article) => article.publishTime));
}

function trimState(state) {
  return {
    initialized: true,
    since: state.since ?? 0,
    pushedKeys: (state.pushedKeys ?? []).slice(-1000),
    ...(state.loginReminderKey ? { loginReminderKey: state.loginReminderKey } : {}),
  };
}

function trimAccountsState(state) {
  return {
    initialized: true,
    ...(state.loginReminderKey ? { loginReminderKey: state.loginReminderKey } : {}),
    accounts: Object.fromEntries(
      Object.entries(state.accounts ?? {}).map(([fakeid, accountState]) => [fakeid, trimState(accountState)]),
    ),
  };
}

function trimRootState(state) {
  if (state.accounts) return trimAccountsState(state);
  return trimState(state);
}

function accountFakeids(config) {
  const fakeids = Array.isArray(config.fakeids) ? config.fakeids.filter(Boolean) : [];
  if (fakeids.length > 0) return [...new Set(fakeids)];
  return [config.fakeid ?? ""];
}

async function resolveWechatSubscriptions(config, deps = {}) {
  const configuredFakeids = accountFakeids(config).filter(Boolean);
  if (configuredFakeids.length > 0 && config.useDynamicSubscriptions !== true) {
    return configuredFakeids.map((fakeid) => ({
      fakeid,
      nickname: config.accountNames?.[fakeid] ?? "",
    }));
  }

  const subscriptions = await fetchWechatSubscriptions({ apiBase: config.apiBase }, { fetch: deps.fetch });
  if (subscriptions.length > 0) return uniqueSubscriptions(subscriptions);

  return configuredFakeids.map((fakeid) => ({
    fakeid,
    nickname: config.accountNames?.[fakeid] ?? "",
  }));
}

function uniqueSubscriptions(subscriptions) {
  const seen = new Set();
  return subscriptions.filter((item) => {
    if (!item.fakeid || seen.has(item.fakeid)) return false;
    seen.add(item.fakeid);
    return true;
  });
}

function hasPushTarget(config) {
  return Boolean(config.feishuWebhookUrl || config.feishuChatId);
}

function dateKey(value) {
  return new Date(value).toISOString().slice(0, 10);
}

function formatTimeLeft(ms) {
  if (ms <= 0) return "已过期";
  const hours = ms / 3_600_000;
  if (hours >= 24) return `${(hours / 24).toFixed(1)} 天`;
  return `${Math.max(1, Math.ceil(hours))} 小时`;
}

function pollLogSuffix(result) {
  if (result.since !== undefined) return ` since=${result.since}`;
  if (Array.isArray(result.accounts)) return ` accounts=${result.accounts.length}`;
  return "";
}
