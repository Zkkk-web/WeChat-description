import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { buildApp } from "../src/server.js";
import { readConfig } from "../src/config.js";
import { buildArticlePushText } from "../src/integrations/feishuWebhook.js";
import { fetchWechatArticles } from "../src/integrations/wechatFeed.js";
import { buildWechatLoginReminder, pollWechatArticles } from "../src/hooks/wechatArticlePoller.js";

function memoryState(initial = {}) {
  let state = initial;
  const saves = [];

  return {
    saves,
    get state() {
      return state;
    },
    async load() {
      return state;
    },
    async save(next) {
      state = next;
      saves.push(next);
    },
  };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function article(overrides = {}) {
  return {
    id: "msg-1",
    fakeid: "fakeid-1",
    nickname: "Account",
    title: "New article",
    digest: "Short digest",
    author: "Author",
    publish_time: 100,
    link: "https://mp.weixin.qq.com/s/example",
    cover: "",
    content_fetched: false,
    ...overrides,
  };
}

test("fetchWechatArticles reads the wechat-download-api feed endpoint", async () => {
  const calls = [];
  const result = await fetchWechatArticles(
    {
      apiBase: "http://wechat.test",
      fakeid: "fakeid-1",
      since: 90,
      limit: 2,
    },
    {
      fetch: async (url) => {
        calls.push(String(url));
        return jsonResponse({ articles: [article()], next_since: 100 });
      },
    },
  );

  assert.equal(calls[0], "http://wechat.test/api/feed/articles.json?since=90&limit=2&fakeid=fakeid-1");
  assert.equal(result.nextSince, 100);
  assert.equal(result.articles[0].publishTime, 100);
  assert.equal(result.articles[0].title, "New article");
});

test("readConfig parses multiple WeChat account fakeids", () => {
  const config = readConfig({
    WECHAT_ARTICLE_FAKEIDS: "fakeid-1, fakeid-2, fakeid-1",
    WECHAT_ARTICLE_ACCOUNT_NAMES: "fakeid-1:娉涘嚱,fakeid-2:瀹濈帀",
  });

  assert.deepEqual(config.wechatArticles.fakeids, ["fakeid-1", "fakeid-2", "fakeid-1"]);
  assert.deepEqual(config.wechatArticles.accountNames, { "fakeid-1": "娉涘嚱", "fakeid-2": "瀹濈帀" });
});

test("first run records the watermark without pushing old articles by default", async () => {
  const store = memoryState();
  const posts = [];

  const result = await pollWechatArticles(
    {
      apiBase: "http://wechat.test",
      fakeid: "fakeid-1",
      limit: 20,
      pushExistingOnFirstRun: false,
      feishuWebhookUrl: "https://open.feishu.cn/webhook/test",
    },
    {
      stateStore: store,
      fetch: async (_url, init) => {
        if (init) posts.push(init);
        return jsonResponse({
          articles: [article({ id: "old-1", publish_time: 100 }), article({ id: "old-2", publish_time: 200 })],
          next_since: 200,
        });
      },
    },
  );

  assert.equal(result.checked, 2);
  assert.equal(result.pushed, 0);
  assert.equal(result.skippedInitial, 2);
  assert.equal(posts.length, 0);
  assert.equal(store.state.initialized, true);
  assert.equal(store.state.since, 200);
});

test("initialized poll pushes new articles to Feishu webhook and saves dedupe state", async () => {
  const store = memoryState({ initialized: true, since: 90, pushedKeys: [] });
  const posts = [];

  const result = await pollWechatArticles(
    {
      apiBase: "http://wechat.test",
      fakeid: "fakeid-1",
      limit: 20,
      titlePrefix: "WX",
      feishuWebhookUrl: "https://open.feishu.cn/webhook/test",
    },
    {
      stateStore: store,
      fetch: async (url, init) => {
        if (String(url).startsWith("https://open.feishu.cn/webhook")) {
          posts.push(JSON.parse(init.body));
          return jsonResponse({ code: 0 });
        }

        return jsonResponse({ articles: [article({ id: "new-1", publish_time: 100 })], next_since: 100 });
      },
    },
  );

  assert.equal(result.pushed, 1);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].msg_type, "text");
  assert.match(posts[0].content.text, /\[WX\] Account/);
  assert.match(posts[0].content.text, /Title: New article/);
  assert.deepEqual(store.state.pushedKeys, ["new-1"]);
  assert.equal(store.state.since, 100);
});

