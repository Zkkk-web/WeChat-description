import { json } from "../http.js";

export function healthRoute() {
  return {
    method: "GET",
    path: "/health",
    handler(_req, res) {
      json(res, 200, {
        ok: true,
        service: "headhunter-agent-backend",
        status: "healthy",
      });
    },
  };
}
