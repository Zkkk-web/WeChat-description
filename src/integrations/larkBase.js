import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const READONLY_FIELDS = new Set(["created_at", "updated_at"]);
const UNSUPPORTED_FIELDS = new Set(["resume_attachment"]);
const TABLE_ALIASES = {
  邮件事件: "mailEvents",
  候选人: "candidates",
  客户列表: "clients",
  岗位: "jobs",
  猎头伙伴: "hunters",
  生态伙伴: "ecosystemPartners",
};

function trimSlash(value) {
  return value.replace(/\/+$/, "");
}

function toFeishuDateTime(value) {
  if (!value) {
    return "";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }

  return date.toISOString().slice(0, 19).replace("T", " ");
}

export function sanitizeFieldsForLark(fields) {
  const result = {};

  for (const [key, value] of Object.entries(fields)) {
    if (READONLY_FIELDS.has(key) || UNSUPPORTED_FIELDS.has(key) || value === undefined || value === null) {
      continue;
    }

    if (typeof value === "string" && value.length === 0) {
      continue;
    }

    result[key] = key.endsWith("_at") ? toFeishuDateTime(value) : value;
  }

  return result;
}

export function isLarkBaseEnabled(config) {
  if (!config?.enabled || !config.baseToken) {
    return false;
  }

  if (config.mode === "cli") {
    return Boolean(config.cliCommand);
  }

  return Boolean(config.appId && config.appSecret);
}

function tableIdFor(config, tableName) {
  const tableId = config.tables?.[tableName] ?? config.tables?.[TABLE_ALIASES[tableName]];

  if (!tableId) {
    throw new Error(`missing lark table id for ${tableName}`);
  }

  return tableId;
}

async function readJson(response) {
  const text = await response.text();

  if (!text) {
    return {};
  }

  return JSON.parse(text);
}

async function requestJson(fetchImpl, url, options) {
  const response = await fetchImpl(url, options);
  const body = await readJson(response);

  if (!response.ok || body.code !== 0) {
    const message = body.msg ?? body.message ?? response.statusText;
    throw new Error(`lark api failed ${body.code ?? response.status}: ${message}`);
  }

  return body;
}