test("initialized poll can push new articles directly to a Feishu chat", async () => {
  const store = memoryState({ initialized: true, since: 90, pushedKeys: [] });
  const commands = [];

  const result = await pollWechatArticles(
    {
      apiBase: "http://wechat.test",
      fakeid: "fakeid-1",
      limit: 20,
      titlePrefix: "WX",
      feishuChatId: "oc_topic",
      larkCliCommand: "lark-cli.cmd",
      larkCliAs: "user",
    },
    {
      stateStore: store,
      execFile: async (command, args) => {
        commands.push({ command, args });
        return {
          stdout: JSON.stringify({ ok: true, data: { message_id: "om_1" } }),
        };
      },
      fetch: async () => jsonResponse({ articles: [article({ id: "chat-1", publish_time: 100 })], next_since: 100 }),
    },
  );

  assert.equal(result.pushed, 1);
  assert.equal(commands.length, 1);
  const commandText = [commands[0].command, ...commands[0].args].join(" ");
  assert.match(commandText, /im/);
  assert.match(commandText, /\+messages-send/);
  assert.match(commandText, /oc_topic/);
  assert.deepEqual(store.state.pushedKeys, ["chat-1"]);
});

test("readConfig can target a Feishu chat without webhook", () => {
  const config = readConfig({
    FEISHU_ARTICLE_CHAT_ID: "oc_topic",
    LARK_CLI_COMMAND: "lark-cli.cmd",
    LARK_CLI_AS: "user",
  });

  assert.equal(config.wechatArticles.feishuChatId, "oc_topic");
  assert.equal(config.wechatArticles.larkCliCommand, "lark-cli.cmd");
  assert.equal(config.wechatArticles.larkCliAs, "user");
});

test("readConfig parses WeChat push fields and login reminder options", () => {
  const config = readConfig({
    WECHAT_ARTICLE_PUSH_FIELDS: "account,title,author,link",
    WECHAT_LOGIN_REMINDER_ENABLED: "false",
    WECHAT_LOGIN_REMINDER_THRESHOLD_HOURS: "6",
    WECHAT_ARTICLE_DYNAMIC_SUBSCRIPTIONS: "false",
  });

  assert.deepEqual(config.wechatArticles.pushFields, ["account", "title", "author", "link"]);
  assert.equal(config.wechatArticles.loginReminderEnabled, false);
  assert.equal(config.wechatArticles.loginReminderThresholdHours, 6);
  assert.equal(config.wechatArticles.useDynamicSubscriptions, false);
});

test("readConfig keeps AI summaries disabled unless explicitly configured", () => {
  const disabled = readConfig({});
  assert.equal(disabled.wechatArticles.aiSummary.enabled, false);
  assert.equal(disabled.wechatArticles.aiSummary.apiKey, "");

  const enabled = readConfig({
    WECHAT_ARTICLE_AI_SUMMARY_ENABLED: "true",
    WECHAT_ARTICLE_AI_BASE_URL: "https://ai.example/v1/",
    WECHAT_ARTICLE_AI_API_KEY: "secret",
    WECHAT_ARTICLE_AI_MODEL: "mini",
  });

  assert.equal(enabled.wechatArticles.aiSummary.enabled, true);
  assert.equal(enabled.wechatArticles.aiSummary.apiBase, "https://ai.example/v1");
  assert.equal(enabled.wechatArticles.aiSummary.model, "mini");
});

test("pollWechatArticles tracks multiple accounts independently", async () => {
  const store = memoryState();
  const posts = [];
  const requested = [];

  const result = await pollWechatArticles(
    {
      apiBase: "http://wechat.test",
      fakeids: ["fakeid-1", "fakeid-2"],
      limit: 20,
      pushExistingOnFirstRun: true,
      feishuWebhookUrl: "https://open.feishu.cn/webhook/test",
    },
    {
      stateStore: store,
      fetch: async (url, init) => {
        if (String(url).startsWith("https://open.feishu.cn/webhook")) {
          posts.push(JSON.parse(init.body));
          return jsonResponse({ code: 0 });
        }

        const value = String(url);
        if (value.endsWith("/api/admin/status")) {
          return jsonResponse({ authenticated: true, nickname: "Account", expireTime: Date.now() + 24 * 3_600_000 });
        }

        const fakeid = new URL(value).searchParams.get("fakeid");
        requested.push(fakeid);
        return jsonResponse({
          articles: [article({ id: `${fakeid}-article`, fakeid, nickname: fakeid, publish_time: 100 })],
          next_since: 100,
        });
      },
    },
  );

  assert.deepEqual(requested, ["fakeid-1", "fakeid-2"]);
  assert.equal(result.checked, 2);
  assert.equal(result.pushed, 2);
  assert.equal(posts.length, 2);
  assert.deepEqual(store.state.accounts["fakeid-1"].pushedKeys, ["fakeid-1-article"]);
  assert.deepEqual(store.state.accounts["fakeid-2"].pushedKeys, ["fakeid-2-article"]);
});

