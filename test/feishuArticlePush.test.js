import test from "node:test";
import assert from "node:assert/strict";
import { sendFeishuChatTextWithApp } from "../src/integrations/feishuArticlePush.js";

test("sendFeishuChatTextWithApp gets tenant token and sends text to chat", async () => {
  const calls = [];
  const fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith("/auth/v3/tenant_access_token/internal")) {
      return response({ code: 0, tenant_access_token: "tenant-token" });
    }
    return response({ code: 0, data: { message_id: "om_test" } });
  };

  const result = await sendFeishuChatTextWithApp(
    {
      larkApiBase: "https://open.feishu.cn/open-apis",
      larkAppId: "cli_test",
      larkAppSecret: "secret",
      feishuChatId: "oc_test",
    },
    "hello",
    { fetch },
  );

  assert.equal(result.code, 0);
  assert.equal(calls.length, 2);
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    app_id: "cli_test",
    app_secret: "secret",
  });
  assert.equal(calls[1].options.headers.authorization, "Bearer tenant-token");
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    receive_id: "oc_test",
    msg_type: "text",
    content: JSON.stringify({ text: "hello" }),
  });
});

function response(body, ok = true) {
  return {
    ok,
    status: ok ? 200 : 500,
    async text() {
      return JSON.stringify(body);
    },
  };
}
