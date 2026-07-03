import assert from "node:assert/strict";
import { test } from "node:test";
import { mailEventExists, sanitizeFieldsForLark, writePlannedWrites } from "../src/integrations/larkBase.js";

test("sanitizeFieldsForLark removes unsupported fields and formats dates", () => {
  assert.deepEqual(
    sanitizeFieldsForLark({
      message_id: "m1",
      received_at: "2026-06-26T03:04:05.000Z",
      email: "",
      resume_attachment: "resume.pdf",
      created_at: "readonly",
    }),
    {
      message_id: "m1",
      received_at: "2026-06-26 03:04:05",
    },
  );
});

test("writePlannedWrites creates records in Feishu Base tables", async () => {
  const calls = [];
  const config = {
    enabled: true,
    apiBase: "https://open.feishu.cn/open-apis",
    appId: "app-id",
    appSecret: "app-secret",
    baseToken: "base-token",
    tables: {
      邮件事件: "table-mail",
      候选人: "table-candidate",
    },
  };

  const results = await writePlannedWrites(
    config,
    [
      { table: "邮件事件", fields: { 邮件ID: "m1", 收信时间: "2026-06-26T03:04:05.000Z" } },
      { table: "候选人", fields: { "姓名 & 昵称": "张三", 邮箱: "candidate@example.com" } },
    ],
    {
      async fetch(url, options) {
        calls.push({ url, options });

        if (url.endsWith("/auth/v3/tenant_access_token/internal")) {
          return new Response(JSON.stringify({ code: 0, tenant_access_token: "token" }), { status: 200 });
        }

        return new Response(JSON.stringify({ code: 0, data: { record: { record_id: `rec-${calls.length}` } } }), {
          status: 200,
        });
      },
    },
  );

  assert.equal(calls.length, 3);
  assert.equal(
    calls[1].url,
    "https://open.feishu.cn/open-apis/bitable/v1/apps/base-token/tables/table-mail/records",
  );
  assert.equal(
    calls[2].url,
    "https://open.feishu.cn/open-apis/bitable/v1/apps/base-token/tables/table-candidate/records",
  );
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    fields: { 邮件ID: "m1", 收信时间: "2026-06-26T03:04:05.000Z" },
  });
  assert.deepEqual(results, [
    { table: "邮件事件", recordId: "rec-2" },
    { table: "候选人", recordId: "rec-3" },
  ]);
});