test("pollWechatArticles can read fakeids from WeChat subscriptions", async () => {
  const store = memoryState();
  const requested = [];

  const result = await pollWechatArticles(
    {
      apiBase: "http://wechat.test",
      limit: 20,
      pushExistingOnFirstRun: false,
      useDynamicSubscriptions: true,
      allowUpstreamSubscriptionFallback: true,
      feishuWebhookUrl: "https://open.feishu.cn/webhook/test",
    },
    {
      stateStore: store,
      fetch: async (url, init) => {
        const value = String(url);
        if (value.endsWith("/api/admin/status")) {
          return jsonResponse({ authenticated: true, nickname: "Account", expireTime: Date.now() + 24 * 3_600_000 });
        }
        if (value.endsWith("/api/rss/subscriptions")) {
          return jsonResponse({
            success: true,
            data: [
              { fakeid: "fakeid-1", nickname: "Account 1" },
              { fakeid: "fakeid-2", nickname: "Account 2" },
            ],
          });
        }
        if (value.startsWith("https://open.feishu.cn/webhook")) {
          return jsonResponse({ code: 0 });
        }

        const fakeid = new URL(value).searchParams.get("fakeid");
        requested.push(fakeid);
        return jsonResponse({
          articles: [article({ id: `${fakeid}-old`, fakeid, nickname: fakeid, publish_time: 100 })],
          next_since: 100,
        });
      },
    },
  );

  assert.deepEqual(requested, ["fakeid-1", "fakeid-2"]);
  assert.equal(result.checked, 2);
  assert.equal(result.pushed, 0);
  assert.equal(result.skippedInitial, 2);
  assert.equal(store.state.accounts["fakeid-1"].since, 100);
  assert.equal(store.state.accounts["fakeid-2"].since, 100);
});

test("pollWechatArticles prefers local group subscriptions over upstream RSS leftovers", async () => {
  const store = memoryState();
  const subscriptionStore = memoryState({
    version: 1,
    groups: {
      oc_topic: {
        accounts: {
          "fakeid-owned": {
            fakeid: "fakeid-owned",
            nickname: "Owned Account",
            chatId: "oc_topic",
          },
          "fakeid-owned-2": {
            fakeid: "fakeid-owned-2",
            nickname: "Owned Account 2",
            chatId: "oc_topic",
          },
        },
      },
    },
  });
  const requested = [];

  const result = await pollWechatArticles(
    {
      apiBase: "http://wechat.test",
      limit: 20,
      pushExistingOnFirstRun: false,
      useDynamicSubscriptions: true,
      useLocalSubscriptions: true,
      feishuChatId: "oc_topic",
      feishuWebhookUrl: "https://open.feishu.cn/webhook/test",
    },
    {
      stateStore: store,
      subscriptionStore,
      fetch: async (url) => {
        const value = String(url);
        if (value.endsWith("/api/admin/status")) {
          return jsonResponse({ authenticated: true, nickname: "Account", expireTime: Date.now() + 24 * 3_600_000 });
        }
        if (value.endsWith("/api/rss/subscriptions")) {
          return jsonResponse({
            success: true,
            data: [{ fakeid: "fakeid-leftover", nickname: "Leftover Account" }],
          });
        }
        if (value.startsWith("https://open.feishu.cn/webhook")) {
          return jsonResponse({ code: 0 });
        }

        const fakeid = new URL(value).searchParams.get("fakeid");
        requested.push(fakeid);
        return jsonResponse({
          articles: [article({ id: `${fakeid}-old`, fakeid, nickname: fakeid, publish_time: 100 })],
          next_since: 100,
        });
      },
    },
  );

  assert.deepEqual(requested, ["fakeid-owned", "fakeid-owned-2"]);
  assert.equal(result.checked, 2);
  assert.equal(result.pushed, 0);
  assert.equal(store.state.accounts["oc_topic:fakeid-owned"].since, 100);
  assert.equal(store.state.accounts["oc_topic:fakeid-owned-2"].since, 100);
  assert.equal(store.state.accounts["fakeid-leftover"], undefined);
});

