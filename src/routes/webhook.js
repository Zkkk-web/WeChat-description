import { json, readJson } from "../http.js";
import { buildHermesPrompt } from "../domain/buildHermesPrompt.js";
import { processMailEvent } from "../domain/processMailEvent.js";
import {
  addWechatSubscription,
  listWechatSubscriptions,
  removeWechatSubscription,
} from "../domain/wechatSubscriptionStore.js";
import { sendFeishuChatInteractiveCard, sendFeishuChatText } from "../integrations/feishuArticlePush.js";
import { enrichFeishuEvent } from "../integrations/larkContent.js";
import { searchWechatAccounts, subscribeWechatAccount } from "../integrations/wechatFeed.js";
import { buildWechatSubscriptionCard } from "./wechatSubscriptions.js";

function normalizeEvent(body) {
  if (body.header?.event_type) {
    return {
      source: "feishu",
      type: body.header.event_type,
      receivedAt: new Date().toISOString(),
      eventId: body.header.event_id ?? "",
      payload: body.event ?? {},
      header: body.header,
    };
  }

  return {
    source: body.source ?? "unknown",
    type: body.type ?? "unknown",
    receivedAt: new Date().toISOString(),
    payload: body.payload ?? body,
  };
}

function isLocalMailEvent(event) {
  return event.type === "mail.received" || event.type === "email.received";
}

export function webhookRoute(config = {}) {
  return {
    method: "POST",
    path: "/webhook",
    async handler(req, res) {
      const body = await readJson(req);
      if (body.challenge) {
        json(res, 200, { challenge: body.challenge });
        return;
      }

      const event = normalizeEvent(body);
      const cardAction = await handleWechatSubscriptionCardAction(body, config);
      if (cardAction) {
        json(res, 200, cardAction);
        return;
      }

      const chatCommand = await handleWechatSubscriptionChatCommand(event, config);
      if (chatCommand) {
        json(res, 200, chatCommand);
        return;
      }

      const simulation = isLocalMailEvent(event) ? await processMailEvent(event, { larkBase: config.larkBase }) : null;
      const enrichment = await enrichFeishuEvent(event, config.larkContent, { fetch: config.fetch });
      const hermesPrompt = buildHermesPrompt(event, simulation, enrichment);

      json(res, 202, {
        ok: true,
        accepted: true,
        event,
        simulation,
        enrichment,
        hermesPrompt,
      });
    },
  };
}

async function handleWechatSubscriptionChatCommand(event, config) {
  const command = parseWechatSubscriptionCommand(extractMessageText(event.payload));
  const chatId = event.payload?.message?.chat_id ?? event.payload?.chat_id;
  if (!command || !chatId || !config.wechatArticles?.enabled) return null;
  if (!isAllowedWechatChat(chatId, config.wechatArticles.feishuChatId)) {
    return { ok: false, handled: true, type: "wechat_subscription_rejected", error: "chat_not_allowed" };
  }

  const handlers = {
    search: handleWechatSubscriptionSearch,
    list: handleWechatSubscriptionList,
    remove: handleWechatSubscriptionRemove,
  };
  return handlers[command.operation](command, chatId, config);
}

async function handleWechatSubscriptionSearch(command, chatId, config) {
  const candidates = (
    await searchWechatAccounts(config.wechatArticles, command.accountName, { fetch: config.fetch })
  ).slice(0, 5);
  const card = buildWechatSubscriptionCard(command.accountName, candidates, { chatId });
  const delivery = await sendFeishuChatInteractiveCard(
    {
      ...config.wechatArticles,
      feishuChatId: chatId,
    },
    card,
    { execFile: config.execFile },
  );

  return {
    ok: true,
    handled: true,
    type: "wechat_subscription_search",
    query: command.accountName,
    candidates,
    delivery,
  };
}

async function handleWechatSubscriptionList(_command, chatId, config) {
  const subscriptions = await listWechatSubscriptions(config.wechatArticles, { chatId });
  const text = subscriptions.length
    ? `本群当前订阅 ${subscriptions.length} 个公众号：${subscriptions.map(subscriptionName).join("、")}。`
    : "本群当前没有公众号订阅。";
  const delivery = await sendWechatChatFeedback(config, chatId, text);

  return {
    ok: true,
    handled: true,
    type: "wechat_subscription_list",
    subscriptions,
    subscriptionsCount: subscriptions.length,
    delivery,
  };
}

async function handleWechatSubscriptionRemove(command, chatId, config) {
  const subscriptions = await listWechatSubscriptions(config.wechatArticles, { chatId });
  const matches = subscriptions.filter((item) => accountMatches(item, command.accountName));
  if (matches.length !== 1) {
    const text = matches.length
      ? `无法取消：名称「${command.accountName}」对应多个公众号，请使用准确名称或微信号。`
      : `本群没有订阅公众号「${command.accountName}」。`;
    const delivery = await sendWechatChatFeedback(config, chatId, text);
    return {
      ok: false,
      handled: true,
      type: "wechat_subscription_remove",
      error: matches.length ? "ambiguous_subscription" : "subscription_not_found",
      candidates: matches,
      delivery,
    };
  }

  const account = matches[0];
  const removed = await removeWechatSubscription(config.wechatArticles, account.fakeid, { chatId });
  const remaining = await listWechatSubscriptions(config.wechatArticles, { chatId });
  const delivery = await sendWechatChatFeedback(
    config,
    chatId,
    `已取消公众号「${subscriptionName(account)}」的推送。本群当前还订阅 ${remaining.length} 个公众号。`,
  );
  return {
    ok: true,
    handled: true,
    type: "wechat_subscription_remove",
    account,
    removed,
    subscriptionsCount: remaining.length,
    delivery,
  };
}

