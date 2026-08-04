import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { sendFeishuText } from "./feishuWebhook.js";

const execFileAsync = promisify(execFile);

export async function sendArticlePush(config, text, deps = {}) {
  if (config.feishuWebhookUrl) {
    return sendFeishuText(config.feishuWebhookUrl, text, { fetch: deps.fetch });
  }

  if (config.feishuChatId) {
    return sendFeishuChatText(config, text, deps);
  }

  throw new Error("missing Feishu article push target");
}

export async function sendFeishuChatText(config, text, deps = {}) {
  if (config.larkAppId && config.larkAppSecret) {
    return sendFeishuChatTextWithApp(config, text, deps);
  }

  const execImpl = deps.execFile ?? execFileAsync;
  const args = [
    "im",
    "+messages-send",
    "--chat-id",
    config.feishuChatId,
    "--text",
    text,
    "--as",
    config.larkCliAs ?? "user",
    "--format",
    "json",
  ];
  appendProfile(args, config.larkCliProfile);
  const invocation = resolveCliInvocation(config.larkCliCommand ?? "lark-cli.cmd", args);

  const { stdout } = await execImpl(invocation.command, invocation.args, {
    windowsHide: true,
    timeout: config.larkCliTimeoutMs ?? 20000,
  });
  const body = JSON.parse(stdout || "{}");

  if (body.ok === false) {
    throw new Error(`lark-cli message send failed: ${body.error?.message ?? "unknown error"}`);
  }

  return body;
}

export async function sendFeishuChatTextWithApp(config, text, deps = {}) {
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const apiBase = (config.larkApiBase ?? "https://open.feishu.cn/open-apis").replace(/\/+$/, "");
  const token = await getTenantAccessToken({ ...config, apiBase }, { fetch: fetchImpl });
  const response = await fetchImpl(`${apiBase}/im/v1/messages?receive_id_type=chat_id`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({
      receive_id: config.feishuChatId,
      msg_type: "text",
      content: JSON.stringify({ text }),
    }),
  });
  const body = await safeJson(response);
  if (!response.ok || body.code !== 0) {
    throw new Error(`Feishu app message send failed: ${response.status} ${body.msg ?? body.message ?? "unknown"}`);
  }
  return body;
}

async function getTenantAccessToken(config, deps = {}) {
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const response = await fetchImpl(`${config.apiBase}/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      app_id: config.larkAppId,
      app_secret: config.larkAppSecret,
    }),
  });
  const body = await safeJson(response);
  const token = body.tenant_access_token;
  if (!response.ok || body.code !== 0 || !token) {
    throw new Error(`Feishu tenant token failed: ${response.status} ${body.msg ?? body.message ?? "unknown"}`);
  }
  return token;
}

async function safeJson(response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { raw: text };
  }
}

export async function sendFeishuChatInteractiveCard(config, card, deps = {}) {
  const execImpl = deps.execFile ?? execFileAsync;
  const args = [
    "im",
    "+messages-send",
    "--chat-id",
    config.feishuChatId,
    "--msg-type",
    "interactive",
    "--content",
    JSON.stringify(card),
    "--as",
    config.larkCliAs ?? "user",
    "--format",
    "json",
  ];
  appendProfile(args, config.larkCliProfile);
  const invocation = resolveCliInvocation(config.larkCliCommand ?? "lark-cli.cmd", args);

  const { stdout } = await execImpl(invocation.command, invocation.args, {
    windowsHide: true,
    timeout: config.larkCliTimeoutMs ?? 20000,
  });
  const body = JSON.parse(stdout || "{}");

  if (body.ok === false) {
    throw new Error(`lark-cli card send failed: ${body.error?.message ?? "unknown error"}`);
  }

  return body;
}

export async function uploadFeishuImageFromUrl(config, imageUrl, deps = {}) {
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const execImpl = deps.execFile ?? execFileAsync;
  const response = await fetchImpl(imageUrl);
  if (!response.ok) {
    throw new Error(`image download failed: ${response.status}`);
  }

  const dir = join(".codex-tmp", "feishu-image-upload");
  const filePath = join(dir, `avatar-${process.pid}-${Date.now()}.png`);
  const uploadPath = join(dir, `avatar-${process.pid}-${Date.now()}-small.png`);

  try {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0) {
      throw new Error("image download returned empty body");
    }

    await mkdir(dir, { recursive: true });
    await writeFile(filePath, bytes);
    const imagePath = await resizeImageForUpload(filePath, uploadPath);
    const args = [
      "im",
      "images",
      "create",
      "--data",
      JSON.stringify({ image_type: "message" }),
      "--file",
      `image=${imagePath}`,
      "--as",
      "bot",
      "--format",
      "json",
    ];
    appendProfile(args, config.larkCliProfile);
    const invocation = resolveCliInvocation(config.larkCliCommand ?? "lark-cli.cmd", args);
    const { stdout } = await execImpl(invocation.command, invocation.args, {
      windowsHide: true,
      timeout: config.larkCliTimeoutMs ?? 20000,
    });
    const body = JSON.parse(stdout || "{}");
    if (body.ok === false) {
      throw new Error(`lark-cli image upload failed: ${body.error?.message ?? "unknown error"}`);
    }

    return body.image_key ?? body.data?.image_key ?? "";
  } finally {
    await rm(filePath, { force: true });
    await rm(uploadPath, { force: true });
  }
}

async function resizeImageForUpload(sourcePath, targetPath) {
  if (process.platform !== "win32") return sourcePath;

  const script = `
& {
param([string]$src, [string]$dst)
Add-Type -AssemblyName System.Drawing
$img = [System.Drawing.Image]::FromFile((Resolve-Path -LiteralPath $src))
try {
  $bmp = New-Object System.Drawing.Bitmap 64, 64
  try {
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    try {
      $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $g.DrawImage($img, 0, 0, 64, 64)
      $bmp.Save((Resolve-Path -LiteralPath (Split-Path -Parent $dst)).Path + "\\" + (Split-Path -Leaf $dst), [System.Drawing.Imaging.ImageFormat]::Png)
    } finally {
      $g.Dispose()
    }
  } finally {
    $bmp.Dispose()
  }
} finally {
  $img.Dispose()
}
}
`;

  try {
    await execFileAsync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script, sourcePath, targetPath], {
      windowsHide: true,
      timeout: 15000,
    });
    return existsSync(targetPath) ? targetPath : sourcePath;
  } catch {
    return sourcePath;
  }
}

function resolveCliInvocation(command, args) {
  if (process.platform !== "win32") {
    return { command, args };
  }

  const lowerCommand = command.toLowerCase();
  if (lowerCommand.endsWith(".cmd") || lowerCommand.endsWith(".bat")) {
    const npmBin = process.env.APPDATA ? join(process.env.APPDATA, "npm") : "";
    const cliEntry = npmBin ? join(npmBin, "node_modules", "@larksuite", "cli", "scripts", "run.js") : "";

    if (lowerCommand === "lark-cli.cmd" && existsSync(cliEntry)) {
      return { command: process.execPath, args: [cliEntry, ...args] };
    }

    return { command: "cmd.exe", args: ["/d", "/s", "/c", command, ...args] };
  }

  return { command, args };
}

function appendProfile(args, profile) {
  if (!profile) return;
  args.push("--profile", profile);
}