async function getTenantAccessToken(config, fetchImpl) {
  const body = await requestJson(fetchImpl, `${trimSlash(config.apiBase)}/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      app_id: config.appId,
      app_secret: config.appSecret,
    }),
  });

  return body.tenant_access_token;
}

async function createRecord(config, fetchImpl, token, write) {
  const tableId = tableIdFor(config, write.table);
  const fields = sanitizeFieldsForLark(write.fields);
  const body = await requestJson(
    fetchImpl,
    `${trimSlash(config.apiBase)}/bitable/v1/apps/${config.baseToken}/tables/${tableId}/records`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ fields }),
    },
  );

  return {
    table: write.table,
    recordId: body.data?.record?.record_id ?? "",
  };
}

async function updateRecord(config, fetchImpl, token, write) {
  const tableId = tableIdFor(config, write.table);
  const fields = sanitizeFieldsForLark(write.fields);
  const body = await requestJson(
    fetchImpl,
    `${trimSlash(config.apiBase)}/bitable/v1/apps/${config.baseToken}/tables/${tableId}/records/${write.recordId}`,
    {
      method: "PUT",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ fields }),
    },
  );

  return {
    table: write.table,
    recordId: body.data?.record?.record_id ?? write.recordId,
  };
}

async function findRecord(config, fetchImpl, token, tableName, fieldName, value, fieldNames = [fieldName]) {
  if (!value) {
    return null;
  }

  const tableId = tableIdFor(config, tableName);
  const body = await requestJson(
    fetchImpl,
    `${trimSlash(config.apiBase)}/bitable/v1/apps/${config.baseToken}/tables/${tableId}/records/search`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        page_size: 1,
        field_names: fieldNames,
        filter: {
          conjunction: "and",
          conditions: [{ field_name: fieldName, operator: "is", value: [value] }],
        },
      }),
    },
  );

  const record = body.data?.items?.[0] ?? body.data?.records?.[0];

  return record ? { recordId: record.record_id, fields: record.fields ?? {} } : null;
}

function recordIdFromCliOutput(stdout) {
  if (!stdout.trim()) {
    return "";
  }

  const body = JSON.parse(stdout);
  return body.data?.record?.record_id ?? body.record?.record_id ?? body.record_id ?? "";
}

function describeCliError(error) {
  const details = [
    error.message,
    error.code ? `code=${error.code}` : "",
    error.killed ? "killed=true" : "",
    error.signal ? `signal=${error.signal}` : "",
    error.stderr ? `stderr=${String(error.stderr).slice(0, 500)}` : "",
  ].filter(Boolean);

  return details.join(" ");
}

async function createRecordWithCli(config, write, options) {
  const tableId = tableIdFor(config, write.table);
  const fields = sanitizeFieldsForLark(write.fields);
  const execImpl = options.execFile ?? execFileAsync;
  const jsonFile = await writeCliJsonFile(fields);
  const larkArgs = [
    "base",
    "+record-upsert",
    "--as",
    config.cliAs ?? "user",
    "--base-token",
    config.baseToken,
    "--table-id",
    tableId,
    ...(write.recordId ? ["--record-id", write.recordId] : []),
    "--json",
    `@${jsonFile.argPath}`,
    "--format",
    "json",
  ];
  const invocation = resolveCliInvocation(config.cliCommand ?? "lark-cli", larkArgs);

  try {
    const { stdout } = await execImpl(invocation.command, invocation.args, {
      windowsHide: true,
      timeout: config.cliTimeoutMs ?? 20000,
    });

    return {
      table: write.table,
      recordId: recordIdFromCliOutput(stdout),
    };
  } catch (error) {
    throw new Error(`lark-cli write failed for ${write.table}: ${describeCliError(error)}`);
  } finally {
    await rm(jsonFile.cleanupPath, { force: true });
  }
}

async function writeCliJsonFile(payload) {
  const relativeDir = join(".codex-tmp", "lark-cli-json");
  const fileName = `${randomUUID()}.json`;
  const argPath = join(relativeDir, fileName);
  const cleanupPath = join(process.cwd(), argPath);

  await mkdir(join(process.cwd(), relativeDir), { recursive: true });
  await writeFile(cleanupPath, JSON.stringify(payload), "utf8");

  return { argPath, cleanupPath };
}

function resolveCliInvocation(command, args) {
  if (process.platform !== "win32") {
    return { command, args };
  }

  if (command.toLowerCase().endsWith(".ps1")) {
    return powerShellInvocation(command, args);
  }

  if (command.toLowerCase() === "lark-cli.cmd" && process.env.APPDATA) {
    return cmdInvocation(join(process.env.APPDATA, "npm", "lark-cli.cmd"), args);
  }

  if (command.toLowerCase().endsWith(".cmd") || command.toLowerCase().endsWith(".bat")) {
    return cmdInvocation(command, args);
  }

  if (command === "lark-cli") {
    return powerShellCommandInvocation(args);
  }

  return { command, args };
}

function powerShellInvocation(scriptPath, args) {
  return {
    command: "powershell.exe",
    args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath, ...args],
  };
}

function cmdInvocation(command, args) {
  return {
    command: "cmd.exe",
    args: ["/d", "/s", "/c", [command, ...args].map(quoteCmdArg).join(" ")],
  };
}

function quoteCmdArg(value) {
  const text = String(value);

  if (!/[()\s^&|<>"]/.test(text)) {
    return text;
  }

  return `"${text.replaceAll('"', '\\"')}"`;
}

function powerShellCommandInvocation(args) {
  const npmBin = process.env.APPDATA ? join(process.env.APPDATA, "npm") : "";
  const pathSetup = npmBin ? `$env:Path = ${quotePowerShellArg(`${npmBin};`)} + $env:Path; ` : "";

  return {
    command: "powershell.exe",
    args: [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      `$ErrorActionPreference = 'Stop'; ${pathSetup}& lark-cli ${args.map(quotePowerShellArg).join(" ")}`,
    ],
  };
}

function quotePowerShellArg(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function clientLookupFields(fields) {
  return [
    ["邮箱", fields["邮箱"]],
    ["客户名称", fields["客户名称"]],
  ].filter(([, value]) => value);
}

function withLinkedClient(write, clientRecordId) {
  if (write.table !== "岗位" || !clientRecordId) {
    return write;
  }

  return {
    ...write,
    fields: {
      ...write.fields,
      关联客户: [{ id: clientRecordId }],
    },
  };
}

async function upsertClientWithCli(config, write, options) {
  for (const [fieldName, value] of clientLookupFields(write.fields)) {
    const existing = await findRecordWithCli(config, write.table, fieldName, value, [fieldName], options);

    if (existing) {
      return createRecordWithCli(config, { ...write, recordId: existing.recordId }, options);
    }
  }

  return createRecordWithCli(config, write, options);
}

async function upsertClient(config, fetchImpl, token, write) {
  for (const [fieldName, value] of clientLookupFields(write.fields)) {
    const existing = await findRecord(config, fetchImpl, token, write.table, fieldName, value, [fieldName]);

    if (existing) {
      return updateRecord(config, fetchImpl, token, { ...write, recordId: existing.recordId });
    }
  }

  return createRecord(config, fetchImpl, token, write);
}

export async function writePlannedWrites(config, plannedWrites, options = {}) {
  if (!isLarkBaseEnabled(config)) {
    return [];
  }

  if (config.mode === "cli") {
    const results = [];
    let clientRecordId = "";

    for (const write of plannedWrites) {
      const actualWrite = withLinkedClient(write, clientRecordId);
      const result =
        actualWrite.table === "客户列表"
          ? await upsertClientWithCli(config, actualWrite, options)
          : await createRecordWithCli(config, actualWrite, options);

      if (actualWrite.table === "客户列表") {
        clientRecordId = result.recordId;
      }

      results.push(result);
    }

    return results;
  }

  const fetchImpl = options.fetch ?? globalThis.fetch;

  if (!fetchImpl) {
    throw new Error("fetch is not available");
  }

  const token = await getTenantAccessToken(config, fetchImpl);
  const results = [];
  let clientRecordId = "";

  for (const write of plannedWrites) {
    const actualWrite = withLinkedClient(write, clientRecordId);
    const result =
      actualWrite.table === "客户列表"
        ? await upsertClient(config, fetchImpl, token, actualWrite)
        : await createRecord(config, fetchImpl, token, actualWrite);

    if (actualWrite.table === "客户列表") {
      clientRecordId = result.recordId;
    }

    results.push(result);
  }

  return results;
}

function recordsFromCliOutput(stdout) {
  if (!stdout.trim()) {
    return [];
  }

  const body = JSON.parse(stdout);
  const records = body.data?.items ?? body.data?.records ?? body.items ?? body.records;

  if (records) {
    return records;
  }

  const recordIds = body.data?.record_id_list;
  const rows = body.data?.data;

  if (!Array.isArray(recordIds) || !Array.isArray(rows)) {
    return [];
  }

  return recordIds.map((recordId, index) => ({
    record_id: recordId,
    fields: Object.fromEntries((body.data?.fields ?? []).map((field, fieldIndex) => [field, rows[index]?.[fieldIndex]])),
  }));
}

async function findRecordWithCli(config, tableName, fieldName, value, fieldNames, options) {
  const tableId = tableIdFor(config, tableName);
  const execImpl = options.execFile ?? execFileAsync;
  const filterFile = await writeCliJsonFile({
    logic: "and",
    conditions: [[fieldName, "==", value]],
  });
  const larkArgs = [
    "base",
    "+record-list",
    "--as",
    config.cliAs ?? "user",
    "--base-token",
    config.baseToken,
    "--table-id",
    tableId,
    ...fieldNames.flatMap((field) => ["--field-id", field]),
    "--filter-json",
    `@${filterFile.argPath}`,
    "--limit",
    "1",
    "--format",
    "json",
  ];
  const invocation = resolveCliInvocation(config.cliCommand ?? "lark-cli", larkArgs);

  try {
    const { stdout } = await execImpl(invocation.command, invocation.args, {
      windowsHide: true,
      timeout: config.cliTimeoutMs ?? 20000,
    });

    const record = recordsFromCliOutput(stdout)[0];
    return record ? { recordId: record.record_id, fields: record.fields ?? {} } : null;
  } catch (error) {
    throw new Error(`lark-cli read failed for ${tableName}: ${describeCliError(error)}`);
  } finally {
    await rm(filterFile.cleanupPath, { force: true });
  }
}

async function recordExistsWithCli(config, tableName, fieldName, value, options) {
  return Boolean(await findRecordWithCli(config, tableName, fieldName, value, [fieldName], options));
}

export async function mailEventExists(config, messageId, options = {}) {
  if (!isLarkBaseEnabled(config)) {
    return false;
  }

  if (config.mode !== "cli") {
    return false;
  }

  return recordExistsWithCli(config, "邮件事件", "邮件ID", messageId, options);
}
