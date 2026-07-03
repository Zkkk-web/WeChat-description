import { json, readJson } from "../http.js";
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

      const subscription = await subscribeWechatAccount(config.wechatArticles, account, { fetch: config.fetch });
      json(res, 200, {
        ok: true,
        query,
        account,
        subscription,
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
      const card = buildWechatSubscriptionCard(query, candidates);
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
      const account = normalizeConfirmAccount(body.action?.value ?? body.event?.action?.value ?? body.account ?? body);
      if (!account.fakeid) {
        json(res, 400, { ok: false, error: "missing_fakeid" });
        return;
      }

      const subscription = await subscribeWechatAccount(config.wechatArticles, account, { fetch: config.fetch });
      json(res, 200, {
        ok: true,
        account,
        subscription,
        toast: {
          type: "success",
          content: `Subscribed: ${account.nickname || account.fakeid}`,
        },
      });
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

export function buildWechatSubscriptionCard(query, candidates) {
  const accounts = Array.isArray(candidates) ? candidates : [];
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: `WeChat search: ${query}` },
      template: accounts.length ? "blue" : "grey",
    },
    elements: accounts.length
      ? accounts.flatMap((account, index) => accountCardElements(account, index < accounts.length - 1))
      : [
          {
            tag: "markdown",
            content: "No matching public account found.",
          },
        ],
  };
}

function accountCardElements(account, withDivider) {
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
          value: subscriptionButtonValue(account),
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
  const lines = [`**${escapeMarkdown(account.nickname || account.fakeid || "Unknown")}**`];
  if (account.alias) lines.push(`微信号：${escapeMarkdown(account.alias)}`);
  return lines.join("\n");
}

function subscriptionButtonValue(account) {
  return {
    action: "wechat_subscribe",
    fakeid: account.fakeid,
    nickname: account.nickname,
    alias: account.alias,
    headImg: account.headImg,
  };
}

export async function attachWechatAvatarImageKeys(candidates, config) {
  return Array.isArray(candidates) ? candidates : [];
}

function normalizeConfirmAccount(input) {
  return {
    fakeid: input.fakeid ?? "",
    nickname: input.nickname ?? "",
    alias: input.alias ?? "",
    headImg: input.headImg ?? input.head_img ?? "",
  };
}

function escapeMarkdown(value) {
  return String(value ?? "").replace(/([\\`*_{}\[\]()#+\-.!|>])/g, "\\$1");
}
