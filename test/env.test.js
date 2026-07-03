import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadEnvFile } from "../src/env.js";

test("loadEnvFile reads simple key values without overriding existing env", () => {
  const dir = mkdtempSync(join(tmpdir(), "headhunter-env-"));
  const file = join(dir, ".env.local");
  const env = { EXISTING: "keep" };

  writeFileSync(
    file,
    [
      "# comment",
      "IMAP_HOST=imap.163.com",
      'IMAP_PASSWORD="secret value"',
      "EXISTING=replace",
      "",
    ].join("\n"),
  );

  try {
    assert.equal(loadEnvFile(file, env), true);
    assert.equal(env.IMAP_HOST, "imap.163.com");
    assert.equal(env.IMAP_PASSWORD, "secret value");
    assert.equal(env.EXISTING, "keep");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
