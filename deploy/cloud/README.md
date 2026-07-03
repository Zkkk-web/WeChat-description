# Cloud deployment

This package turns the public-account pusher into one cloud container.

It runs two processes:

- `vendor/wechat-download-api`: public management UI and WeChat article/RSS data.
- `headhunter-agent-backend`: background poller that pushes new articles to Feishu.

Only the WeChat UI is exposed. The backend talks to it through `127.0.0.1`.

## Required cloud settings

Set the environment variables from `deploy/cloud/env.example`.

Use one Feishu push mode:

- `FEISHU_ARTICLE_WEBHOOK_URL`: easiest, uses a group robot webhook.
- `LARK_APP_ID` + `LARK_APP_SECRET` + `FEISHU_ARTICLE_CHAT_ID`: product mode,
  where the Feishu app sends messages directly to the target group.

Do not use local `lark-cli` in cloud. A cloud container does not have the user's
local Feishu login.

Mount persistent storage at `/data`. Without `/data`, the service can still run,
but login cookies, subscriptions, and push state may disappear after restart.

## Platform notes

- Railway: import the GitHub repo; `railway.json` uses the root `Dockerfile` and
  `/api/health`.
- Render: import the GitHub repo; `render.yaml` uses Docker and `/api/health`.
- Any Docker host: build the root `Dockerfile`, expose `$PORT` or `5000`, and
  mount persistent storage at `/data`.

## Runtime flow

1. Open the public URL.
2. Scan the WeChat login QR code.
3. Add public accounts on `/rss.html`.
4. The backend polls every `WECHAT_ARTICLE_POLL_INTERVAL_MS`.
5. New articles are sent to the Feishu group webhook.

## Do not bake secrets

Do not copy local `.env`, `.env.local`, or `wechat-download-api/data` into the
image. They are excluded by `.dockerignore`; cloud secrets belong in the
platform environment-variable panel.