test("pollWechatArticles fans out the same subscribed account to each Feishu group", async () => {
  const store = memoryState({
    initialized: true,
    accounts: {
      "oc_a:fakeid-owned": { initialized: true, since: 90, pushedKeys: [] },
      "oc_b:fakeid-owned": { initialized: true, since: 90, pushedKeys: [] },
    },
  });
  const subscriptionStore = memoryState({
    version: 1,
    groups: {
      oc_a: {
        accounts: {
          "fakeid-owned": {
            fakeid: "fakeid-owned",
            nickname: "Owned Account",
            chatId: "oc_a",
          },
        },
      },
      oc_b: {
        accounts: {
          "fakeid-owned": {
            fakeid: "fakeid-owned",
            nickname: "Owned Account",
            chatId: "oc_b",
          },
        },
      },
    },
  });
  const commands = [];

  const result = await pollWechatArticles(
    {
      apiBase: "http://wechat.test",
      limit: 20,
      useLocalSubscriptions: true,
      larkCliCommand: "lark-cli.cmd",
      larkCliAs: "bot",
    },
    {
      stateStore: store,
      subscriptionStore,
      execFile: async (command, args) => {
        commands.push({ command, args });
        return { stdout: JSON.stringify({ ok: true, data: { message_id: randomUUID() } }) };
      },
      fetch: async (url) => {
        const value = String(url);
        if (value.endsWith("/api/admin/status")) {
          return jsonResponse({ authenticated: true, nickname: "Account", expireTime: Date.now() + 24 * 3_600_000 });
        }
        const fakeid = new URL(value).searchParams.get("fakeid");
        return jsonResponse({
          articles: [article({ id: "article-shared", fakeid, nickname: "Owned Account", publish_time: 100 })],
          next_since: 100,
        });
      },
    },
  );

  assert.equal(result.checked, 2);
  assert.equal(result.pushed, 2);
  assert.equal(commands.length, 2);
  assert.match(commands[0].args.join(" "), /oc_a/);
  assert.match(commands[1].args.join(" "), /oc_b/);
  assert.deepEqual(store.state.accounts["oc_a:fakeid-owned"].pushedKeys, ["article-shared"]);
  assert.deepEqual(store.state.accounts["oc_b:fakeid-owned"].pushedKeys, ["article-shared"]);
});

test("pollWechatArticles does not fall back to upstream RSS leftovers by default", async () => {
  const store = memoryState();
  const subscriptionStore = memoryState({ version: 1, groups: {} });
  const requested = [];

  const result = await pollWechatArticles(
    {
      apiBase: "http://wechat.test",
      limit: 20,
      pushExistingOnFirstRun: false,
      useDynamicSubscriptions: true,
      useLocalSubscriptions: true,
      feishuWebhookUrl: "https://open.feishu.cn/webhook/test",
    },
    {
      stateStore: store,
      subscriptionStore,
      fetch: async (url) => {
        const value = String(url);
        requested.push(value);
        if (value.endsWith("/api/admin/status")) {
          return jsonResponse({ authenticated: true, nickname: "Account", expireTime: Date.now() + 24 * 3_600_000 });
        }
        if (value.endsWith("/api/rss/subscriptions")) {
          return jsonResponse({
            success: true,
            data: [{ fakeid: "fakeid-leftover", nickname: "Leftover Account" }],
          });
        }
        throw new Error(`unexpected request: ${value}`);
      },
    },
  );

  assert.equal(result.checked, 0);
  assert.equal(result.pushed, 0);
  assert.equal(requested.some((value) => value.endsWith("/api/rss/subscriptions")), false);
});

test("dedupe state prevents duplicate article pushes", async () => {
  const store = memoryState({ initialized: true, since: 90, pushedKeys: ["new-1"] });
  const posts = [];

  const result = await pollWechatArticles(
    {
      apiBase: "http://wechat.test",
      fakeid: "fakeid-1",
      limit: 20,
      feishuWebhookUrl: "https://open.feishu.cn/webhook/test",
    },
    {
      stateStore: store,
      fetch: async (url, init) => {
        if (init) posts.push(init);
        return jsonResponse({ articles: [article({ id: "new-1", publish_time: 100 })], next_since: 100 });
      },
    },
  );

  assert.equal(result.pushed, 0);
  assert.equal(posts.length, 0);
  assert.deepEqual(store.state.pushedKeys, ["new-1"]);
  assert.equal(store.state.since, 100);
});

test("buildArticlePushText creates a compact Feishu notification", () => {
  const text = buildArticlePushText(
    {
      nickname: "Account",
      title: "A title",
      digest: "A digest",
      link: "https://mp.weixin.qq.com/s/demo",
    },
    { titlePrefix: "Update" },
  );

  assert.match(text, /\[Update\] Account/);
  assert.match(text, /Title: A title/);
  assert.match(text, /Digest: A digest/);
  assert.match(text, /Link: https:\/\/mp\.weixin\.qq\.com\/s\/demo/);
});

test("buildArticlePushText can override broken upstream account names", () => {
  const text = buildArticlePushText(
    {
      fakeid: "fakeid-1",
      nickname: "??",
      title: "A title",
      link: "https://mp.weixin.qq.com/s/demo",
    },
    {
      titlePrefix: "Update",
      accountNames: { "fakeid-1": "娉涘嚱" },
    },
  );

  assert.match(text, /\[Update\] 娉涘嚱/);
  assert.doesNotMatch(text, /\?\?/);
});

test("buildArticlePushText follows configured push fields", () => {
  const text = buildArticlePushText(
    {
      fakeid: "fakeid-1",
      nickname: "Account",
      title: "A title",
      digest: "A digest",
      author: "Author",
      publishTime: 1783000000,
      link: "https://mp.weixin.qq.com/s/demo",
    },
    { titlePrefix: "Update", pushFields: ["account", "title", "author", "published", "link"] },
  );

  assert.match(text, /\[Update\] Account/);
  assert.match(text, /Title: A title/);
  assert.match(text, /Author: Author/);
  assert.match(text, /Published: 2026-07-02/);
  assert.match(text, /Link: https:\/\/mp\.weixin\.qq\.com\/s\/demo/);
  assert.doesNotMatch(text, /Digest:/);
});

