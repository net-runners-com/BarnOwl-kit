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

// ── Discovery ────────────────────────────────────────────────────────────────
const jwt = (exp) => `h.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.s`;
const fakeFetch = (status, body, seen = []) => async (url, opts) => {
  seen.push({ url, headers: opts.headers });
  return { status, json: async () => body };
};

test("readClaudeCredential: env token wins without touching the keychain", () => {
  let asked = false;
  const cred = mc.readClaudeCredential({
    env: { CLAUDE_CODE_OAUTH_TOKEN: "sk-env" }, platform: "darwin", account: "alice",
    keychain: () => { asked = true; return null; },
  });
  assert.deepEqual(cred, { token: "sk-env", expiresAt: null, source: "env" });
  assert.equal(asked, false);
});

test("readClaudeCredential: keychain entry for the OS user, then the file fallback", () => {
  const blob = (token) => JSON.stringify({ claudeAiOauth: { accessToken: token, expiresAt: 123 } });
  let account;
  const fromKeychain = mc.readClaudeCredential({
    env: {}, platform: "darwin", account: "alice", home: "/h",
    keychain: (a) => { account = a; return blob("kc"); },
    readFile: () => { throw new Error("not used"); },
  });
  assert.equal(account, "alice");
  assert.deepEqual(fromKeychain, { token: "kc", expiresAt: 123, source: "keychain" });

  let read;
  const fromFile = mc.readClaudeCredential({
    env: {}, platform: "linux", account: "alice", home: "/h",
    keychain: () => { throw new Error("keychain is macOS-only"); },
    readFile: (p) => { read = p; return blob("file"); },
  });
  assert.equal(read, path.join("/h", ".claude", ".credentials.json"));
  assert.equal(fromFile.source, "file");

  assert.equal(mc.readClaudeCredential({
    env: {}, platform: "darwin", account: "alice", home: "/h",
    keychain: () => null, readFile: () => { throw new Error("ENOENT"); },
  }), null);
});

test("readClaudeCredential: keychain account / credentials file overridable (config paths)", () => {
  const blob = JSON.stringify({ claudeAiOauth: { accessToken: "x", expiresAt: 1 } });
  let account;
  let read;
  mc.readClaudeCredential({ env: { BARNOWL_CLAUDE_KEYCHAIN_ACCOUNT: "bob" }, platform: "darwin", home: "/h",
    keychain: (a) => { account = a; return blob; } });
  assert.equal(account, "bob");
  mc.readClaudeCredential({ env: { BARNOWL_CLAUDE_CREDENTIALS_FILE: "/etc/creds.json" }, platform: "linux", home: "/h",
    readFile: (p) => { read = p; return blob; } });
  assert.equal(read, "/etc/creds.json");
});

test("readCodexCredential: tokens + JWT expiry; missing → null", () => {
  const auth = JSON.stringify({ tokens: { access_token: jwt(2000), account_id: "acc" } });
  assert.deepEqual(mc.readCodexCredential({ home: "/c", readFile: () => auth }),
    { accessToken: jwt(2000), accountId: "acc", expiresAt: 2000 * 1000 });
  assert.equal(mc.readCodexCredential({ home: "/c", readFile: () => "{}" }), null);
  assert.equal(mc.readCodexCredential({ home: "/c", readFile: () => { throw new Error("ENOENT"); } }), null);
});

test("fetchClaudeModels: 200 ok (OAuth headers), 401 revoked, 500 / throw unknown", async () => {
  const seen = [];
  const ok = await mc.fetchClaudeModels("tok", { fetchImpl: fakeFetch(200, { data: CLAUDE_API }, seen), deprecatedIds: ["claude-fable-5"] });
  assert.equal(ok.status, "ok");
  assert.ok(ids(ok.models).includes("claude-opus-5[1m]"));
  assert.equal(seen[0].headers.Authorization, "Bearer tok");
  assert.equal(seen[0].headers["anthropic-beta"], "oauth-2025-04-20");

  const revoked = await mc.fetchClaudeModels("tok", {
    fetchImpl: fakeFetch(401, { error: { type: "authentication_error", message: "OAuth access token has been revoked." } }),
  });
  assert.deepEqual(revoked, { status: "revoked", message: "OAuth access token has been revoked." });

  assert.equal((await mc.fetchClaudeModels("tok", { fetchImpl: fakeFetch(500, null) })).status, "unknown");
  const offline = await mc.fetchClaudeModels("tok", { fetchImpl: async () => { throw new Error("fetch failed"); } });
  assert.deepEqual(offline, { status: "unknown", message: "fetch failed" });
});

