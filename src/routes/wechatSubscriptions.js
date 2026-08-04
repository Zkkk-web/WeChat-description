import { json, readJson } from "../http.js";
import { addWechatSubscription, listWechatSubscriptions, removeWechatSubscription } from "../domain/wechatSubscriptionStore.js";
import { sendFeishuChatInteractiveCard } from "../integrations/feishuArticlePush.js";
import { searchWechatAccounts, subscribeWechatAccount } from "../integrations/wechatFeed.js";

export function wechatSubscriptionsRoute(config = {}) {
  return {
    method: "POST",
    path: "/wechat/subscriptions",
    async handler(req, res) {
      if (!config.wechatArticles?.enabled) {
        json(res, 409, { ok: false, error: "wechat_article_poll_disabled" });
        return;
      }

      const body = await readJson(req);
      const query = String(body.query ?? body.name ?? "").trim();
      if (!query) {
        json(res, 400, { ok: false, error: "missing_query" });
        return;
      }

      const candidates = await searchWechatAccounts(config.wechatArticles, query, { fetch: config.fetch });
      const account = pickWechatAccount(query, candidates);
      if (!account) {
        json(res, 404, { ok: false, error: "account_not_found", query, candidates: [] });
        return;
      }

      const chatId = String(body.chatId ?? body.chat_id ?? config.wechatArticles.feishuChatId ?? "").trim();
      const subscription = await subscribeWechatAccount(config.wechatArticles, account, { fetch: config.fetch });
      const localSubscription = await addWechatSubscription(config.wechatArticles, account, { chatId });
      json(res, 200, {
        ok: true,
        query,
        account,
        subscription,
        localSubscription,
        message: `Subscribed WeChat account: ${account.nickname || account.fakeid}`,
      });
    },
  };
}

export function wechatSubscriptionSearchRoute(config = {}) {
  return {
    method: "POST",
    path: "/wechat/subscriptions/search",
    async handler(req, res) {
      if (!config.wechatArticles?.enabled) {
        json(res, 409, { ok: false, error: "wechat_article_poll_disabled" });
        return;
      }

      const body = await readJson(req);
      const query = String(body.query ?? body.name ?? "").trim();
      if (!query) {
        json(res, 400, { ok: false, error: "missing_query" });
        return;
      }

      const limit = Math.max(1, Math.min(Number.parseInt(String(body.limit ?? "5"), 10) || 5, 10));
      const candidates = (await searchWechatAccounts(config.wechatArticles, query, { fetch: config.fetch })).slice(0, limit);
      const chatId = String(body.chatId ?? body.chat_id ?? config.wechatArticles.feishuChatId ?? "").trim();
      const card = buildWechatSubscriptionCard(query, candidates, { chatId });
      const delivery =
        body.sendCard === true && config.wechatArticles.feishuChatId
          ? await sendFeishuChatInteractiveCard(config.wechatArticles, card, {
              execFile: config.execFile,
            })
          : null;

      json(res, 200, {
        ok: true,
        query,
        candidates,
        card,
        delivery,
      });
    },
  };
}

export function wechatSubscriptionConfirmRoute(config = {}) {
  return {
    method: "POST",
    path: "/wechat/subscriptions/confirm",
    async handler(req, res) {
      if (!config.wechatArticles?.enabled) {
        json(res, 409, { ok: false, error: "wechat_article_poll_disabled" });
        return;
      }

      const body = await readJson(req);
      const action = parseActionValue(body.action?.value ?? body.event?.action?.value ?? body.account ?? body);
      const account = normalizeConfirmAccount(action);
      if (!account.fakeid) {
        json(res, 400, { ok: false, error: "missing_fakeid" });
        return;
      }

      const chatId = resolveActionChatId(action, body, config.wechatArticles);
      const subscription = await subscribeWechatAccount(config.wechatArticles, account, { fetch: config.fetch });
      const localSubscription = await addWechatSubscription(config.wechatArticles, account, { chatId });
      json(res, 200, {
        ok: true,
        account,
        subscription,
        localSubscription,
        toast: {
          type: "success",
          content: `Subscribed: ${account.nickname || account.fakeid}. Future articles will be pushed here.`,
        },
      });
    },
  };
}

