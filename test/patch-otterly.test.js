"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");

// The catalog must point at a temp dir BEFORE any patched otterly module loads.
const STATE = fs.mkdtempSync(path.join(os.tmpdir(), "barnowl-patch-"));
process.env.BARNOWL_STATE_DIR = STATE;
const CATALOG = path.join(STATE, "catalog.json");
const { ensurePatched } = require("../lib/patch-otterly.js");
// otterly's package `exports` has no require condition, so resolve by path
// (the same fallback lib/patch-otterly.js uses).
const DIST = path.join(__dirname, "..", "node_modules", "otterly", "dist");
const load = (rel) => import(pathToFileURL(path.join(DIST, rel)).href);
const read = (rel) => fs.readFileSync(path.join(DIST, rel), "utf8");
const status = (p) => JSON.parse(fs.readFileSync(CATALOG, "utf8")).providers[p].status;

test.after(() => fs.rmSync(STATE, { recursive: true, force: true }));

test("ensurePatched applies everything and is idempotent", () => {
  assert.ok(["patched", "already"].includes(ensurePatched()));
  assert.equal(ensurePatched(), "already");
});

test("server/index.js: the anthropic passthrough runs before the GET routes", () => {
  const src = read("server/index.js");
  const proxy = src.indexOf("barnowl: anthropic passthrough (every method)");
  const firstGet = src.indexOf('if (req.method === "GET" && path === "/api/status")');
  const postPipeline = src.indexOf('if (req.method !== "POST") {');
  assert.ok(proxy > 0, "the passthrough block is patched in");
  assert.ok(proxy < firstGet, "it must see GET /v1/files before otterly's GET router");
  assert.ok(proxy < postPipeline);
  assert.ok(src.includes("__barnowlGuard.isAnthropicPath(path)"));
  assert.ok(src.includes("__barnowlGuard.handleAnthropic(req, res)"));
  // the POST-only predecessor is retired, not left to double-handle
  assert.ok(!src.includes('path === "/v1/messages" && __barnowlGuard'));
});

test("routes-openai: sonnet fallback, breaker code, typed stream errors", () => {
  const src = read("server/routes-openai.js");
  assert.ok(src.includes('let model = body.model || "sonnet";'));
  assert.ok(!src.includes("claude-sonnet-4-20250514"));
  assert.ok(src.includes("(err && err.barnowlCode) || undefined"));
  assert.ok(!src.includes('type: "server_error" } })'));
  assert.ok(src.includes("sseData(openaiErrorBody(errorToHttpStatus(e), e.message))"));
});

test("stream loops throw error events (OpenAI + Ollama routes)", () => {
  for (const rel of ["server/routes-openai.js", "server/routes-ollama.js"]) {
    const src = read(rel);
    assert.ok(src.includes("barnowl: surface stream error events"), rel);
    assert.match(src, /if \(event\.type === "error"\)\n\s+throw event\.error;/, rel);
  }
});

test("engine.js: BARNOWL_CLAUDE_BIN wins over the PATH lookup", () => {
  const src = read("engine.js");
  assert.ok(src.includes("barnowl: configured claude binary"));
  assert.ok(src.includes("if (process.env.BARNOWL_CLAUDE_BIN) {"));
});

test("models.js: sonnet default and the live-catalog hook", () => {
  const src = read("server/models.js");
  assert.ok(src.includes('export const DEFAULT_MODEL = "sonnet";'));
  assert.ok(src.includes("barnowl: live model catalog"));
  assert.ok(!src.includes('id: "claude-sonnet-4-20250514"'));
});

test("events: auth is_error result → NOT_AUTHENTICATED + claude marked revoked", async () => {
  const { normalizeEvents, createEventContext } = await load("events.js");
  const events = normalizeEvents({
    type: "result", subtype: "success", is_error: true, api_error_status: 401,
    result: "Failed to authenticate. API Error: 401 OAuth access token is invalid.",
  }, createEventContext());
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "error");
  assert.equal(events[0].error.code, "NOT_AUTHENTICATED");
  assert.match(events[0].error.message, /authentication failed .*barnowl login claude/);
  assert.equal(status("claude"), "revoked");
});

