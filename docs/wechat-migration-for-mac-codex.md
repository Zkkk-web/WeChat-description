# WeChat Push Migration for Mac Codex

This repository already contains the WeChat public-account push code.
This document tells a fresh Codex session on macOS how to restore the
full migration state without guessing.

## What is already in GitHub

The following source files are part of the committed project and should
be present after cloning the repository:

- `package.json`
- `README.md`
- `CLAUDE.md`
- `src/CLAUDE.md`
- `src/config.js`
- `src/server.js`
- `src/hooks/wechatArticlePoller.js`
- `src/domain/wechatSubscriptionStore.js`
- `src/integrations/articleSummary.js`
- `src/integrations/feishuArticlePush.js`
- `src/integrations/feishuWebhook.js`
- `src/integrations/wechatFeed.js`
- `src/routes/webhook.js`
- `src/routes/wechatAgent.js`
- `src/routes/wechatSubscriptions.js`
- `src/routes/wechatArticles.js`
- `scripts/wechatArticleWatchdog.js`
- `scripts/wechatArticleDoctor.js`
- `scripts/wechatIntelEventBridge.js`
- `scripts/startWechatPublicPortal.ps1`
- `test/webhook.test.js`
- `test/wechatArticlePoller.test.js`

These files are the codebase. They are enough to run the application
logic, but not enough to resume the current production-like state.

## What must also be migrated

The runtime state is split from source. Copy the following state and
configuration artifacts when moving to a new machine:

- `.env.local`
- `.codex-tmp/wechat-subscriptions.json`
- `.codex-tmp/wechat-article-real-state.json`
- `.codex-tmp/wechat-download-api/` data directory
- any local log or diagnostic files only if you need to debug history

Do not copy secrets into GitHub. Keep the secret values local or restore
them from your password manager / secure vault on the Mac.

## Current WeChat coverage snapshot

The live local state on the Windows machine contains 9 group-scoped
WeChat accounts in the article push waterline and 8 visible group
subscriptions in the local subscription store.

Current observed group-scoped account keys:

- `Mzg2OTA1OTAxNA==`
- `MzIyMzA5NjEyMA==`
- `MzkwMzY5NzU2Nw==`
- `MzkzNDQxOTU2MQ==`
- `MTMwNDMwODQ0MQ==`
- `MzIyNjM2MzQyNg==`
- `MzU0NDk4OTk2Mg==`
- `MzU0MDk3NTUxMA==`
- `MjM5NDkyNTUzOA==`

Current visible subscription store keys:

- `Mzg2OTA1OTAxNA==`
- `MzIyMzA5NjEyMA==`
- `MzkwMzY5NzU2Nw==`
- `MzkzNDQxOTU2MQ==`
- `MTMwNDMwODQ0MQ==`
- `MzIyNjM2MzQyNg==`
- `MzU0NDk4OTk2Mg==`
- `MzU0MDk3NTUxMA==`

If a Mac restore does not see these keys, the migration is incomplete.

## Required environment variables

Restore the following variables on the Mac. Keep the values secret.

```env
WECHAT_ARTICLE_POLL_ENABLED=true
WECHAT_DOWNLOAD_API_BASE=http://127.0.0.1:5000
WECHAT_ARTICLE_STATE_PATH=.codex-tmp/wechat-article-real-state.json
WECHAT_ARTICLE_FAKEIDS=<comma-separated fakeid list>
WECHAT_ARTICLE_ACCOUNT_NAMES=<fakeid:name pairs>
WECHAT_PUSH_EXISTING_ON_FIRST_RUN=false
FEISHU_ARTICLE_CHAT_ID=<target chat id>
WECHAT_ARTICLE_LARK_CLI_PROFILE=<profile name>
WECHAT_ARTICLE_LARK_CLI_AS=bot
WECHAT_ARTICLE_PUSH_FIELDS=account,title,digest,link
WECHAT_LOGIN_REMINDER_ENABLED=true
WECHAT_LOGIN_REMINDER_THRESHOLD_HOURS=12
WECHAT_ARTICLE_DYNAMIC_SUBSCRIPTIONS=true
WECHAT_SUBSCRIPTION_STATE_PATH=.codex-tmp/wechat-subscriptions.json
WECHAT_AGENT_API_TOKEN=<token if agent API is used>
```

If the Mac session uses the same public-account set as the Windows
machine, the `WECHAT_ARTICLE_FAKEIDS` value should include all 9
observed fakeids above.

## Restore order on macOS

1. Clone `Zkkk-web/WeChat-description`.
2. Copy `.env.local` from the secure source, not from GitHub.
3. Copy `.codex-tmp/wechat-subscriptions.json`.
4. Copy `.codex-tmp/wechat-article-real-state.json`.
5. Restore the local `wechat-download-api` data directory.
6. Start `wechat-download-api`.
7. Run `npm run wechat:watchdog`.
8. If the watchdog reports success, verify `checked`, `pushed`, and
   `subscriptions`.

## What success looks like

The Mac Codex session should be able to:

- read the source from GitHub
- load the local state files
- connect to `wechat-download-api`
- see all configured fakeids
- run the watchdog without inventing any missing values

## What Codex should not do

- Do not echo secret values from `.env.local`.
- Do not assume a single WeChat account.
- Do not reset local state unless a migration step explicitly requires
  it.
- Do not treat a clean clone as a complete runtime migration.