async function handleWechatSubscriptionCardAction(body, config) {
  const value = extractCardActionValue(body);
  if (value?.action !== "wechat_subscribe" || !config.wechatArticles?.enabled) return null;

  const account = {
    fakeid: value.fakeid ?? "",
    nickname: value.nickname ?? "",
    alias: value.alias ?? "",
    description: value.description ?? value.signature ?? value.desc ?? "",
    headImg: "",
  };
  if (!account.fakeid) {
    return { ok: false, error: "missing_fakeid" };
  }

  const chatId = value.chatId || extractCardActionChatId(body) || config.wechatArticles.feishuChatId;
  if (!isAllowedWechatChat(chatId, config.wechatArticles.feishuChatId)) {
    return { ok: false, handled: true, error: "chat_not_allowed" };
  }
  const subscription = await subscribeWechatAccount(config.wechatArticles, account, { fetch: config.fetch });
  const localSubscription = await addWechatSubscription(config.wechatArticles, account, { chatId });
  const feedback = await sendWechatSubscriptionFeedback(config, account, chatId);
  return {
    ok: true,
    handled: true,
    type: "wechat_subscription_confirm",
    account,
    subscription,
    localSubscription,
    feedback,
    toast: {
      type: "success",
      content: `Subscribed: ${account.nickname || account.fakeid}. Future articles will be pushed here.`,
    },
  };
}

function extractCardActionValue(body) {
  const raw = body.event?.action?.value ?? body.action?.value ?? body.action_value;
  if (typeof raw !== "string") return raw ?? {};

  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function extractCardActionChatId(body) {
  return body.chat_id || body.event?.context?.open_chat_id || body.event?.message?.chat_id || body.event?.chat_id || "";
}

async function sendWechatSubscriptionFeedback(config, account, chatId) {
  if (!chatId) return null;

  const name = account.nickname || account.alias || account.fakeid || "该公众号";
  return sendWechatChatFeedback(config, chatId, `已成功订阅公众号「${name}」。后续新文章会推送到本群。`);
}

async function sendWechatChatFeedback(config, chatId, text) {
  return sendFeishuChatText(
    {
      ...config.wechatArticles,
      feishuChatId: chatId,
    },
    text,
    { execFile: config.execFile, fetch: config.fetch },
  );
}

function extractMessageText(payload) {
  const raw = payload?.message?.content ?? payload?.content;
  if (!raw) return "";

  try {
    const content = typeof raw === "string" ? JSON.parse(raw) : raw;
    return String(content.text ?? "");
  } catch {
    return String(raw);
  }
}

function parseWechatSubscriptionCommand(text) {
  const normalized = stripLeadingMentions(String(text ?? "").replace(/\s+/g, " ").trim());
  const compact = normalized.replace(/[，。！？、,.!?]/g, "").replace(/\s+/g, "");
  if (isWechatSubscriptionListCommand(compact)) return { operation: "list" };

  const removal = parseWechatSubscriptionRemoval(compact);
  if (removal) return { operation: "remove", accountName: removal };

  const direct = compact.match(/(?:订阅公众号|搜索公众号|公众号搜索|想订阅公众号|想搜索公众号)(.+)$/u);
  if (direct?.[1]) return { operation: "search", accountName: stripWechatQuerySuffix(direct[1]) };

  const natural = compact.match(/(?:订阅|搜索)(.+?)(?:的)?公众号$/u);
  if (natural?.[1]) return { operation: "search", accountName: stripWechatQuerySuffix(natural[1]) };

  return null;
}

function isWechatSubscriptionListCommand(text) {
  return (
    /^(?:(?:查看|查询|列出|显示)(?:当前|本群|现在)?(?:的)?)?公众号订阅(?:列表|清单)?$/u.test(text) ||
    /^(?:本群|现在|当前)?订阅了哪些公众号$/u.test(text)
  );
}

function parseWechatSubscriptionRemoval(text) {
  const direct = text.match(/(?:取消订阅公众号|取消公众号)(.+?)(?:的订阅)?$/u);
  if (direct?.[1]) return stripWechatQuerySuffix(direct[1]);

  const push = text.match(/(?:停止|取消|关闭)(.+?)(?:公众号)?(?:的)?(?:文章)?推送$/u);
  if (push?.[1]) return stripWechatQuerySuffix(push[1]);

  return "";
}

function stripLeadingMentions(text) {
  return text.replace(/^(?:@[\p{L}\p{N}_-]+\s*)+/u, "").trim();
}

function stripWechatQuerySuffix(query) {
  return String(query ?? "")
    .replace(/^[:：]+/u, "")
    .replace(/(?:的)?公众号$/u, "")
    .trim();
}

function accountMatches(account, query) {
  const target = normalizeAccountName(query);
  return [account.fakeid, account.nickname, account.alias].some((value) => normalizeAccountName(value) === target);
}

function normalizeAccountName(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "");
}

function subscriptionName(account) {
  return account.nickname || account.alias || account.fakeid || "未命名公众号";
}

function isAllowedWechatChat(chatId, configuredChatId) {
  return !configuredChatId || chatId === configuredChatId;
}