test("events: a successful result flips claude back to ok", async () => {
  const { normalizeEvents, createEventContext } = await load("events.js");
  const events = normalizeEvents({ type: "result", subtype: "success", is_error: false, result: "ok", usage: {} }, createEventContext());
  assert.equal(events[0].type, "result");
  assert.equal(status("claude"), "ok");
});

test("events: non-auth is_error result → plain error", async () => {
  const { normalizeEvents, createEventContext } = await load("events.js");
  const [ev] = normalizeEvents({
    type: "result", subtype: "success", is_error: true, api_error_status: 429,
    result: "API Error: 429 rate_limit_error",
  }, createEventContext());
  assert.equal(ev.type, "error");
  assert.equal(ev.error.code, undefined);
  assert.match(ev.error.message, /429/);
  assert.equal(status("claude"), "ok");
});

test("events: synthetic API-error assistant text is dropped, normal text kept", async () => {
  const { normalizeEvents, createEventContext } = await load("events.js");
  assert.deepEqual(normalizeEvents({
    type: "assistant", error: "authentication_failed",
    message: { model: "<synthetic>", content: [{ type: "text", text: "Failed to authenticate." }] },
  }, createEventContext()), []);
  assert.deepEqual(normalizeEvents({
    type: "assistant", message: { content: [{ type: "text", text: "hi" }] },
  }, createEventContext()), [{ type: "text", text: "hi" }]);
});

// Last: importing models.js binds the process-wide auth-state to CATALOG.
test("models.js serves the catalog in place", async () => {
  fs.writeFileSync(CATALOG, JSON.stringify({
    version: 1, refreshedAt: "t",
    providers: {
      claude: { status: "ok", models: [{ id: "sonnet", label: "S", contextWindow: 200000 }] },
      codex: { status: "revoked", models: [{ id: "codex", label: "C", contextWindow: 272000 }] },
    },
  }));
  const { MODELS } = await load("server/models.js");
  assert.deepEqual(MODELS.map((x) => x.id), ["sonnet"]);
});

test("http engine patches are in place", () => {
  const e = read("engine.js");
  assert.ok(e.includes("barnowl: http engine"));
  assert.ok(e.includes("__barnowlHttp.httpActive()"));
  assert.ok(e.includes("queryOptions.anthropic = opts.anthropic;"));
  const r = read("server/routes-openai.js");
  for (const m of ["barnowl: http route", "barnowl: http sessions on every turn", "!options.anthropic && __barnowlWarm",
    "barnowl: http function calling", "barnowl: http tool session id"]) assert.ok(r.includes(m), m);
  assert.ok(r.includes("if (wantsTools && !options.anthropic) {"));
});

test("ClaudeEngine.run goes over HTTP to BARNOWL_SELF_URL (no claude spawn)", async () => {
  const http = require("http");
  const seen = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      seen.push({ url: req.url, body: JSON.parse(raw) });
      res.writeHead(200, { "content-type": "text/event-stream" });
      const ev = [
        { type: "message_start", message: { usage: { input_tokens: 3 } } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "pong" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
      ];
      res.end(ev.map((d) => `event: ${d.type}\ndata: ${JSON.stringify(d)}\n\n`).join(""));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const saved = { ...process.env };
  process.env.BARNOWL_SELF_URL = `http://127.0.0.1:${server.address().port}`;
  process.env.BARNOWL_MESSAGES_OAUTH = "1";
  process.env.BARNOWL_CLAUDE_BIN = "/nonexistent/claude";
  process.env.BARNOWL_SESSIONS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bo-pt-"));
  delete process.env.BARNOWL_ENGINE;
  try {
    const { ClaudeEngine } = await load("engine.js");
    const r = await new ClaudeEngine().run("ping", { model: "haiku" });
    assert.equal(r.text, "pong");
    assert.ok(r.sessionId);
    assert.equal(seen[0].url, "/v1/messages");
    assert.match(seen[0].body.model, /^claude-haiku-/);
  } finally {
    for (const k of ["BARNOWL_SELF_URL", "BARNOWL_MESSAGES_OAUTH", "BARNOWL_CLAUDE_BIN", "BARNOWL_SESSIONS_DIR"]) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
    await new Promise((r) => server.close(r));
  }
});
