"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const mc = require("../lib/model-catalog.cjs");

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "barnowl-catalog-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const ids = (models) => models.map((m) => m.id);

// Trimmed from the live model-list answers on 2026-09-21.
const CLAUDE_API = [
  { id: "claude-fable-5-1", display_name: "Claude Fable 5.1", max_input_tokens: 200000 },
  { id: "claude-opus-5", display_name: "Claude Opus 5", max_input_tokens: 1000000 },
  { id: "claude-sonnet-5", display_name: "Claude Sonnet 5", max_input_tokens: 1000000 },
  { id: "claude-fable-5", display_name: "Claude Fable 5", max_input_tokens: 200000 },
  { id: "claude-haiku-4-5-20251001", display_name: "Claude Haiku 4.5", max_input_tokens: 200000 },
];
const CODEX_API = [
  { slug: "gpt-reserve", display_name: "GPT-Reserve", visibility: "hide", priority: 3, context_window: 272000 },
  { slug: "gpt-5.5", display_name: "GPT-5.5", visibility: "list", priority: 12, context_window: 272000 },
  { slug: "gpt-5.6-terra", display_name: "GPT-5.6-Terra", visibility: "list", priority: 7, context_window: 272000 },
  { slug: "gpt-5.6-luna", display_name: "GPT-5.6-Luna", visibility: "list", priority: 8, context_window: 272000 },
];

test("buildClaudeModels: aliases, API order, deprecated removed, [1m] variants", () => {
  const models = mc.buildClaudeModels(CLAUDE_API, ["claude-fable-5"]);
  assert.deepEqual(ids(models), [
    "sonnet", "opus", "haiku", "fable", "default",
    "claude-fable-5-1",
    "claude-opus-5", "claude-opus-5[1m]",
    "claude-sonnet-5", "claude-sonnet-5[1m]",
    "claude-haiku-4-5-20251001",
  ]);
  const byId = Object.fromEntries(models.map((m) => [m.id, m]));
  assert.equal(byId["claude-opus-5"].contextWindow, 200000);
  assert.equal(byId["claude-opus-5[1m]"].contextWindow, 1000000);
  assert.equal(byId["claude-opus-5[1m]"].label, "Claude Opus 5 (1M context)");
  assert.equal(byId["claude-fable-5-1"].label, "Claude Fable 5.1");
});

test("buildClaudeModels: an alias needs its family in the list; empty input → []", () => {
  const models = mc.buildClaudeModels([{ id: "claude-sonnet-5", display_name: "Claude Sonnet 5", max_input_tokens: 1000000 }]);
  assert.deepEqual(ids(models), ["sonnet", "default", "claude-sonnet-5", "claude-sonnet-5[1m]"]);
  assert.deepEqual(mc.buildClaudeModels([]), []);
  assert.deepEqual(mc.buildClaudeModels(undefined), []);
});

test("buildCodexModels: listed models by priority behind a codex alias", () => {
  const models = mc.buildCodexModels(CODEX_API);
  assert.deepEqual(ids(models), ["codex", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5"]);
  assert.equal(models[1].label, "Codex GPT-5.6-Terra");
  assert.equal(models[0].contextWindow, 272000);
  assert.deepEqual(mc.buildCodexModels([]), []);
});

test("catalog path follows BARNOWL_STATE_DIR", () => {
  assert.equal(mc.catalogPath({ BARNOWL_STATE_DIR: "/tmp/x" }), path.resolve("/tmp/x/catalog.json"));
  assert.equal(mc.catalogPath({}), path.join(os.homedir(), ".barnowl", "catalog.json"));
});

test("writeCatalog/readCatalog round-trip atomically", (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, "nested", "catalog.json");
  const cat = { version: 1, refreshedAt: "x", providers: { claude: { status: "ok", checkedAt: "x", message: "" } } };
  mc.writeCatalog(cat, file);
  assert.deepEqual(mc.readCatalog(file), cat);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ["catalog.json"]); // no tmp file left behind
});

test("readCatalog: missing or invalid file → null", (t) => {
  const dir = tmpDir(t);
  assert.equal(mc.readCatalog(path.join(dir, "none.json")), null);
  fs.writeFileSync(path.join(dir, "bad.json"), "{nope");
  assert.equal(mc.readCatalog(path.join(dir, "bad.json")), null);
});

test("markStatus creates the file, reports changes only, keeps models", (t) => {
  const file = path.join(tmpDir(t), "catalog.json");
  assert.equal(mc.markStatus("claude", "revoked", "401", file, 0), true);
  assert.equal(mc.readCatalog(file).providers.claude.status, "revoked");
  assert.equal(mc.markStatus("claude", "revoked", "401", file, 1), false);
  const cat = mc.readCatalog(file);
  cat.providers.claude.models = [{ id: "sonnet", label: "S", contextWindow: 200000 }];
  mc.writeCatalog(cat, file);
  assert.equal(mc.markStatus("claude", "ok", "", file, 2), true);
  const after = mc.readCatalog(file).providers.claude;
  assert.equal(after.status, "ok");
  assert.deepEqual(ids(after.models), ["sonnet"]);
  assert.equal(after.checkedAt, new Date(2).toISOString());
});

test("summarize: counts visible models; hidden → 0; no models → null", () => {
  const s = mc.summarize({
    version: 1,
    providers: {
      claude: { status: "revoked", message: "401", checkedAt: "t", models: [{ id: "a" }] },
      codex: { status: "ok", message: "", checkedAt: "t" },
    },
  });
  assert.deepEqual(s.claude, { status: "revoked", count: 0, message: "401", checkedAt: "t" });
  assert.deepEqual(s.codex, { status: "ok", count: null, message: "", checkedAt: "t" });
  assert.equal(mc.summarize(null).claude.status, "unknown");
});
