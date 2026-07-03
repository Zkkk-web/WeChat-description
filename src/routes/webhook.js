import { json, readJson } from "../http.js";
import { buildHermesPrompt } from "../domain/buildHermesPrompt.js";
import { processMailEvent } from "../domain/processMailEvent.js";
import { sendFeishuChatInteractiveCard } from "../integrations/feishuArticlePush.js";
import { enrichFeishuEvent } from "../integrations/larkContent.js";
import { searchWechatAccounts, subscribeWechatAccount } from "../integrations/wechatFeed.js";
import { attachWechatAvatarImageKeys, buildWechatSubscriptionCard } from "./wechatSubscriptions.js";

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
  const query = parseWechatSubscriptionQuery(extractMessageText(event.payload));
  const chatId = event.payload?.message?.chat_id ?? event.payload?.chat_id;
  if (!query || !chatId || !config.wechatArticles?.enabled) return null;

  const candidates = (await searchWechatAccounts(config.wechatArticles, query, { fetch: config.fetch })).slice(0, 5);
  const cardCandidates = await attachWechatAvatarImageKeys(candidates, config);
  const card = buildWechatSubscriptionCard(query, cardCandidates);
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
    query,
    candidates,
    delivery,
  };
}

async function handleWechatSubscriptionCardAction(body, config) {
  const value = body.event?.action?.value ?? body.action?.value;
  if (value?.action !== "wechat_subscribe" || !config.wechatArticles?.enabled) return null;

  const account = {
    fakeid: value.fakeid ?? "",
    nickname: value.nickname ?? "",
    alias: value.alias ?? "",
    headImg: value.headImg ?? value.head_img ?? "",
  };
  if (!account.fakeid) {
    return { ok: false, error: "missing_fakeid" };
  }

  const subscription = await subscribeWechatAccount(config.wechatArticles, account, { fetch: config.fetch });
  return {
    ok: true,
    handled: true,
    type: "wechat_subscription_confirm",
    account,
    subscription,
    toast: {
      type: "success",
      content: `Subscribed: ${account.nickname || account.fakeid}`,
    },
  };
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

function parseWechatSubscriptionQuery(text) {
  const normalized = String(text ?? "").replace(/\s+/g, " ").trim();
  const compact = normalized.replace(/[，。！？、,.!?]/g, "").replace(/\s+/g, "");
  const direct = compact.match(/(?:订阅公众号|搜索公众号|公众号搜索|想订阅公众号|想搜索公众号)(.+)$/u);
  if (direct?.[1]) return stripWechatQuerySuffix(direct[1]);

  const natural = compact.match(/(?:订阅|搜索)(.+?)(?:的)?公众号$/u);
  if (natural?.[1]) return stripWechatQuerySuffix(natural[1]);

  return "";
}

function stripWechatQuerySuffix(query) {
  return String(query ?? "")
    .replace(/^[:：]+/u, "")
    .replace(/(?:的)?公众号$/u, "")
    .trim();
}
