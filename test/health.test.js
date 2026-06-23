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

test("GET /health reports healthy service", async () => {
  const response = await fetch(`${baseUrl}/health`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.status, "healthy");
});
