import { json, readJson } from "../http.js";

function normalizeEvent(body) {
  return {
    source: body.source ?? "unknown",
    type: body.type ?? "unknown",
    receivedAt: new Date().toISOString(),
    payload: body.payload ?? body,
  };
}

export function webhookRoute() {
  return {
    method: "POST",
    path: "/webhook",
    async handler(req, res) {
      const body = await readJson(req);
      const event = normalizeEvent(body);

      json(res, 202, {
        ok: true,
        accepted: true,
        event,
      });
    },
  };
}
