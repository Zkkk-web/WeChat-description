import { readConfig } from "./config.js";
import { loadEnvFile } from "./env.js";
import { createApp } from "./http.js";
import { processMailEvent } from "./domain/processMailEvent.js";
import { healthRoute } from "./routes/health.js";
import { startMailPoller } from "./hooks/mailPoller.js";
import { startWechatArticlePoller } from "./hooks/wechatArticlePoller.js";
import { mailEventExists } from "./integrations/larkBase.js";
import { webhookRoute } from "./routes/webhook.js";
import { wechatArticlesRoute } from "./routes/wechatArticles.js";
import { wechatAgentRoute } from "./routes/wechatAgent.js";
import {
  wechatSubscriptionDeleteRoute,
  wechatSubscriptionConfirmRoute,
  wechatSubscriptionListRoute,
  wechatSubscriptionSearchRoute,
  wechatSubscriptionsRoute,
} from "./routes/wechatSubscriptions.js";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function buildApp(config = {}) {
  return createApp([
    healthRoute(),
    webhookRoute(config),
    wechatArticlesRoute(config),
    wechatAgentRoute(config),
    wechatSubscriptionListRoute(config),
    wechatSubscriptionsRoute(config),
    wechatSubscriptionSearchRoute(config),
    wechatSubscriptionConfirmRoute(config),
    wechatSubscriptionDeleteRoute(config),
  ]);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  loadEnvFile();
  const config = readConfig();
  const app = buildApp(config);

  app.listen(config.port, () => {
    console.log(`headhunter-agent-backend listening on :${config.port}`);
  });

  if (config.mail.enabled) {
    startMailPoller(config.mail, {
      mailEventExists(messageId) {
        return mailEventExists(config.larkBase, messageId);
      },
      processEvent(event) {
        return processMailEvent(event, { larkBase: config.larkBase });
      },
    });
  }

  if (config.wechatArticles.enabled) {
    startWechatArticlePoller(config.wechatArticles, { fetch: config.fetch });
  }
}