export function wechatSubscriptionListRoute(config = {}) {
  return {
    method: "GET",
    path: "/wechat/subscriptions",
    async handler(req, res) {
      if (!config.wechatArticles?.enabled) {
        json(res, 409, { ok: false, error: "wechat_article_poll_disabled" });
        return;
      }

      const url = new URL(req.url ?? "/", "http://localhost");
      const chatId = url.searchParams.get("chat_id") ?? config.wechatArticles.feishuChatId;
      const subscriptions = await listWechatSubscriptions(config.wechatArticles, { chatId });
      json(res, 200, { ok: true, subscriptions });
    },
  };
}

export function wechatSubscriptionDeleteRoute(config = {}) {
  return {
    method: "DELETE",
    path: "/wechat/subscriptions",
    async handler(req, res) {
      if (!config.wechatArticles?.enabled) {
        json(res, 409, { ok: false, error: "wechat_article_poll_disabled" });
        return;
      }

      const url = new URL(req.url ?? "/", "http://localhost");
      const fakeid = String(url.searchParams.get("fakeid") ?? "").trim();
      const chatId = url.searchParams.get("chat_id") ?? config.wechatArticles.feishuChatId;
      if (!fakeid) {
        json(res, 400, { ok: false, error: "missing_fakeid" });
        return;
      }

      const removed = await removeWechatSubscription(config.wechatArticles, fakeid, { chatId });
      json(res, 200, { ok: true, fakeid, removed });
    },
  };
}

export function pickWechatAccount(query, candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  const normalizedQuery = normalizeMatchText(query);
  return (
    candidates.find((item) => normalizeMatchText(item.nickname) === normalizedQuery) ||
    candidates.find((item) => normalizeMatchText(item.alias) === normalizedQuery) ||
    candidates[0]
  );
}

function normalizeMatchText(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "");
}

export function buildWechatSubscriptionCard(query, candidates, options = {}) {
  const accounts = Array.isArray(candidates) ? candidates : [];
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: `WeChat search: ${query}` },
      template: accounts.length ? "blue" : "grey",
    },
    elements: accounts.length
      ? accounts.flatMap((account, index) => accountCardElements(account, index < accounts.length - 1, options))
      : [
          {
            tag: "markdown",
            content: "No matching public account found.",
          },
        ],
  };
}

function accountCardElements(account, withDivider, options = {}) {
  const columns = [
    {
      tag: "column",
      width: "weighted",
      weight: 1,
      elements: [
        {
          tag: "markdown",
          content: accountSummary(account),
        },
      ],
    },
    {
      tag: "column",
      width: "auto",
      elements: [
        {
          tag: "button",
          text: { tag: "plain_text", content: "订阅" },
          type: "primary",
          value: subscriptionButtonValue(account, options),
        },
      ],
    },
  ];

  const elements = [
    {
      tag: "column_set",
      flex_mode: "flow",
      background_style: "default",
      horizontal_spacing: "small",
      columns,
    },
  ];
  if (withDivider) {
    elements.push({ tag: "hr" });
  }

  return elements;
}

function accountSummary(account) {
  const lines = [`**${escapeMarkdown(account.nickname || "未命名公众号")}**`];
  if (account.alias) lines.push(`微信号：${escapeMarkdown(account.alias)}`);
  lines.push(`简介：${escapeMarkdown(account.description || "接口未返回")}`);
  return lines.join("\n");
}

function subscriptionButtonValue(account, options = {}) {
  return {
    action: "wechat_subscribe",
    fakeid: account.fakeid,
    nickname: account.nickname,
    alias: account.alias,
    description: account.description,
    chatId: options.chatId ?? "",
  };
}

function normalizeConfirmAccount(input) {
  return {
    fakeid: input.fakeid ?? "",
    nickname: input.nickname ?? "",
    alias: input.alias ?? "",
    description: input.description ?? input.signature ?? input.desc ?? "",
    headImg: input.headImg ?? input.head_img ?? "",
  };
}

function parseActionValue(value) {
  if (typeof value !== "string") return value ?? {};

  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function escapeMarkdown(value) {
  return String(value ?? "").replace(/([\\`*_{}\[\]()#+\-.!|>])/g, "\\$1");
}

function resolveActionChatId(action, body, config) {
  return normalizeChatId(
    action.chatId ||
      action.chat_id ||
      body.chat_id ||
      body.event?.context?.open_chat_id ||
      body.event?.message?.chat_id ||
      body.event?.chat_id ||
      config.feishuChatId,
  );
}

function normalizeChatId(value) {
  return String(value ?? "").trim();
}