test("writePlannedWrites can create records with lark-cli user identity", async () => {
  const calls = [];
  const config = {
    enabled: true,
    mode: "cli",
    cliCommand: "lark-cli",
    cliAs: "user",
    baseToken: "base-token",
    tables: {
      邮件事件: "table-mail",
    },
  };

  const results = await writePlannedWrites(
    config,
    [{ table: "邮件事件", fields: { 邮件ID: "m1", 收信时间: "2026-06-26T03:04:05.000Z" } }],
    {
      async execFile(command, args, options) {
        calls.push({ command, args, options });
        return { stdout: JSON.stringify({ data: { record: { record_id: "rec-cli" } } }) };
      },
    },
  );

  assert.equal(calls[0].command, "powershell.exe");
  assert.deepEqual(calls[0].args.slice(0, 4), ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command"]);
  assert.match(calls[0].args[4], /& lark-cli 'base' '\+record-upsert'/);
  assert.match(calls[0].args[4], /'--json' '@[^']+\.json'/);
  assert.deepEqual(results, [{ table: "邮件事件", recordId: "rec-cli" }]);
});

test("writePlannedWrites can execute a PowerShell lark-cli shim on Windows", async () => {
  const previousPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  const previousAppData = process.env.APPDATA;

  Object.defineProperty(process, "platform", { value: "win32" });
  process.env.APPDATA = "C:\\Users\\tester\\AppData\\Roaming";

  try {
    const calls = [];
    const config = {
      enabled: true,
      mode: "cli",
      cliCommand: "C:\\Users\\tester\\AppData\\Roaming\\npm\\lark-cli.ps1",
      cliAs: "user",
      baseToken: "base-token",
      tables: {
        邮件事件: "table-mail",
      },
    };

    await writePlannedWrites(
      config,
      [{ table: "邮件事件", fields: { 邮件ID: "m1" } }],
      {
        async execFile(command, args) {
          calls.push({ command, args });
          return { stdout: JSON.stringify({ data: { record: { record_id: "rec-cli" } } }) };
        },
      },
    );

    assert.equal(calls[0].command, "powershell.exe");
    assert.deepEqual(calls[0].args.slice(0, 5), [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      "C:\\Users\\tester\\AppData\\Roaming\\npm\\lark-cli.ps1",
    ]);
    assert.deepEqual(calls[0].args.slice(5, 13), [
      "base",
      "+record-upsert",
      "--as",
      "user",
      "--base-token",
      "base-token",
      "--table-id",
      "table-mail",
    ]);
    assert.match(calls[0].args[14], /^@.+\.json$/);
  } finally {
    if (previousPlatform) {
      Object.defineProperty(process, "platform", previousPlatform);
    }
    process.env.APPDATA = previousAppData;
  }
});

test("writePlannedWrites can execute a Windows cmd shim", async () => {
  const previousPlatform = Object.getOwnPropertyDescriptor(process, "platform");

  Object.defineProperty(process, "platform", { value: "win32" });

  try {
    const calls = [];
    const config = {
      enabled: true,
      mode: "cli",
      cliCommand: "C:\\Users\\tester\\AppData\\Roaming\\npm\\lark-cli.cmd",
      cliAs: "user",
      baseToken: "base-token",
      tables: {
        邮件事件: "table-mail",
      },
    };

    await writePlannedWrites(
      config,
      [{ table: "邮件事件", fields: { 邮件ID: "m1" } }],
      {
        async execFile(command, args) {
          calls.push({ command, args });
          return { stdout: JSON.stringify({ data: { record: { record_id: "rec-cli" } } }) };
        },
      },
    );

    assert.equal(calls[0].command, "cmd.exe");
    assert.deepEqual(calls[0].args.slice(0, 3), ["/d", "/s", "/c"]);
    assert.match(calls[0].args[3], /lark-cli\.cmd base \+record-upsert/);
    assert.match(calls[0].args[3], /--json @\.codex-tmp[\\/]lark-cli-json[\\/][^ ]+\.json/);
  } finally {
    if (previousPlatform) {
      Object.defineProperty(process, "platform", previousPlatform);
    }
  }
});

test("mailEventExists reads Feishu Base mail event records with lark-cli", async () => {
  const calls = [];
  const config = {
    enabled: true,
    mode: "cli",
    cliCommand: "lark-cli",
    cliAs: "user",
    baseToken: "base-token",
    tables: {
      邮件事件: "table-mail",
    },
  };

  const exists = await mailEventExists(config, "<mail-7@example.com>", {
    async execFile(command, args, options) {
      calls.push({ command, args, options });
      return { stdout: JSON.stringify({ data: { items: [{ record_id: "rec-1", fields: { 邮件ID: "<mail-7@example.com>" } }] } }) };
    },
  });

  assert.equal(exists, true);
  assert.equal(calls[0].command, "powershell.exe");
  assert.match(calls[0].args[4], /& lark-cli 'base' '\+record-list'/);
  assert.match(calls[0].args[4], /'--field-id' '邮件ID'/);
  assert.match(calls[0].args[4], /'--filter-json' '@[^']+\.json'/);
});

test("writePlannedWrites reuses existing client and links new job with lark-cli", async () => {
  const calls = [];
  const config = {
    enabled: true,
    mode: "cli",
    cliCommand: "lark-cli",
    cliAs: "user",
    baseToken: "base-token",
    tables: {
      客户列表: "table-client",
      岗位: "table-job",
    },
  };

  const results = await writePlannedWrites(
    config,
    [
      { table: "客户列表", fields: { 客户名称: "百纯", 邮箱: "client@example.com" } },
      { table: "岗位", fields: { 岗位名称: "AI 产品经理" } },
    ],
    {
      async execFile(command, args) {
        calls.push({ command, args });
        const callIndex = calls.length;
        const commandText = args.join(" ");

        if (commandText.includes("+record-list")) {
          return {
            stdout: JSON.stringify({
              data: {
                record_id_list: ["rec-client"],
                fields: ["邮箱"],
                data: [["client@example.com"]],
              },
            }),
          };
        }

        if (callIndex === 2) {
          return { stdout: JSON.stringify({ data: { record: { record_id: "rec-client" } } }) };
        }

        return { stdout: JSON.stringify({ data: { record: { record_id: "rec-job" } } }) };
      },
    },
  );

  assert.deepEqual(results, [
    { table: "客户列表", recordId: "rec-client" },
    { table: "岗位", recordId: "rec-job" },
  ]);
  assert.match(calls[1].args.join(" "), /record-id.*rec-client/);
});

test("writePlannedWrites reuses existing client and links new job with app API", async () => {
  const calls = [];
  const config = {
    enabled: true,
    mode: "app",
    apiBase: "https://open.feishu.cn/open-apis",
    appId: "app-id",
    appSecret: "app-secret",
    baseToken: "base-token",
    tables: {
      客户列表: "table-client",
      岗位: "table-job",
    },
  };

  const results = await writePlannedWrites(
    config,
    [
      { table: "客户列表", fields: { 客户名称: "百纯", 邮箱: "client@example.com" } },
      { table: "岗位", fields: { 岗位名称: "AI 产品经理" } },
    ],
    {
      async fetch(url, options) {
        calls.push({ url, options });

        if (url.endsWith("/auth/v3/tenant_access_token/internal")) {
          return new Response(JSON.stringify({ code: 0, tenant_access_token: "token" }), { status: 200 });
        }

        if (url.endsWith("/records/search")) {
          return new Response(JSON.stringify({ code: 0, data: { items: [{ record_id: "rec-client", fields: {} }] } }), {
            status: 200,
          });
        }

        if (url.includes("/tables/table-client/records/rec-client")) {
          return new Response(JSON.stringify({ code: 0, data: { record: { record_id: "rec-client" } } }), {
            status: 200,
          });
        }

        return new Response(JSON.stringify({ code: 0, data: { record: { record_id: "rec-job" } } }), { status: 200 });
      },
    },
  );

  const jobCreateBody = JSON.parse(calls.at(-1).options.body);

  assert.deepEqual(results, [
    { table: "客户列表", recordId: "rec-client" },
    { table: "岗位", recordId: "rec-job" },
  ]);
  assert.deepEqual(jobCreateBody.fields["关联客户"], [{ id: "rec-client" }]);
});
