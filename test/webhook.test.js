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
});
