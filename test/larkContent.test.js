import assert from "node:assert/strict";
import { test } from "node:test";
import { enrichFeishuEvent, fetchFeishuMailMessage, fetchFeishuMinuteTranscript } from "../src/integrations/larkContent.js";

function base64Url(value) {
  return Buffer.from(value, "utf8").toString("base64url");
}

test("fetchFeishuMailMessage reads and normalizes mail content", async () => {
  const calls = [];
  const event = {
    type: "mail.user_mailbox.event.message_received_v1",
    payload: {
      mail_address: "inbox@example.com",
      message_id: "message-001",
    },
  };

  const result = await fetchFeishuMailMessage(
    {
      enabled: true,
      apiBase: "https://open.feishu.cn/open-apis",
      accessToken: "token",
    },
    event,
    {
      async fetch(url, options) {
        calls.push({ url, options });

        return new Response(
          JSON.stringify({
            code: 0,
            data: {
              message: {
                message_id: "message-001",
                subject: "Resume",
                head_from: { mail_address: "candidate@example.com", name: "Candidate" },
                body_plain_text: base64Url("hello resume"),
                attachments: [{ id: "att-1", filename: "resume.pdf", attachment_type: 1 }],
              },
            },
          }),
          { status: 200 },
        );
      },
    },
  );

  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    "https://open.feishu.cn/open-apis/mail/v1/user_mailboxes/inbox%40example.com/messages/message-001?format=plain_text_full",
  );
  assert.equal(calls[0].options.headers.authorization, "Bearer token");
  assert.deepEqual(result, {
    kind: "feishu_mail",
    messageId: "message-001",
    subject: "Resume",
    fromEmail: "candidate@example.com",
    fromName: "Candidate",
    bodyPlainText: "hello resume",
    attachments: [{ id: "att-1", filename: "resume.pdf", type: 1 }],
  });
});

test("fetchFeishuMinuteTranscript reads minute metadata and transcript", async () => {
  const calls = [];
  const event = {
    type: "minutes.minute.generated_v1",
    payload: {
      minute_token: "obcnq3b9jl72l83w4f14xxxx",
    },
  };

  const result = await fetchFeishuMinuteTranscript(
    {
      enabled: true,
      apiBase: "https://open.feishu.cn/open-apis",
      accessToken: "token",
    },
    event,
    {
      async fetch(url, options) {
        calls.push({ url, options });

        if (url.endsWith("/transcript?need_speaker=true&need_timestamp=true&file_format=txt")) {
          return new Response("00:00 Alice: hello", { status: 200 });
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
    },
  );

  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.headers.authorization, "Bearer token");
  assert.deepEqual(result, {
    kind: "feishu_minute",
    minuteToken: "obcnq3b9jl72l83w4f14xxxx",
    title: "Weekly Meeting",
    url: "https://example.feishu.cn/minutes/obcnq3b9jl72l83w4f14xxxx",
    noteId: "note-001",
    duration: "30000",
    transcript: "00:00 Alice: hello",
  });
});

test("enrichFeishuEvent skips when content fetching is disabled", async () => {
  const result = await enrichFeishuEvent(
    {
      type: "minutes.minute.generated_v1",
      payload: { minute_token: "obcnq3b9jl72l83w4f14xxxx" },
    },
    { enabled: false, accessToken: "token" },
  );

  assert.equal(result, null);
});
