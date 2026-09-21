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

test("routes-openai: sonnet fallback, breaker code, typed stream errors", () => {
  const src = read("server/routes-openai.js");
  assert.ok(src.includes('let model = body.model || "sonnet";'));
  assert.ok(!src.includes("claude-sonnet-4-20250514"));
  assert.ok(src.includes("(err && err.barnowlCode) || undefined"));
  assert.ok(!src.includes('type: "server_error" } })'));
  assert.ok(src.includes("sseData(openaiErrorBody(errorToHttpStatus(e), e.message))"));
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
