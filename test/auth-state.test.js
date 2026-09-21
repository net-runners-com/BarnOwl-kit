"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const STATE = fs.mkdtempSync(path.join(os.tmpdir(), "barnowl-authstate-"));
process.env.BARNOWL_STATE_DIR = STATE;
const auth = require("../lib/auth-state.cjs");
const { writeCatalog, readCatalog, catalogPath } = require("../lib/model-catalog.cjs");

const FILE = catalogPath();
const ids = (models) => models.map((m) => m.id);
const STATIC = () => [
  { id: "sonnet", label: "s", contextWindow: 200000 },
  { id: "claude-opus-5", label: "o", contextWindow: 200000 },
  { id: "codex", label: "c", contextWindow: 272000 },
  { id: "gpt-5.5", label: "g", contextWindow: 272000 },
];
const cat = (providers) => ({ version: 1, refreshedAt: "t", providers });
const m = (id) => ({ id, label: id, contextWindow: 1 });

test.beforeEach(() => {
  auth._reset();
  fs.rmSync(FILE, { force: true });
});
test.after(() => fs.rmSync(STATE, { recursive: true, force: true }));

test("no catalog file: MODELS untouched", () => {
  const models = STATIC();
  auth.bind(models, { watch: false });
  assert.deepEqual(ids(models), ["sonnet", "claude-opus-5", "codex", "gpt-5.5"]);
});

test("catalog lists replace MODELS in place (same array)", () => {
  writeCatalog(cat({
    claude: { status: "ok", models: [m("sonnet"), m("claude-fable-5-1")] },
    codex: { status: "ok", models: [m("codex"), m("gpt-5.6-terra")] },
  }), FILE);
  const models = STATIC();
  const same = models;
  auth.bind(models, { watch: false });
  assert.equal(models, same);
  assert.deepEqual(ids(models), ["sonnet", "claude-fable-5-1", "codex", "gpt-5.6-terra"]);
});

test("revoked / logged_out hide a provider; absent or model-less keeps static entries", () => {
  writeCatalog(cat({ claude: { status: "revoked", models: [m("sonnet")] } }), FILE);
  let models = STATIC();
  auth.bind(models, { watch: false });
  assert.deepEqual(ids(models), ["codex", "gpt-5.5"]);

  auth._reset();
  writeCatalog(cat({ claude: { status: "ok" }, codex: { status: "logged_out" } }), FILE);
  models = STATIC();
  auth.bind(models, { watch: false });
  assert.deepEqual(ids(models), ["sonnet", "claude-opus-5"]);
});

test("onAuthFailure hides the provider and writes only on the transition", () => {
  const models = STATIC();
  auth.bind(models, { watch: false });
  assert.equal(auth.onAuthFailure("claude", "401 revoked"), true);
  assert.deepEqual(ids(models), ["codex", "gpt-5.5"]);
  assert.equal(auth.statusOf("claude"), "revoked");
  assert.equal(auth.onAuthFailure("claude", "401 again"), false);
  assert.equal(readCatalog(FILE).providers.claude.message, "401 revoked");
});

test("onAuthSuccess restores the last known models", () => {
  writeCatalog(cat({ claude: { status: "revoked", models: [m("sonnet"), m("claude-fable-5-1")] } }), FILE);
  const models = STATIC();
  auth.bind(models, { watch: false });
  assert.deepEqual(ids(models), ["codex", "gpt-5.5"]);
  assert.equal(auth.onAuthSuccess("claude"), true);
  assert.deepEqual(ids(models), ["sonnet", "claude-fable-5-1", "codex", "gpt-5.5"]);
  assert.equal(auth.onAuthSuccess("claude"), false);
  assert.equal(auth.onAuthSuccess("codex"), false); // never revoked → no write
});

test("hooks work without bind (read the file each call)", () => {
  assert.equal(auth.onAuthFailure("codex", "Please log out and sign in again."), true);
  assert.equal(readCatalog(FILE).providers.codex.status, "revoked");
  assert.equal(auth.onAuthSuccess("codex"), true);
  assert.equal(readCatalog(FILE).providers.codex.status, "ok");
});

test("watch: an external write is applied", async () => {
  const models = STATIC();
  auth.bind(models, { watch: true });
  await new Promise((r) => setTimeout(r, 50));
  writeCatalog(cat({ codex: { status: "revoked" } }), FILE);
  const deadline = Date.now() + 6000;
  while (ids(models).includes("codex") && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(ids(models), ["sonnet", "claude-opus-5"]);
});