test("fetchCodexModels: account header + client_version; 401 revoked", async () => {
  const seen = [];
  const ok = await mc.fetchCodexModels({ accessToken: "a", accountId: "acc" }, "0.155.0",
    { fetchImpl: fakeFetch(200, { models: CODEX_API }, seen) });
  assert.equal(ok.status, "ok");
  assert.deepEqual(ids(ok.models), ["codex", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5"]);
  assert.match(seen[0].url, /client_version=0\.155\.0$/);
  assert.equal(seen[0].headers["chatgpt-account-id"], "acc");
  const revoked = await mc.fetchCodexModels({ accessToken: "a", accountId: "acc" }, "0.155.0",
    { fetchImpl: fakeFetch(401, { error: { message: "Could not parse your authentication token." } }) });
  assert.equal(revoked.status, "revoked");
});

test("probeClaude: classifies the CLI's final result event", async () => {
  const runWith = (lines) => async () => ({ code: 0, stdout: lines.map((l) => JSON.stringify(l)).join("\n"), stderr: "", error: null });
  assert.equal((await mc.probeClaude({ runImpl: runWith([{ type: "result", subtype: "success", is_error: false, result: "ok" }]) })).status, "ok");
  const revoked = await mc.probeClaude({ runImpl: runWith([
    { type: "system", subtype: "api_retry", error_status: 401 },
    { type: "result", subtype: "success", is_error: true, api_error_status: 401, result: "Failed to authenticate. API Error: 401 OAuth access token is invalid." },
  ]) });
  assert.equal(revoked.status, "revoked");
  const none = await mc.probeClaude({ runImpl: async () => ({ code: null, stdout: "", stderr: "", error: new Error("spawn claude ENOENT") }) });
  assert.deepEqual(none, { status: "unknown", message: "spawn claude ENOENT" });
});

function deps(over = {}) {
  const calls = { probe: 0, claudeFetch: [], codexFetch: 0 };
  const d = {
    now: () => 1_000_000,
    readClaudeCredential: () => ({ token: "tok", expiresAt: null, source: "env" }),
    readCodexCredential: () => ({ accessToken: "a", accountId: "acc", expiresAt: null }),
    fetchClaudeModels: async (token) => {
      calls.claudeFetch.push(token);
      return { status: "ok", message: "", models: [{ id: "sonnet", label: "S", contextWindow: 200000 }] };
    },
    fetchCodexModels: async () => {
      calls.codexFetch++;
      return { status: "ok", message: "", models: [{ id: "codex", label: "C", contextWindow: 272000 }] };
    },
    probeClaude: async () => { calls.probe++; return { status: "ok", message: "" }; },
    claudeLoggedIn: async () => true,
    codexLoggedIn: async () => true,
    codexClientVersion: async () => "0.155.0",
    ...over,
  };
  return { d, calls };
}
const PREV = {
  version: 1, refreshedAt: "old",
  providers: {
    claude: { status: "ok", checkedAt: "old", message: "", models: [{ id: "old-claude", label: "O", contextWindow: 200000 }] },
    codex: { status: "ok", checkedAt: "old", message: "", models: [{ id: "old-codex", label: "O", contextWindow: 272000 }] },
  },
};

test("refreshCatalog: both ok → written with fresh models", async (t) => {
  const file = path.join(tmpDir(t), "catalog.json");
  const { d } = deps();
  const cat = await mc.refreshCatalog({ file, deps: d });
  assert.equal(cat.providers.claude.status, "ok");
  assert.deepEqual(ids(cat.providers.codex.models), ["codex"]);
  assert.equal(cat.refreshedAt, new Date(1_000_000).toISOString());
  assert.deepEqual(mc.readCatalog(file), cat);
});

test("refreshCatalog: expired Claude token → probe, re-read, fetch with the new token", async (t) => {
  const file = path.join(tmpDir(t), "catalog.json");
  let reads = 0;
  const { d, calls } = deps({
    readClaudeCredential: () => (++reads === 1
      ? { token: "stale", expiresAt: 1_000_000, source: "keychain" }
      : { token: "fresh", expiresAt: 9_000_000, source: "keychain" }),
  });
  const cat = await mc.refreshCatalog({ file, deps: d });
  assert.equal(calls.probe, 1);
  assert.deepEqual(calls.claudeFetch, ["fresh"]);
  assert.equal(cat.providers.claude.status, "ok");
});

test("refreshCatalog: probe says revoked → revoked, no fetch, last models kept", async (t) => {
  const file = path.join(tmpDir(t), "catalog.json");
  mc.writeCatalog(PREV, file);
  const { d, calls } = deps({
    readClaudeCredential: () => ({ token: "stale", expiresAt: 1, source: "keychain" }),
    probeClaude: async () => ({ status: "revoked", message: "401" }),
  });
  const cat = await mc.refreshCatalog({ file, deps: d });
  assert.equal(cat.providers.claude.status, "revoked");
  assert.deepEqual(calls.claudeFetch, []);
  assert.deepEqual(ids(cat.providers.claude.models), ["old-claude"]);
});

test("refreshCatalog: network failure keeps the previous models as unknown", async (t) => {
  const file = path.join(tmpDir(t), "catalog.json");
  mc.writeCatalog(PREV, file);
  const { d } = deps({ fetchCodexModels: async () => ({ status: "unknown", message: "fetch failed" }) });
  const cat = await mc.refreshCatalog({ file, deps: d });
  assert.equal(cat.providers.codex.status, "unknown");
  assert.equal(cat.providers.codex.message, "fetch failed");
  assert.deepEqual(ids(cat.providers.codex.models), ["old-codex"]);
});

test("refreshCatalog: no credential → logged_out only when the CLI confirms it", async (t) => {
  const file = path.join(tmpDir(t), "catalog.json");
  const out = await mc.refreshCatalog({ file, deps: deps({
    readClaudeCredential: () => null, claudeLoggedIn: async () => false,
    readCodexCredential: () => null, codexLoggedIn: async () => null,
  }).d });
  assert.equal(out.providers.claude.status, "logged_out");
  assert.equal(out.providers.codex.status, "unknown");
});

test("refreshCatalog: expired Codex token → unknown without fetching", async (t) => {
  const file = path.join(tmpDir(t), "catalog.json");
  const { d, calls } = deps({ readCodexCredential: () => ({ accessToken: "a", accountId: "acc", expiresAt: 999_999 }) });
  const cat = await mc.refreshCatalog({ file, deps: d });
  assert.equal(cat.providers.codex.status, "unknown");
  assert.equal(calls.codexFetch, 0);
});
