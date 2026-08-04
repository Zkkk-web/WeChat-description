import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { buildApp } from "../src/server.js";

let server;
let baseUrl;

before(async () => {
  server = buildApp();
  await new Promise((resolve) => server.listen(0, resolve));
  const address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

async function postWebhook(payload) {
  const response = await fetch(`${baseUrl}/webhook`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      source: "manual-test",
      type: "email.received",
      payload,
    }),
  });

  return { response, body: await response.json() };
}

test("POST /webhook accepts an event", async () => {
  const response = await fetch(`${baseUrl}/webhook`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      source: "test-mailbox",
      type: "mail.received",
      payload: { subject: "resume" },
    }),
  });
  const body = await response.json();

  assert.equal(response.status, 202);
  assert.equal(body.ok, true);
  assert.equal(body.accepted, true);
  assert.equal(body.event.source, "test-mailbox");
  assert.equal(body.event.type, "mail.received");
  assert.equal(body.event.payload.subject, "resume");
  assert.match(body.hermesPrompt, /External event: mail received/);
  assert.match(body.hermesPrompt, /Event payload/);
});

test("POST /webhook answers Feishu URL verification challenge", async () => {
  const response = await fetch(`${baseUrl}/webhook`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "url_verification",
      challenge: "challenge-token",
      token: "verification-token",
    }),
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.challenge, "challenge-token");
});

test("POST /webhook translates Feishu mail notification into fetch task", async () => {
  const response = await fetch(`${baseUrl}/webhook`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      schema: "2.0",
      header: {
        event_id: "evt-mail-001",
        event_type: "mail.user_mailbox.event.message_received_v1",
        create_time: "1608725989000",
      },
      event: {
        mail_address: "inbox@example.com",
        message_id: "message-001",
        mailbox_type: 1,
      },
    }),
  });
  const body = await response.json();

  assert.equal(response.status, 202);
  assert.equal(body.event.source, "feishu");
  assert.equal(body.event.type, "mail.user_mailbox.event.message_received_v1");
  assert.equal(body.simulation, null);
  assert.match(body.hermesPrompt, /Feishu mail received/);
  assert.match(body.hermesPrompt, /messages\/message-001/);
});

test("POST /webhook translates Feishu minutes event into transcript task", async () => {
  const response = await fetch(`${baseUrl}/webhook`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      schema: "2.0",
      header: {
        event_id: "evt-minute-001",
        event_type: "minutes.minute.generated_v1",
        create_time: "1608725989000",
      },
      event: {
        minute_token: "obcnq3b9jl72l83w4f14xxxx",
        minute_source: {
          source_type: "meeting",
          source_entity_id: "6911188411934433028",
        },
      },
    }),
  });
  const body = await response.json();

  assert.equal(response.status, 202);
  assert.equal(body.event.type, "minutes.minute.generated_v1");
  assert.match(body.hermesPrompt, /Feishu minutes generated/);
  assert.match(body.hermesPrompt, /transcript/);
});