test("buildArticlePushText includes AI summary when enabled", () => {
  const text = buildArticlePushText(
    {
      nickname: "Account",
      title: "A title",
      digest: "A digest",
      aiSummary: "1. First point\n2. Second point",
      link: "https://mp.weixin.qq.com/s/demo",
    },
    { titlePrefix: "Update", aiSummary: { enabled: true } },
  );

  assert.match(text, /Summary:\n1\. First point\n2\. Second point/);
  assert.match(text, /Link: https:\/\/mp\.weixin\.qq\.com\/s\/demo/);
});

test("pollWechatArticles can add AI summary before pushing", async () => {
  const store = memoryState({ initialized: true, since: 90, pushedKeys: [] });
  const posts = [];
  const aiCalls = [];

  const result = await pollWechatArticles(
    {
      apiBase: "http://wechat.test",
      fakeid: "fakeid-1",
      limit: 20,
      feishuWebhookUrl: "https://open.feishu.cn/webhook/test",
      aiSummary: {
        enabled: true,
        apiBase: "https://ai.example/v1",
        apiKey: "secret",
        model: "mini",
        timeoutMs: 30000,
        maxInputChars: 1000,
      },
    },
    {
      stateStore: store,
      fetch: async (url, init) => {
        const value = String(url);
        if (value.endsWith("/api/article")) {
          return jsonResponse({
            success: true,
            data: { plain_content: "Full article content about product launch and customer value." },
          });
        }
        if (value.endsWith("/v1/chat/completions")) {
          aiCalls.push(JSON.parse(init.body));
          return jsonResponse({ choices: [{ message: { content: "1. Product launch\n2. Customer value" } }] });
        }
        if (value.startsWith("https://open.feishu.cn/webhook")) {
          posts.push(JSON.parse(init.body));
          return jsonResponse({ code: 0 });
        }

        return jsonResponse({ articles: [article({ id: "summary-1", publish_time: 100 })], next_since: 100 });
      },
    },
  );

  assert.equal(result.pushed, 1);
  assert.equal(aiCalls.length, 1);
  assert.match(aiCalls[0].messages[1].content, /Full article content/);
  assert.match(posts[0].content.text, /Summary:\n1\. Product launch\n2\. Customer value/);
});

test("pollWechatArticles still pushes when AI summary fails", async () => {
  const store = memoryState({ initialized: true, since: 90, pushedKeys: [] });
  const posts = [];

  const result = await pollWechatArticles(
    {
      apiBase: "http://wechat.test",
      fakeid: "fakeid-1",
      limit: 20,
      feishuWebhookUrl: "https://open.feishu.cn/webhook/test",
      aiSummary: {
        enabled: true,
        apiBase: "https://ai.example/v1",
        apiKey: "secret",
        model: "mini",
        timeoutMs: 30000,
        maxInputChars: 1000,
      },
    },
    {
      stateStore: store,
      fetch: async (url, init) => {
        const value = String(url);
        if (value.endsWith("/api/article")) {
          return jsonResponse({ success: true, data: { plain_content: "Full content." } });
        }
        if (value.endsWith("/v1/chat/completions")) {
          return jsonResponse({ error: "quota" }, 402);
        }
        if (value.startsWith("https://open.feishu.cn/webhook")) {
          posts.push(JSON.parse(init.body));
          return jsonResponse({ code: 0 });
        }

        return jsonResponse({ articles: [article({ id: "summary-fail-1", publish_time: 100 })], next_since: 100 });
      },
    },
  );

  assert.equal(result.pushed, 1);
  assert.equal(posts.length, 1);
  assert.match(posts[0].content.text, /Title: New article/);
  assert.doesNotMatch(posts[0].content.text, /Summary:/);
});

test("pollWechatArticles reminds when WeChat login is close to expiring", async () => {
  const store = memoryState({ initialized: true, since: 90, pushedKeys: [] });
  const posts = [];
  const expireTime = Date.now() + 2 * 3_600_000;

  const result = await pollWechatArticles(
    {
      apiBase: "http://wechat.test",
      fakeid: "fakeid-1",
      limit: 20,
      loginReminderThresholdHours: 12,
      feishuWebhookUrl: "https://open.feishu.cn/webhook/test",
    },
    {
      stateStore: store,
      fetch: async (url, init) => {
        const value = String(url);
        if (value.startsWith("https://open.feishu.cn/webhook")) {
          posts.push(JSON.parse(init.body));
          return jsonResponse({ code: 0 });
        }
        if (value.endsWith("/api/admin/status")) {
          return jsonResponse({ authenticated: true, nickname: "娉涘嚱", expireTime });
        }
        return jsonResponse({ articles: [], next_since: 90 });
      },
    },
  );

  assert.equal(result.pushed, 0);
  assert.equal(posts.length, 1);
  assert.ok(posts[0].content.text.length > 0);
  assert.equal(store.state.loginReminderKey, `expiring:${expireTime}`);
});

