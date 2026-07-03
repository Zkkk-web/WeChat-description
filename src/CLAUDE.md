# src architecture

## WeChat article push

```text
wechat-download-api
  -> integrations/wechatFeed.js
  -> hooks/wechatArticlePoller.js
  -> integrations/feishuArticlePush.js
  -> Feishu webhook or Feishu chat

routes/wechatArticles.js
  -> manual compensation poll

routes/wechatSubscriptions.js
  -> search card and click-confirm subscription by public-account name

../scripts/wechatIntelEventBridge.js
  -> lark-cli event consume
  -> routes/webhook.js
  -> subscription search card
```

- `integrations/wechatFeed.js`: reads article feeds and login status from `tmwgsicp/wechat-download-api`, then normalizes both shapes.
- `hooks/wechatArticlePoller.js`: owns the durable watermark, dedupe state, and login reminder state; it advances article state only after a successful push.
- `integrations/feishuWebhook.js`: builds configurable push text and sends webhook messages.
- `integrations/feishuArticlePush.js`: chooses webhook, Feishu app OpenAPI, or local `lark-cli` chat push; app OpenAPI is the cloud path because it does not depend on a user's local CLI login.
- `routes/wechatArticles.js`: exposes `POST /wechat/articles/poll` for manual compensation; it does not parse articles or build Feishu payloads.
- `routes/wechatSubscriptions.js`: exposes `POST /wechat/subscriptions` for one-shot subscribe, `POST /wechat/subscriptions/search` for selectable result cards with visible avatars, and `POST /wechat/subscriptions/confirm` for button-confirmed subscribe.
- `routes/webhook.js`: recognizes chat commands like `订阅公众号 <name>` / `搜索公众号 <name>` and natural phrases like `我想订阅公众号泛函`, sends a selectable card, and handles card button callbacks.
- `server.js`: wires the route and starts the background poller when `WECHAT_ARTICLE_POLL_ENABLED=true`.
- `../scripts/wechatArticleDoctor.js`: checks the whole WeChat article chain; it only triggers compensation poll when `WECHAT_DOCTOR_RUN_POLL=true`.
- `../scripts/wechatIntelEventBridge.js`: keeps the Feishu bot message listener alive and forwards `im.message.receive_v1` events into `/webhook`.

First run does not push historical articles unless `WECHAT_PUSH_EXISTING_ON_FIRST_RUN=true`.
Use `WECHAT_ARTICLE_ACCOUNT_NAMES=fakeid:name` when the upstream service returns a broken nickname such as `??`.
Use `WECHAT_ARTICLE_PUSH_FIELDS=account,title,digest,link` to control notification fields.
Login reminders are enabled by default; set `WECHAT_LOGIN_REMINDER_ENABLED=false` to disable or adjust `WECHAT_LOGIN_REMINDER_THRESHOLD_HOURS`.
Subscribed accounts are read dynamically by default; set `WECHAT_ARTICLE_DYNAMIC_SUBSCRIPTIONS=false` to only use configured fakeids.
