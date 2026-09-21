"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const STATE = fs.mkdtempSync(path.join(os.tmpdir(), "barnowl-codexauth-"));
process.env.BARNOWL_STATE_DIR = STATE;
const BIN = path.join(STATE, "fake-codex");
// Minimal `codex exec` stand-in. FAKE_CODEX_MODE=revoked replays the stderr a
// dead ChatGPT login produced on 2026-09-21; crash fails for another reason.
fs.writeFileSync(BIN, `#!/usr/bin/env node
const args = process.argv.slice(2);
process.stdin.resume();
process.stdin.on("data", () => {});
process.stdin.on("end", () => {
  const mode = process.env.FAKE_CODEX_MODE;
  if (mode === "revoked") {
    process.stderr.write("ERROR codex_login::auth::manager: Failed to refresh token: 401 Unauthorized\\n");
    process.stderr.write("ERROR: Your access token could not be refreshed. Please log out and sign in again.\\n");
    process.exit(1);
  }
  if (mode === "crash") {
    process.stderr.write("boom\\n");
    process.exit(2);
  }
  require("fs").writeFileSync(args[args.indexOf("-o") + 1], "ok");
  process.exit(0);
});
`, { mode: 0o755 });
process.env.BARNOWL_CODEX_BIN = BIN;

const { CodexEngine } = require("../lib/codex-engine.cjs");
const { readCatalog, catalogPath } = require("../lib/model-catalog.cjs");
const codexStatus = () => {
  const c = readCatalog(catalogPath());
  return c && c.providers.codex ? c.providers.codex.status : null;
};

test.after(() => fs.rmSync(STATE, { recursive: true, force: true }));

test("dead login → authError(codex) and codex marked revoked", async () => {
  process.env.FAKE_CODEX_MODE = "revoked";
  await assert.rejects(new CodexEngine().run("hi", { model: "gpt-5.5" }), (e) => {
    assert.equal(e.barnowlCode, "NOT_AUTHENTICATED");
    assert.match(e.message, /Codex authentication failed .*barnowl login codex/);
    return true;
  });
  assert.equal(codexStatus(), "revoked");
});

test("success flips codex back to ok", async () => {
  process.env.FAKE_CODEX_MODE = "";
  const result = await new CodexEngine().run("hi", { model: "gpt-5.5" });
  assert.equal(result.text, "ok");
  assert.equal(codexStatus(), "ok");
});

test("other failures stay plain errors and leave the status alone", async () => {
  process.env.FAKE_CODEX_MODE = "crash";
  await assert.rejects(new CodexEngine().run("hi", { model: "gpt-5.5" }), (e) => {
    assert.equal(e.barnowlCode, undefined);
    assert.match(e.message, /codex exec failed \(exit 2\): boom/);
    return true;
  });
  assert.equal(codexStatus(), "ok");
});