test("buildWechatLoginReminder reports expired login", () => {
  const reminder = buildWechatLoginReminder({ authenticated: false });

  assert.ok(reminder.text.length > 0);
  assert.match(reminder.key, /^expired:/);
});

test("POST /wechat/articles/poll manually triggers one compensation poll", async () => {
  const posts = [];
  const server = buildApp({
    fetch: async (url, init) => {
      if (String(url).startsWith("https://open.feishu.cn/webhook")) {
        posts.push(JSON.parse(init.body));
        return jsonResponse({ code: 0 });
      }

      return jsonResponse({ articles: [article({ id: "route-1", publish_time: 100 })], next_since: 100 });
    },
    wechatArticles: {
      enabled: true,
      apiBase: "http://wechat.test",
      fakeid: "fakeid-1",
      limit: 20,
      statePath: `.codex-tmp/test-wechat-route-state-${randomUUID()}.json`,
      pushExistingOnFirstRun: true,
      feishuWebhookUrl: "https://open.feishu.cn/webhook/test",
    },
  });

  await new Promise((resolve) => server.listen(0, resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const response = await fetch(`${baseUrl}/wechat/articles/poll`, { method: "POST" });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.result.pushed, 1);
    assert.equal(posts.length, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("POST /wechat/subscriptions searches and subscribes an account by name", async () => {
  const calls = [];
  const server = buildApp({
    fetch: async (url, init) => {
      const value = String(url);
      calls.push({ url: value, init });

      if (value.startsWith("http://wechat.test/api/public/searchbiz")) {
        assert.equal(new URL(value).searchParams.get("query"), "AgentVerse");
        return jsonResponse({
          success: true,
          data: {
            list: [
              {
                fakeid: "fakeid-agentverse",
                nickname: "AgentVerse",
                alias: "agentverse",
                description: "Agent research newsletter",
                round_head_img: "https://example.com/avatar.png",
              },
            ],
          },
        });
      }

      if (value === "http://wechat.test/api/rss/subscribe") {
        const body = JSON.parse(init.body);
        assert.equal(body.fakeid, "fakeid-agentverse");
        assert.equal(body.nickname, "AgentVerse");
        return jsonResponse({ success: true, message: "subscribed" });
      }

      throw new Error(`unexpected request: ${value}`);
    },
    wechatArticles: {
      enabled: true,
      apiBase: "http://wechat.test",
    },
  });

  await new Promise((resolve) => server.listen(0, resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const response = await fetch(`${baseUrl}/wechat/subscriptions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "AgentVerse" }),
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.account.fakeid, "fakeid-agentverse");
    assert.equal(body.message, "Subscribed WeChat account: AgentVerse");
    assert.equal(calls.length, 2);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("POST /wechat/subscriptions/search returns a selectable card with candidates", async () => {
  const server = buildApp({
    fetch: async (url) => {
      const value = String(url);
      if (value.startsWith("http://wechat.test/api/public/searchbiz")) {
        assert.equal(new URL(value).searchParams.get("query"), "Agent");
        return jsonResponse({
          success: true,
          data: {
            list: [
              {
                fakeid: "fakeid-a",
                nickname: "Agent A",
                alias: "agent-a",
                description: "First agent account",
                round_head_img: "https://example.com/a.png",
              },
              {
                fakeid: "fakeid-b",
                nickname: "Agent B",
                alias: "agent-b",
                description: "Second agent account",
                round_head_img: "https://example.com/b.png",
              },
            ],
          },
        });
      }
      if (value.startsWith("https://example.com/")) {
        return new Response(Buffer.from("fake-image"), { status: 200 });
      }

      throw new Error(`unexpected request: ${value}`);
    },
    wechatArticles: {
      enabled: true,
      apiBase: "http://wechat.test",
    },
  });

  await new Promise((resolve) => server.listen(0, resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const response = await fetch(`${baseUrl}/wechat/subscriptions/search`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "Agent" }),
    });
    const body = await response.json();
    const firstRow = body.card.elements[0];
    const secondRow = body.card.elements[2];
    const firstButton = firstRow.columns.at(-1).elements[0];
    const firstInfo = firstRow.columns.find((column) => column.elements?.[0]?.tag === "markdown");

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.candidates.length, 2);
    assert.equal(body.candidates[0].headImg, "https://example.com/a.png");
    assert.equal(body.candidates[0].description, "First agent account");
    assert.equal(firstRow.tag, "column_set");
    assert.equal(secondRow.tag, "column_set");
    assert.doesNotMatch(JSON.stringify(body.card), /"tag":"img"/);
    assert.equal(firstInfo.elements[0].tag, "markdown");
    assert.equal(firstButton.text.content, "订阅");
    assert.equal(firstButton.value.fakeid, "fakeid-a");
    assert.equal(firstButton.value.description, "First agent account");
    assert.doesNotMatch(JSON.stringify(body.card), /Avatar/);
    assert.match(JSON.stringify(body.card), /简介：First agent account/);
    assert.match(JSON.stringify(body.card), /agent-a/);
    assert.doesNotMatch(firstInfo.elements[0].content, /fakeid-a/);
    assert.doesNotMatch(firstInfo.elements[0].content, /识别码/);
    assert.doesNotMatch(JSON.stringify(body.card), /FakeID/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("POST /wechat/subscriptions/search explains missing account descriptions", async () => {
  const server = buildApp({
    fetch: async (url) => {
      const value = String(url);
      if (value.startsWith("http://wechat.test/api/public/searchbiz")) {
        return jsonResponse({
          success: true,
          data: {
            list: [
              {
                fakeid: "fakeid-a",
                nickname: "Agent A",
                alias: "agent-a",
              },
            ],
          },
        });
      }

      throw new Error(`unexpected request: ${value}`);
    },
    wechatArticles: {
      enabled: true,
      apiBase: "http://wechat.test",
    },
  });

  await new Promise((resolve) => server.listen(0, resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const response = await fetch(`${baseUrl}/wechat/subscriptions/search`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "Agent" }),
    });
    const body = await response.json();
    const firstInfo = body.card.elements[0].columns[0].elements[0].content;

    assert.equal(response.status, 200);
    assert.match(firstInfo, /简介：接口未返回/);
    assert.doesNotMatch(firstInfo, /识别码/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});


test("POST /wechat/subscriptions/confirm subscribes the selected candidate", async () => {
  const subscriptionStore = memoryState();
  const server = buildApp({
    fetch: async (url, init) => {
      const value = String(url);
      if (value === "http://wechat.test/api/rss/subscribe") {
        const body = JSON.parse(init.body);
        assert.equal(body.fakeid, "fakeid-b");
        assert.equal(body.nickname, "Agent B");
        return jsonResponse({ success: true, message: "subscribed" });
      }

      throw new Error(`unexpected request: ${value}`);
    },
    wechatArticles: {
      enabled: true,
      apiBase: "http://wechat.test",
      subscriptionStore,
    },
  });

  await new Promise((resolve) => server.listen(0, resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const response = await fetch(`${baseUrl}/wechat/subscriptions/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: {
          value: {
            fakeid: "fakeid-b",
            nickname: "Agent B",
            alias: "agent-b",
            description: "Second agent account",
            headImg: "https://example.com/b.png",
            chatId: "oc_topic",
          },
        },
      }),
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.account.fakeid, "fakeid-b");
    assert.equal(body.localSubscription.fakeid, "fakeid-b");
    assert.equal(body.localSubscription.chatId, "oc_topic");
    assert.equal(body.localSubscription.description, "Second agent account");
    assert.equal(body.toast.content, "Subscribed: Agent B. Future articles will be pushed here.");
    assert.equal(subscriptionStore.state.groups.oc_topic.accounts["fakeid-b"].nickname, "Agent B");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("POST /wechat/subscriptions/confirm ignores operator id when resolving group subscription", async () => {
  const subscriptionStore = memoryState();
  const server = buildApp({
    fetch: async (url, init) => {
      const value = String(url);
      if (value === "http://wechat.test/api/rss/subscribe") {
        const body = JSON.parse(init.body);
        assert.equal(body.fakeid, "fakeid-c");
        return jsonResponse({ success: true, message: "subscribed" });
      }

      throw new Error(`unexpected request: ${value}`);
    },
    wechatArticles: {
      enabled: true,
      apiBase: "http://wechat.test",
      subscriptionStore,
    },
  });

  await new Promise((resolve) => server.listen(0, resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const response = await fetch(`${baseUrl}/wechat/subscriptions/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        event: {
          operator: { open_id: "ou_user" },
          context: { open_chat_id: "oc_group" },
          action: {
            value: JSON.stringify({
              fakeid: "fakeid-c",
              nickname: "Agent C",
            }),
          },
        },
      }),
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.localSubscription.chatId, "oc_group");
    assert.equal(subscriptionStore.state.groups.oc_group.accounts["fakeid-c"].nickname, "Agent C");
    assert.equal(subscriptionStore.state.groups.ou_user, undefined);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("GET and DELETE /wechat/subscriptions manage local group subscriptions", async () => {
  const subscriptionStore = memoryState({
    version: 1,
    groups: {
      oc_topic: {
        accounts: {
          "fakeid-old": {
            fakeid: "fakeid-old",
            nickname: "Old Account",
            chatId: "oc_topic",
          },
        },
      },
      oc_other: {
        accounts: {
          "fakeid-old": {
            fakeid: "fakeid-old",
            nickname: "Other Account",
            chatId: "oc_other",
          },
        },
      },
    },
  });
  const server = buildApp({
    wechatArticles: {
      enabled: true,
      apiBase: "http://wechat.test",
      subscriptionStore,
    },
  });

  await new Promise((resolve) => server.listen(0, resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const listResponse = await fetch(`${baseUrl}/wechat/subscriptions?chat_id=oc_topic`);
    const listBody = await listResponse.json();

    assert.equal(listResponse.status, 200);
    assert.equal(listBody.subscriptions.length, 1);
    assert.equal(listBody.subscriptions[0].nickname, "Old Account");

    const deleteResponse = await fetch(`${baseUrl}/wechat/subscriptions?chat_id=oc_topic&fakeid=fakeid-old`, {
      method: "DELETE",
    });
    const deleteBody = await deleteResponse.json();

    assert.equal(deleteResponse.status, 200);
    assert.equal(deleteBody.removed, 1);
    assert.equal(subscriptionStore.state.groups.oc_topic.accounts["fakeid-old"], undefined);
    assert.equal(subscriptionStore.state.groups.oc_other.accounts["fakeid-old"].nickname, "Other Account");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("POST /agent/wechat-subscriptions requires an enabled API token", async () => {
  const server = buildApp({
    wechatArticles: {
      enabled: true,
      feishuChatId: "oc_live",
      subscriptionStore: memoryState(),
    },
  });

  await new Promise((resolve) => server.listen(0, resolve));
  const address = server.address();

  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/agent/wechat-subscriptions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ operation: "list" }),
    });
    const body = await response.json();

    assert.equal(response.status, 503);
    assert.equal(body.error, "agent_api_not_configured");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("POST /agent/wechat-subscriptions rejects invalid credentials and other groups", async () => {
  const server = buildApp({
    wechatArticles: {
      enabled: true,
      agentApiToken: "test-agent-token",
      feishuChatId: "oc_live",
      subscriptionStore: memoryState(),
    },
  });

  await new Promise((resolve) => server.listen(0, resolve));
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}/agent/wechat-subscriptions`;

  try {
    const unauthorized = await fetch(url, {
      method: "POST",
      headers: {
        authorization: "Bearer wrong-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ operation: "list" }),
    });
    assert.equal(unauthorized.status, 401);

    const wrongGroup = await fetch(url, {
      method: "POST",
      headers: {
        authorization: "Bearer test-agent-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ operation: "list", chat_id: "oc_other" }),
    });
    const body = await wrongGroup.json();

    assert.equal(wrongGroup.status, 403);
    assert.equal(body.error, "chat_not_allowed");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("POST /agent/wechat-subscriptions supports direct search, add, list, and exact remove", async () => {
  const subscriptionStore = memoryState();
  const server = buildApp({
    fetch: async (url, init) => {
      const value = String(url);
      if (value === "http://wechat.test/api/public/searchbiz?query=%E6%B3%9B%E5%87%BD") {
        return jsonResponse({
          success: true,
          data: {
            list: [
              {
                fakeid: "fakeid-fanhan",
                nickname: "泛函",
                alias: "fanhan",
                description: "泛函公众号",
              },
            ],
          },
        });
      }
      if (value === "http://wechat.test/api/rss/subscribe") {
        return jsonResponse({ success: true, message: "subscribed" });
      }
      throw new Error(`unexpected request: ${value}`);
    },
    wechatArticles: {
      enabled: true,
      agentApiToken: "test-agent-token",
      apiBase: "http://wechat.test",
      feishuChatId: "oc_live",
      subscriptionStore,
    },
  });

  await new Promise((resolve) => server.listen(0, resolve));
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}/agent/wechat-subscriptions`;
  const callAgent = async (input) => {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        authorization: "Bearer test-agent-token",
        "content-type": "application/json",
      },
      body: JSON.stringify(input),
    });
    return { response, body: await response.json() };
  };

  try {
    const search = await callAgent({ operation: "search", account_name: "泛函" });
    assert.equal(search.response.status, 200);
    assert.equal(search.body.candidates_count, 1);
    assert.equal(search.body.requires_confirmation, true);

    const add = await callAgent({
      operation: "add",
      account: search.body.candidates[0],
    });
    assert.equal(add.response.status, 200);
    assert.equal(add.body.account.nickname, "泛函");
    assert.equal(add.body.subscriptions_count, 1);

    const list = await callAgent({ operation: "list" });
    assert.equal(list.response.status, 200);
    assert.equal(list.body.subscriptions_count, 1);
    assert.equal(list.body.subscriptions[0].chatId, "oc_live");

    const remove = await callAgent({ operation: "remove", account_name: "泛函" });
    assert.equal(remove.response.status, 200);
    assert.equal(remove.body.removed, 1);
    assert.equal(remove.body.subscriptions_count, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