test("POST /webhook can enrich Feishu minutes event when content fetching is enabled", async () => {
  const calls = [];
  const app = buildApp({
    larkContent: {
      enabled: true,
      apiBase: "https://open.feishu.cn/open-apis",
      accessToken: "token",
    },
    async fetch(url) {
      calls.push(url);

      if (url.endsWith("/transcript?need_speaker=true&need_timestamp=true&file_format=txt")) {
        return new Response("00:00 Alice: meeting transcript", { status: 200 });
      }

      return new Response(
        JSON.stringify({
          code: 0,
          data: {
            minute: {
              title: "Weekly Meeting",
              url: "https://example.feishu.cn/minutes/obcnq3b9jl72l83w4f14xxxx",
              note_id: "note-001",
              duration: "30000",
            },
          },
        }),
        { status: 200 },
      );
    },
  });
  await new Promise((resolve) => app.listen(0, resolve));
  const address = app.address();
  const appBaseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const response = await fetch(`${appBaseUrl}/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schema: "2.0",
        header: {
          event_id: "evt-minute-002",
          event_type: "minutes.minute.generated_v1",
          create_time: "1608725989000",
        },
        event: {
          minute_token: "obcnq3b9jl72l83w4f14xxxx",
        },
      }),
    });
    const body = await response.json();

    assert.equal(response.status, 202);
    assert.equal(calls.length, 2);
    assert.equal(body.enrichment.title, "Weekly Meeting");
    assert.match(body.hermesPrompt, /meeting transcript/);
  } finally {
    await new Promise((resolve) => app.close(resolve));
  }
});

test("POST /webhook simulates candidate resume routing", async () => {
  const { response, body } = await postWebhook({
    message_id: "test-001",
    from_email: "candidate@example.com",
    from_name: "张三",
    subject: "应聘 AI 产品经理 - 张三",
    body: "你好，附件是我的简历，我想应聘 AI 产品经理。",
    attachments: [{ filename: "张三简历.pdf" }],
  });

  assert.equal(response.status, 202);
  assert.equal(body.simulation.classification.classification, "candidate_direct");
  assert.match(body.hermesPrompt, /Classification: candidate_direct/);
  assert.deepEqual(
    body.simulation.plannedWrites.map((item) => item.table),
    ["邮件事件", "候选人"],
  );
});

test("POST /webhook routes client job mail into jobs only", async () => {
  const { response, body } = await postWebhook({
    message_id: "test-002",
    from_email: "hr@client.com",
    from_name: "王经理",
    subject: "合作招聘：AI 产品经理",
    body: "我们想合作招聘一个 AI 产品经理，base 上海，预算 30-50k，这是一条新岗位。",
    attachments: [],
  });

  assert.equal(response.status, 202);
  assert.equal(body.simulation.classification.classification, "client_job");
  assert.deepEqual(
    body.simulation.plannedWrites.map((item) => item.table),
    ["邮件事件", "客户列表", "岗位"],
  );
  assert.equal(body.simulation.plannedWrites[1].fields["邮箱"], "hr@client.com");
});

test("POST /webhook does not route external job feeds into jobs", async () => {
  const { response, body } = await postWebhook({
    message_id: "test-linkedin-001",
    from_email: "jobs-noreply@linkedin.com",
    from_name: "LinkedIn",
    subject: "Recommended jobs: AI Product Manager",
    body: "You have new recommended jobs on LinkedIn. Unsubscribe from this job alert.",
    attachments: [],
  });

  assert.equal(response.status, 202);
  assert.equal(body.simulation.classification.classification, "external_job_feed");
  assert.deepEqual(
    body.simulation.plannedWrites.map((item) => item.table),
    ["邮件事件"],
  );
});

test("POST /webhook blocks generic third-party job alert feeds", async () => {
  const { response, body } = await postWebhook({
    message_id: "test-platform-feed-001",
    from_email: "noreply@jobs-platform.example",
    from_name: "Jobs Platform",
    subject: "今日岗位推荐：AI 产品经理",
    body: "这是你订阅的岗位推荐邮件。如不想继续接收，可以取消订阅。",
    attachments: [],
  });

  assert.equal(response.status, 202);
  assert.equal(body.simulation.classification.classification, "external_job_feed");
  assert.deepEqual(
    body.simulation.plannedWrites.map((item) => item.table),
    ["邮件事件"],
  );
});

test("POST /webhook simulates client forwarded resume routing", async () => {
  const { response, body } = await postWebhook({
    message_id: "test-003",
    from_email: "hr@client.com",
    from_name: "王经理",
    subject: "推荐一个候选人",
    body: "这个候选人不错，你看下。",
    attachments: [{ filename: "李四简历.pdf" }],
  });

  assert.equal(response.status, 202);
  assert.equal(body.simulation.classification.classification, "client_forward_resume");
  assert.deepEqual(
    body.simulation.plannedWrites.map((item) => item.table),
    ["邮件事件", "候选人"],
  );
  assert.equal(body.simulation.plannedWrites[1].fields["补充材料文件名"], "李四简历.pdf");
  assert.equal(body.simulation.plannedWrites[1].fields["邮箱"], "");
});

test("POST /webhook routes hunter partner mail", async () => {
  const { response, body } = await postWebhook({
    message_id: "test-004",
    from_email: "hunter@example.com",
    from_name: "猎头李",
    subject: "猎头伙伴合作",
    body: "我这边有一些候选人资源，希望后续可以合作推荐简历。",
    attachments: [],
  });

  assert.equal(response.status, 202);
  assert.equal(body.simulation.classification.classification, "hunter_partner");
  assert.deepEqual(
    body.simulation.plannedWrites.map((item) => item.table),
    ["邮件事件", "猎头伙伴"],
  );
});

test("POST /webhook routes ecosystem partner mail", async () => {
  const { response, body } = await postWebhook({
    message_id: "test-005",
    from_email: "partner@example.com",
    from_name: "生态王",
    subject: "生态伙伴合作",
    body: "想加入生态伙伴，一起做资源合作和渠道合作。",
    attachments: [],
  });

  assert.equal(response.status, 202);
  assert.equal(body.simulation.classification.classification, "ecosystem_partner");
  assert.deepEqual(
    body.simulation.plannedWrites.map((item) => item.table),
    ["邮件事件", "生态伙伴"],
  );
});

test("POST /webhook sends a WeChat subscription search card for chat command", async () => {
  const execCalls = [];
  const app = buildApp({
    fetch: async (url) => {
      const value = String(url);
      if (value.startsWith("http://wechat.test/api/public/searchbiz")) {
        assert.equal(new URL(value).searchParams.get("query"), "Agent");
        return new Response(
          JSON.stringify({
            success: true,
            data: {
              list: [
                {
                  fakeid: "fakeid-agent",
                  nickname: "Agent",
                  alias: "agent",
                  round_head_img: "https://example.com/agent.png",
                },
              ],
            },
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`unexpected request: ${value}`);
    },
    execFile: async (command, args) => {
      execCalls.push({ command, args });
      return { stdout: JSON.stringify({ ok: true, message_id: "om_card" }) };
    },
    wechatArticles: {
      enabled: true,
      apiBase: "http://wechat.test",
      larkCliCommand: "lark-cli",
      larkCliAs: "bot",
    },
  });

  await new Promise((resolve) => app.listen(0, resolve));
  const address = app.address();

  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schema: "2.0",
        header: {
          event_id: "evt-im-001",
          event_type: "im.message.receive_v1",
        },
        event: {
          message: {
            chat_id: "oc_test",
            content: JSON.stringify({ text: "订阅公众号 Agent" }),
          },
        },
      }),
    });
    const body = await response.json();
    const messageCall = execCalls.find((call) => call.args.includes("+messages-send"));
    const contentIndex = messageCall.args.indexOf("--content");
    const card = JSON.parse(messageCall.args[contentIndex + 1]);

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.type, "wechat_subscription_search");
    assert.equal(execCalls.length, 1);
    assert.deepEqual(messageCall.args.slice(0, 6), ["im", "+messages-send", "--chat-id", "oc_test", "--msg-type", "interactive"]);
    const firstRow = card.elements[0];
    assert.equal(firstRow.tag, "column_set");
    assert.equal(firstRow.columns[0].elements[0].tag, "markdown");
    assert.equal(firstRow.columns[1].elements[0].value.fakeid, "fakeid-agent");
  } finally {
    await new Promise((resolve) => app.close(resolve));
  }
});

test("POST /webhook handles flat Feishu message events with natural subscription language", async () => {
  const execCalls = [];
  const app = buildApp({
    fetch: async (url) => {
      const value = String(url);
      if (value.startsWith("http://wechat.test/api/public/searchbiz")) {
        assert.equal(new URL(value).searchParams.get("query"), "泛函");
        return new Response(
          JSON.stringify({
            success: true,
            data: {
              list: [
                {
                  fakeid: "fakeid-fanhan",
                  nickname: "泛函",
                  alias: "fanhan",
                  round_head_img: "https://example.com/fanhan.png",
                },
              ],
            },
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`unexpected request: ${value}`);
    },
    execFile: async (command, args) => {
      execCalls.push({ command, args });
      return { stdout: JSON.stringify({ ok: true, message_id: "om_card" }) };
    },
    wechatArticles: {
      enabled: true,
      apiBase: "http://wechat.test",
      larkCliCommand: "lark-cli",
      larkCliAs: "bot",
    },
  });

  await new Promise((resolve) => app.listen(0, resolve));
  const address = app.address();

  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "im.message.receive_v1",
        chat_id: "oc_direct",
        content: "我想订阅公众号泛函",
      }),
    });
    const body = await response.json();
    const messageCall = execCalls.find((call) => call.args.includes("+messages-send"));
    const contentIndex = messageCall.args.indexOf("--content");
    const card = JSON.parse(messageCall.args[contentIndex + 1]);

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.type, "wechat_subscription_search");
    assert.equal(body.query, "泛函");
    assert.equal(execCalls.length, 1);
    assert.deepEqual(messageCall.args.slice(0, 6), ["im", "+messages-send", "--chat-id", "oc_direct", "--msg-type", "interactive"]);
    const firstRow = card.elements[0];
    assert.equal(firstRow.tag, "column_set");
    assert.equal(firstRow.columns[0].elements[0].tag, "markdown");
    assert.equal(firstRow.columns[1].elements[0].value.fakeid, "fakeid-fanhan");
  } finally {
    await new Promise((resolve) => app.close(resolve));
  }
});

test("POST /webhook lists subscriptions from the current Feishu group", async () => {
  const execCalls = [];
  const subscriptionStore = memorySubscriptionStore({
    version: 1,
    groups: {
      oc_live: {
        accounts: {
          "fakeid-fanhan": { fakeid: "fakeid-fanhan", nickname: "泛函", chatId: "oc_live" },
          "fakeid-agent": { fakeid: "fakeid-agent", nickname: "Agent", chatId: "oc_live" },
        },
      },
      oc_other: {
        accounts: {
          "fakeid-other": { fakeid: "fakeid-other", nickname: "其他群公众号", chatId: "oc_other" },
        },
      },
    },
  });
  const app = buildApp({
    wechatArticles: {
      enabled: true,
      feishuChatId: "oc_live",
      subscriptionStore,
      larkCliCommand: "lark-cli",
      larkCliAs: "bot",
    },
    execFile: captureLarkMessages(execCalls),
  });

  await new Promise((resolve) => app.listen(0, resolve));
  const address = app.address();

  try {
    const { response, body } = await postWechatMessage(address.port, "oc_live", "@艾伦 查看公众号订阅");

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.type, "wechat_subscription_list");
    assert.equal(body.subscriptionsCount, 2);
    assert.equal(execCalls.length, 1);
    assert.match(execCalls[0].args.join(" "), /泛函/);
    assert.match(execCalls[0].args.join(" "), /Agent/);
    assert.doesNotMatch(execCalls[0].args.join(" "), /其他群公众号/);
  } finally {
    await new Promise((resolve) => app.close(resolve));
  }
});

test("POST /webhook removes an exact subscription instead of treating it as an add command", async () => {
  const execCalls = [];
  const subscriptionStore = memorySubscriptionStore({
    version: 1,
    groups: {
      oc_live: {
        accounts: {
          "fakeid-geekpark": { fakeid: "fakeid-geekpark", nickname: "极客公园", chatId: "oc_live" },
          "fakeid-fanhan": { fakeid: "fakeid-fanhan", nickname: "泛函", chatId: "oc_live" },
        },
      },
    },
  });
  const app = buildApp({
    fetch: async () => {
      throw new Error("remove must not call the upstream account search");
    },
    wechatArticles: {
      enabled: true,
      feishuChatId: "oc_live",
      subscriptionStore,
      larkCliCommand: "lark-cli",
      larkCliAs: "bot",
    },
    execFile: captureLarkMessages(execCalls),
  });

  await new Promise((resolve) => app.listen(0, resolve));
  const address = app.address();

  try {
    const { response, body } = await postWechatMessage(address.port, "oc_live", "@艾伦 取消订阅公众号 极客公园");
    const state = await subscriptionStore.load();

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.type, "wechat_subscription_remove");
    assert.equal(body.removed, 1);
    assert.equal(body.subscriptionsCount, 1);
    assert.equal(state.groups.oc_live.accounts["fakeid-geekpark"], undefined);
    assert.equal(state.groups.oc_live.accounts["fakeid-fanhan"].nickname, "泛函");
    assert.equal(execCalls.length, 1);
    assert.match(execCalls[0].args.join(" "), /已取消公众号「极客公园」的推送/);
  } finally {
    await new Promise((resolve) => app.close(resolve));
  }
});

test("POST /webhook confirms a WeChat subscription card action", async () => {
  let subscriptionState = {};
  const execCalls = [];
  const subscriptionStore = {
    async load() {
      return subscriptionState;
    },
    async save(next) {
      subscriptionState = next;
    },
  };
  const app = buildApp({
    fetch: async (url, init) => {
      const value = String(url);
      if (value === "http://wechat.test/api/rss/subscribe") {
        const body = JSON.parse(init.body);
        assert.equal(body.fakeid, "fakeid-agent");
        return new Response(JSON.stringify({ success: true }), {
          headers: { "content-type": "application/json" },
        });
      }

      throw new Error(`unexpected request: ${value}`);
    },
    wechatArticles: {
      enabled: true,
      apiBase: "http://wechat.test",
      subscriptionStore,
      larkCliCommand: "lark-cli",
      larkCliAs: "bot",
    },
    execFile: async (command, args) => {
      execCalls.push({ command, args });
      return { stdout: JSON.stringify({ ok: true, message_id: "om_feedback" }) };
    },
  });

  await new Promise((resolve) => app.listen(0, resolve));
  const address = app.address();

  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schema: "2.0",
        header: {
          event_id: "evt-card-001",
          event_type: "card.action.trigger",
        },
        event: {
          action: {
            value: {
              action: "wechat_subscribe",
              fakeid: "fakeid-agent",
              nickname: "Agent",
              chatId: "oc_test",
            },
          },
        },
      }),
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.type, "wechat_subscription_confirm");
    assert.equal(body.localSubscription.chatId, "oc_test");
    assert.equal(subscriptionState.groups.oc_test.accounts["fakeid-agent"].nickname, "Agent");
    assert.equal(execCalls.length, 1);
    assert.deepEqual(execCalls[0].args.slice(0, 4), ["im", "+messages-send", "--chat-id", "oc_test"]);
    assert.match(execCalls[0].args.join(" "), /已成功订阅公众号「Agent」/);
    assert.equal(body.toast.content, "Subscribed: Agent. Future articles will be pushed here.");
  } finally {
    await new Promise((resolve) => app.close(resolve));
  }
});

function memorySubscriptionStore(initialState) {
  let state = structuredClone(initialState);
  return {
    async load() {
      return structuredClone(state);
    },
    async save(next) {
      state = structuredClone(next);
    },
  };
}

function captureLarkMessages(calls) {
  return async (command, args) => {
    calls.push({ command, args });
    return { stdout: JSON.stringify({ ok: true, message_id: `om_${calls.length}` }) };
  };
}

async function postWechatMessage(port, chatId, text) {
  const response = await fetch(`http://127.0.0.1:${port}/webhook`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      schema: "2.0",
      header: {
        event_id: `evt-${Date.now()}`,
        event_type: "im.message.receive_v1",
      },
      event: {
        message: {
          chat_id: chatId,
          content: JSON.stringify({ text }),
        },
      },
    }),
  });
  return { response, body: await response.json() };
}

