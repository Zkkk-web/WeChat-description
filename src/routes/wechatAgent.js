import { timingSafeEqual } from "node:crypto";
import { json, readJson } from "../http.js";
import {
  addWechatSubscription,
  listWechatSubscriptions,
  removeWechatSubscription,
} from "../domain/wechatSubscriptionStore.js";
import { searchWechatAccounts, subscribeWechatAccount } from "../integrations/wechatFeed.js";

export function wechatAgentRoute(config = {}) {
  return {
    method: "POST",
    path: "/agent/wechat-subscriptions",
    async handler(req, res) {
      const articleConfig = config.wechatArticles;
      if (!articleConfig?.enabled) {
        json(res, 409, { ok: false, error: "wechat_article_poll_disabled" });
        return;
      }
      if (!articleConfig.agentApiToken) {
        json(res, 503, { ok: false, error: "agent_api_not_configured" });
        return;
      }
      if (!hasValidBearerToken(req.headers.authorization, articleConfig.agentApiToken)) {
        json(res, 401, { ok: false, error: "unauthorized" });
        return;
      }

      const body = await readJson(req);
      const chatId = resolveChatId(body, articleConfig.feishuChatId);
      if (!chatId) {
        json(res, 400, { ok: false, error: "missing_chat_id" });
        return;
      }
      if (articleConfig.feishuChatId && chatId !== articleConfig.feishuChatId) {
        json(res, 403, { ok: false, error: "chat_not_allowed" });
        return;
      }

      const result = await executeWechatAgentOperation(body, articleConfig, chatId, config);
      json(res, result.status, result.body);
    },
  };
}

async function executeWechatAgentOperation(input, articleConfig, chatId, config) {
  const operation = String(input.operation ?? "").trim().toLowerCase();
  const handlers = {
    list: () => listSubscriptions(articleConfig, chatId),
    search: () => searchSubscriptions(input, articleConfig, chatId, config),
    add: () => addSubscription(input, articleConfig, chatId, config),
    remove: () => removeSubscription(input, articleConfig, chatId),
  };
  return handlers[operation]?.() ?? result(400, { ok: false, error: "unsupported_operation" });
}

async function listSubscriptions(articleConfig, chatId) {
  const subscriptions = await listWechatSubscriptions(articleConfig, { chatId });
  return result(200, {
    ok: true,
    operation: "list",
    chat_id: chatId,
    subscriptions,
    subscriptions_count: subscriptions.length,
  });
}

async function searchSubscriptions(input, articleConfig, chatId, config) {
  const query = accountQuery(input);
  if (!query) return result(400, { ok: false, error: "missing_account_name" });

  const limit = Math.max(1, Math.min(Number.parseInt(String(input.limit ?? "5"), 10) || 5, 10));
  const candidates = (
    await searchWechatAccounts(articleConfig, query, { fetch: config.fetch })
  ).slice(0, limit);
  return result(200, {
    ok: true,
    operation: "search",
    chat_id: chatId,
    query,
    candidates,
    candidates_count: candidates.length,
    requires_confirmation: candidates.length > 0,
  });
}

async function addSubscription(input, articleConfig, chatId, config) {
  const account = normalizeAccount(input.account ?? input);
  if (!account.fakeid) {
    return result(400, { ok: false, error: "missing_fakeid", hint: "search before add" });
  }

  const subscription = await subscribeWechatAccount(articleConfig, account, { fetch: config.fetch });
  const localSubscription = await addWechatSubscription(articleConfig, account, { chatId });
  const subscriptions = await listWechatSubscriptions(articleConfig, { chatId });
  return result(200, {
    ok: true,
    operation: "add",
    chat_id: chatId,
    account: localSubscription,
    upstream: subscription,
    subscriptions_count: subscriptions.length,
  });
}

async function removeSubscription(input, articleConfig, chatId) {
  const query = accountQuery(input);
  if (!query) return result(400, { ok: false, error: "missing_account_name" });

  const subscriptions = await listWechatSubscriptions(articleConfig, { chatId });
  const matches = subscriptions.filter((account) => accountMatches(account, query));
  if (matches.length !== 1) {
    return result(matches.length ? 409 : 404, {
      ok: false,
      operation: "remove",
      error: matches.length ? "ambiguous_subscription" : "subscription_not_found",
      candidates: matches,
    });
  }

  const account = matches[0];
  const removed = await removeWechatSubscription(articleConfig, account.fakeid, { chatId });
  const remaining = await listWechatSubscriptions(articleConfig, { chatId });
  return result(200, {
    ok: true,
    operation: "remove",
    chat_id: chatId,
    account,
    removed,
    subscriptions_count: remaining.length,
  });
}

function resolveChatId(input, configuredChatId) {
  return String(input.chat_id ?? input.chatId ?? configuredChatId ?? "").trim();
}

function accountQuery(input) {
  return String(input.account_name ?? input.accountName ?? input.query ?? input.name ?? "").trim();
}

function normalizeAccount(input) {
  return {
    fakeid: String(input.fakeid ?? "").trim(),
    nickname: String(input.nickname ?? input.account_name ?? input.accountName ?? "").trim(),
    alias: String(input.alias ?? "").trim(),
    description: String(input.description ?? input.signature ?? input.desc ?? "").trim(),
    headImg: "",
  };
}

function accountMatches(account, query) {
  const target = normalizeName(query);
  return [account.fakeid, account.nickname, account.alias].some((value) => normalizeName(value) === target);
}

function normalizeName(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "");
}

function hasValidBearerToken(header, expectedToken) {
  const prefix = "Bearer ";
  if (typeof header !== "string" || !header.startsWith(prefix)) return false;

  const actual = Buffer.from(header.slice(prefix.length));
  const expected = Buffer.from(expectedToken);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function result(status, body) {
  return { status, body };
}
