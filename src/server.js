import { readConfig } from "./config.js";
import { createApp } from "./http.js";
import { healthRoute } from "./routes/health.js";
import { webhookRoute } from "./routes/webhook.js";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function buildApp() {
  return createApp([healthRoute(), webhookRoute()]);
}

if (fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const config = readConfig();
  const app = buildApp();

  app.listen(config.port, () => {
    console.log(`headhunter-agent-backend listening on :${config.port}`);
  });
}
