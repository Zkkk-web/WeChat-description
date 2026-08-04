# src architecture

## WeChat article push

```text
wechat-download-api
  -> integrations/wechatFeed.js
  -> domain/wechatSubscriptionStore.js
  -> hooks/wechatArticlePoller.js
  -> integrations/feishuArticlePush.js
  -> Feishu webhook or Feishu chat

routes/wechatArticles.js
  -> manual compensation poll

routes/wechatSubscriptions.js
  -> search card, group-scoped subscribe, list, and delete

routes/wechatAgent.js
  -> authenticated direct tool API for the active Feishu agent

../scripts/wechatIntelEventBridge.js
  -> legacy lark-cli event consume during migration only
  -> routes/webhook.js
```

- `integrations/wechatFeed.js`: reads article feeds and login status from `tmwgsicp/wechat-download-api`, then normalizes both shapes.
- `integrations/articleSummary.js`: optionally fetches full article text and adds an AI summary before push; disabled unless explicitly configured.
- `domain/wechatSubscriptionStore.js`: stores the business subscription truth by Feishu chat; upstream RSS subscriptions are crawler plumbing, not product state.
- `hooks/wechatArticlePoller.js`: owns the durable watermark, dedupe state, and login reminder state; group-scoped subscriptions use `chat_id:fakeid` state so each group receives only its own accounts.
- `integrations/feishuWebhook.js`: builds configurable push text and sends webhook messages.
- `integrations/feishuArticlePush.js`: chooses webhook, Feishu app OpenAPI, or local `lark-cli` chat push; app OpenAPI is the cloud path because it does not depend on a user's local CLI login.
- `routes/wechatArticles.js`: exposes `POST /wechat/articles/poll` for manual compensation; it does not parse articles or build Feishu payloads.
- `routes/wechatSubscriptions.js`: exposes one-shot subscribe, selectable search cards, button-confirmed subscribe, plus `GET` and `DELETE /wechat/subscriptions` for local group subscription management.
- `routes/wechatAgent.js`: exposes authenticated `list`, `search`, `add`, and exact `remove` operations for an external agent; it never sends a proxy reply and rejects cross-group requests.
- `routes/webhook.js`: recognizes group-scoped list/search/remove commands, sends selectable cards, handles card button subscription, and posts explicit results back to the source chat.
- `server.js`: wires the routes and starts the background poller when `WECHAT_ARTICLE_POLL_ENABLED=true`.
- `../scripts/wechatArticleDoctor.js`: checks the whole WeChat article chain; it only triggers compensation poll when `WECHAT_DOCTOR_RUN_POLL=true`.
- `../scripts/wechatIntelEventBridge.js`: temporarily keeps the legacy Feishu bot listeners alive during migration; disable it after the target agent calls `routes/wechatAgent.js` directly.

First run does not push historical articles unless `WECHAT_PUSH_EXISTING_ON_FIRST_RUN=true`.
Use `WECHAT_ARTICLE_ACCOUNT_NAMES=fakeid:name` when the upstream service returns a broken nickname such as `??`.
Use `WECHAT_ARTICLE_PUSH_FIELDS=account,title,digest,link` to control notification fields.
Set `WECHAT_ARTICLE_AI_SUMMARY_ENABLED=true` plus `WECHAT_ARTICLE_AI_BASE_URL`, `WECHAT_ARTICLE_AI_API_KEY`, and `WECHAT_ARTICLE_AI_MODEL` to add article key-point summaries.
Login reminders are enabled by default; set `WECHAT_LOGIN_REMINDER_ENABLED=false` to disable or adjust `WECHAT_LOGIN_REMINDER_THRESHOLD_HOURS`.
Group-scoped local subscriptions are preferred by default and saved at `WECHAT_SUBSCRIPTION_STATE_PATH`.
`POST /agent/wechat-subscriptions` remains disabled until `WECHAT_AGENT_API_TOKEN` is set.
Set `WECHAT_ARTICLE_LOCAL_SUBSCRIPTIONS=false` only for raw upstream RSS debugging.
When no local subscription exists, dynamic upstream RSS subscriptions remain a fallback; set `WECHAT_ARTICLE_DYNAMIC_SUBSCRIPTIONS=false` to only use configured fakeids.
