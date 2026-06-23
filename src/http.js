import { createServer } from "node:http";

export function json(res, statusCode, body) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

export function notFound(res) {
  json(res, 404, { ok: false, error: "not_found" });
}

export async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (raw.length === 0) {
    return {};
  }

  return JSON.parse(raw);
}

export function createApp(routes) {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const route = routes.find((item) => item.method === req.method && item.path === url.pathname);

    if (!route) {
      notFound(res);
      return;
    }

    try {
      await route.handler(req, res);
    } catch (error) {
      json(res, 500, {
        ok: false,
        error: "internal_error",
        message: error instanceof Error ? error.message : "unknown error",
      });
    }
  });
}