test("POST /webhook confirms a flat card.action.trigger event", async () => {
  let subscriptionState = {};
  const execCalls = [];
  const subscriptionStore = {
    async load() {
      return subscriptionState;
    },
    async save(next) {
      subscriptionState = next;
    },
  };
  const app = buildApp({
    fetch: async (url, init) => {
      const value = String(url);
      if (value === "http://wechat.test/api/rss/subscribe") {
        const body = JSON.parse(init.body);
        assert.equal(body.fakeid, "fakeid-flat");
        return new Response(JSON.stringify({ success: true }), {
          headers: { "content-type": "application/json" },
        });
      }

      throw new Error(`unexpected request: ${value}`);
    },
    wechatArticles: {
      enabled: true,
      apiBase: "http://wechat.test",
      subscriptionStore,
      larkCliCommand: "lark-cli",
      larkCliAs: "bot",
    },
    execFile: async (command, args) => {
      execCalls.push({ command, args });
      return { stdout: JSON.stringify({ ok: true, message_id: "om_flat_feedback" }) };
    },
  });

  await new Promise((resolve) => app.listen(0, resolve));
  const address = app.address();

  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "card.action.trigger",
        chat_id: "oc_flat",
        action_value: JSON.stringify({
          action: "wechat_subscribe",
          fakeid: "fakeid-flat",
          nickname: "Flat Account",
        }),
      }),
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.localSubscription.chatId, "oc_flat");
    assert.equal(subscriptionState.groups.oc_flat.accounts["fakeid-flat"].nickname, "Flat Account");
    assert.equal(execCalls.length, 1);
    assert.match(execCalls[0].args.join(" "), /已成功订阅公众号「Flat Account」/);
  } finally {
    await new Promise((resolve) => app.close(resolve));
  }
});
