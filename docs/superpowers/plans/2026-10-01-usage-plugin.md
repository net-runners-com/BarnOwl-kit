# Plugins + `usage` plugin — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** barnowl gains an opt-in plugin mechanism and a bundled `usage` plugin that identifies callers by an admin-issued key and records per-user request metadata and token counts on both routes (`native` = `/v1/messages` passthrough, `api` = engine routes).

**Architecture:** `lib/plugins.cjs` loads plugins named in the `plugins` config block and runs `onRequest` / `onComplete` hooks around a per-request `call` object. The passthrough (`lib/guard.cjs` `handleMessages`) calls it directly and taps the upstream response with `lib/anthropic-usage.cjs`. Engine routes reach it through two small otterly patches: one in `server/index.js` (begin + `AsyncLocalStorage.enterWith`) and one in `server/metrics.js` (token counts flow to the current call). The `usage` plugin lives in `plugins/usage/` as four small modules: key store, record log, report, wiring + CLI.

**Tech Stack:** Node ≥18 CommonJS, `node:test`, `async_hooks.AsyncLocalStorage`, `crypto`, global `fetch`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-01-usage-plugin-design.md`

## Global Constraints

- With no `plugins` block configured, behaviour is unchanged: the 78 existing tests keep passing and no `usage/` directory is created.
- No new npm dependencies.
- Route tags are exactly `native` (the `/v1/messages` passthrough) and `api` (every engine route, including otterly's "Native API" `/api/run` and `/v1/images/generations`).
- Key header is `x-barnowl-key`; it is removed before anything is forwarded upstream.
- A key is `bo_` + 32 random bytes base64url. Only its SHA-256 hex is stored. Comparison uses `crypto.timingSafeEqual`.
- Files written by the usage plugin: directory mode `0700`, files `0600`. Never on disk: the raw key, prompt text, response text.
- Record `outcome` is one of `ok` | `blocked` | `rejected` | `upstream_error`.
- Missing / unknown / revoked key → `401 authentication_error`, message `barnowl: missing or invalid X-Barnowl-Key (ask your administrator)`. `requireKey: false` records `user: "unknown"` instead.
- A throwing `onRequest` rejects with `500 plugin_error` (fail-closed). A throwing `onComplete` is logged and swallowed.
- A configured plugin that fails to load makes `barnowl start` exit 1.
- Active-time gap: 5 minutes.
- Tests and E2E never touch port 11435, `~/.barnowl` or `~/dev/BarnOwl-kit`; they use temp dirs via `BARNOWL_STATE_DIR` and port 11497.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Work stays on branch `feat/usage-plugin`; nothing is pushed.

Deviation from the spec, deliberate: the response tap is its own module, `lib/anthropic-usage.cjs`, tested by `test/anthropic-usage.test.js` (the spec lists the tap tests under `usage-records.test.js`). The passthrough/plugin integration tests live in `test/passthrough-plugins.test.js` rather than in `guard.test.js`, because the plugin loader caches per process and `node --test` runs each file in its own process.

## Review Focus

1. **Key header with stray whitespace** (`X-Barnowl-Key:  bo_…  `, easy to produce in `ANTHROPIC_CUSTOM_HEADERS`): a person expects the key to work → trimmed before lookup. Test in Task 5.
2. **`keys.json` corrupted or half-written**: expect every request rejected with 401 and no crash, and the next valid write to recover. Test in Task 3.
3. **Upstream closes the stream mid-response** (network drop, client abort): expect a record with whatever was seen, not a lost request. Test in Task 6.
4. **Huge non-streaming upstream body**: expect the tap to give up (`null` tokens) without buffering without bound. Test in Task 1.
5. **Report over a day file containing a broken line** (crash mid-append): expect the line skipped and the rest reported. Test in Task 4.

---

### Task 1: `lib/anthropic-usage.cjs` — response tap

**Files:**
- Create: `lib/anthropic-usage.cjs`
- Test: `test/anthropic-usage.test.js`

**Interfaces:**
- Produces: `createTap(contentType: string|null) → { push(chunk: Uint8Array): void, result(): { inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens: number|null, tools: string[] } }`. `push` and `result` never throw.

- [ ] **Step 1: Write the failing test**

Create `test/anthropic-usage.test.js`:

```js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createTap, MAX_JSON } = require("../lib/anthropic-usage.cjs");

const SSE = [
  "event: message_start",
  'data: {"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":12,"cache_creation_input_tokens":3,"cache_read_input_tokens":100,"output_tokens":1}}}',
  "",
  "event: content_block_start",
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
  "",
  "event: content_block_delta",
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"こんにちは"}}',
  "",
  "event: content_block_start",
  'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"Read","input":{}}}',
  "",
  "event: content_block_start",
  'data: {"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"toolu_2","name":"Bash","input":{}}}',
  "",
  "event: message_delta",
  'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":40}}',
  "",
  "event: message_stop",
  'data: {"type":"message_stop"}',
  "",
  "",
].join("\n");

const EXPECTED = { inputTokens: 12, outputTokens: 40, cacheCreationTokens: 3, cacheReadTokens: 100, tools: ["Read", "Bash"] };

function feed(tap, text, size) {
  const bytes = Buffer.from(text, "utf8");
  for (let i = 0; i < bytes.length; i += size) tap.push(bytes.subarray(i, i + size));
  return tap.result();
}

test("SSE: tokens and tool names from one chunk", () => {
  assert.deepEqual(feed(createTap("text/event-stream; charset=utf-8"), SSE, 1 << 20), EXPECTED);
});

test("SSE: same result when chunks split lines and multibyte characters", () => {
  for (const size of [1, 2, 3, 7, 64]) {
    assert.deepEqual(feed(createTap("text/event-stream"), SSE, size), EXPECTED, `chunk size ${size}`);
  }
});

test("SSE: CRLF line endings", () => {
  assert.deepEqual(feed(createTap("text/event-stream"), SSE.replace(/\n/g, "\r\n"), 50), EXPECTED);
});

test("JSON: usage and tool_use blocks from a non-streaming response", () => {
  const body = JSON.stringify({
    id: "msg_1",
    content: [{ type: "text", text: "hi" }, { type: "tool_use", id: "t", name: "Grep", input: {} }],
    usage: { input_tokens: 5, output_tokens: 9, cache_creation_input_tokens: 0, cache_read_input_tokens: 7 },
  });
  assert.deepEqual(feed(createTap("application/json"), body, 11), {
    inputTokens: 5, outputTokens: 9, cacheCreationTokens: 0, cacheReadTokens: 7, tools: ["Grep"],
  });
});

test("error body, garbage and missing content-type give nulls, never throw", () => {
  const empty = { inputTokens: null, outputTokens: null, cacheCreationTokens: null, cacheReadTokens: null, tools: [] };
  assert.deepEqual(feed(createTap("application/json"), '{"type":"error","error":{"type":"overloaded_error"}}', 8), empty);
  assert.deepEqual(feed(createTap("application/json"), "<html>bad gateway</html>", 8), empty);
  assert.deepEqual(feed(createTap(null), "", 8), empty);
  assert.deepEqual(feed(createTap("text/event-stream"), "data: {not json}\n\ndata: [DONE]\n\n", 5), empty);
  const tap = createTap("text/event-stream");
  assert.doesNotThrow(() => tap.push(undefined));
});

test("JSON: a body over the cap is dropped instead of buffered", () => {
  const tap = createTap("application/json");
  const block = Buffer.alloc(1024 * 1024, 0x20);
  for (let i = 0; i <= MAX_JSON / block.length; i++) tap.push(block);
  tap.push(Buffer.from('{"usage":{"input_tokens":1,"output_tokens":1}}'));
  assert.equal(tap.result().inputTokens, null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/anthropic-usage.test.js`
Expected: FAIL with `Cannot find module '../lib/anthropic-usage.cjs'`

- [ ] **Step 3: Write the implementation**

Create `lib/anthropic-usage.cjs`:

```js
"use strict";
// anthropic-usage.cjs — read token usage and tool names out of an anthropic
// /v1/messages response while it streams past. Read-only: the caller forwards
// the original chunks untouched and feeds a copy here. Nothing in this module
// throws; an unparseable response just yields null counts.

const MAX_JSON = 20 * 1024 * 1024; // non-streaming bodies larger than this are not parsed

function createTap(contentType) {
  const sse = /text\/event-stream/i.test(contentType || "");
  const out = { inputTokens: null, outputTokens: null, cacheCreationTokens: null, cacheReadTokens: null, tools: [] };
  const decoder = new TextDecoder("utf-8"); // stream mode keeps split multibyte characters intact
  let buf = "";
  let dropped = false;

  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  function usage(u) {
    if (!u || typeof u !== "object") return;
    if (num(u.input_tokens) !== undefined) out.inputTokens = u.input_tokens;
    if (num(u.output_tokens) !== undefined) out.outputTokens = u.output_tokens;
    if (num(u.cache_creation_input_tokens) !== undefined) out.cacheCreationTokens = u.cache_creation_input_tokens;
    if (num(u.cache_read_input_tokens) !== undefined) out.cacheReadTokens = u.cache_read_input_tokens;
  }
  function toolBlock(b) {
    if (b && b.type === "tool_use" && typeof b.name === "string") out.tools.push(b.name);
  }
  function event(data) {
    let ev;
    try { ev = JSON.parse(data); } catch { return; }
    if (!ev || typeof ev !== "object") return;
    if (ev.type === "message_start" && ev.message) usage(ev.message.usage);
    else if (ev.type === "message_delta") usage(ev.usage);
    else if (ev.type === "content_block_start") toolBlock(ev.content_block);
  }

  return {
    push(chunk) {
      try {
        if (dropped || !chunk) return;
        buf += decoder.decode(chunk, { stream: true });
        if (!sse) {
          if (buf.length > MAX_JSON) { buf = ""; dropped = true; }
          return;
        }
        let i;
        while ((i = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, i).replace(/\r$/, "");
          buf = buf.slice(i + 1);
          if (line.startsWith("data:")) event(line.slice(5).trim());
        }
      } catch { /* a tap must never break the response */ }
    },
    result() {
      try {
        if (!sse && !dropped && buf) {
          const j = JSON.parse(buf);
          if (j && typeof j === "object") {
            usage(j.usage);
            if (Array.isArray(j.content)) j.content.forEach(toolBlock);
          }
        }
      } catch { /* not JSON: leave the nulls */ }
      return { ...out, tools: out.tools.slice() };
    },
  };
}

module.exports = { createTap, MAX_JSON };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/anthropic-usage.test.js`
Expected: `pass 6`, `fail 0`

- [ ] **Step 5: Commit**

```bash
git add lib/anthropic-usage.cjs test/anthropic-usage.test.js
git commit -m "Add anthropic-usage: tap tokens and tool names from /v1/messages responses

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: `lib/plugins.cjs` — loader and hooks

**Files:**
- Create: `lib/plugins.cjs`
- Test: `test/plugins.test.js`

**Interfaces:**
- Consumes: `stateDir(env)` from `lib/model-catalog.cjs` (line 30).
- Produces:
  - `load(env = process.env) → [{ name, mod }]` — throws on any failure.
  - `enabled() → boolean`
  - `begin({ route, path, headers, body }) → Promise<{ ok: true, call } | { ok: false, reject: { status, type, message }, call }>`
  - `call`: `{ record, stripHeaders: Set<string>, note(fields), finish(fields) → Promise<void> }`
  - `beginEngine(path, headers, body) → Promise<{ ok: true, call } | { ok: false, status, error }>` (finishes the record itself on reject)
  - `attach(res, call)` — synchronous; binds `call` to the current async context and finishes it on `res` `close`.
  - `outcomeOf(status) → "ok" | "blocked" | "upstream_error"`
  - `resolvePlugin(spec) → absolute path`, `_reset()` (tests only)
  - `globalThis.__barnowlOnMetrics(run)` — set at module load; called by the patched otterly `Metrics.record`.
- Plugin contract: `{ name?, init?(options, { stateDir, log }), onRequest?({ route, path, headers, body }) → void | { identity?, stripHeaders?, reject? }, onComplete?(record), cli?(argv, ctx) }`.

- [ ] **Step 1: Write the failing test**

Create `test/plugins.test.js`:

```js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { EventEmitter } = require("events");

const STATE = fs.mkdtempSync(path.join(os.tmpdir(), "barnowl-plugins-"));
process.env.BARNOWL_STATE_DIR = STATE;
const plugins = require("../lib/plugins.cjs");

test.after(() => fs.rmSync(STATE, { recursive: true, force: true }));

let n = 0;
const writePlugin = (src) => {
  const p = path.join(STATE, `plugin-${++n}.cjs`);
  fs.writeFileSync(p, src);
  return p;
};
const use = (cfg) => {
  if (cfg === null) delete process.env.BARNOWL_PLUGINS;
  else process.env.BARNOWL_PLUGINS = typeof cfg === "string" ? cfg : JSON.stringify(cfg);
  plugins._reset();
  globalThis.__seen = [];
};
const tick = () => new Promise((r) => setImmediate(r));
const REQ = { route: "native", path: "/v1/messages", headers: { "x-a": "1" }, body: { model: "m1", stream: true } };

const RECORDER = `
  module.exports = {
    name: "rec",
    init(options, ctx) { globalThis.__seen.push(["init", options, ctx.stateDir]); },
    onRequest(req) { globalThis.__seen.push(["req", req.route]); return { identity: { user: "u1" }, stripHeaders: ["X-Secret"] }; },
    onComplete(record) { globalThis.__seen.push(["done", { ...record }]); },
  };`;

test("unconfigured: disabled, nothing loaded", () => {
  use(null);
  assert.equal(plugins.enabled(), false);
  assert.deepEqual(plugins.load(), []);
});

test("resolvePlugin: bare name → bundled dir, path → file, ~ expanded", () => {
  assert.ok(plugins.resolvePlugin("usage").endsWith(path.join("plugins", "usage", "index.cjs")));
  assert.equal(plugins.resolvePlugin("/abs/p.cjs"), path.resolve("/abs/p.cjs"));
  assert.equal(plugins.resolvePlugin("~/p.cjs"), path.join(os.homedir(), "p.cjs"));
});

test("loads by path, passes options and the state dir, false skips", () => {
  const a = writePlugin(RECORDER);
  const b = writePlugin(`module.exports = { name: "skipped", init() { throw new Error("must not load"); } };`);
  use({ [a]: { x: 1 }, [b]: false });
  assert.equal(plugins.enabled(), true);
  assert.deepEqual(plugins.load().map((p) => p.name), ["rec"]);
  assert.deepEqual(globalThis.__seen[0], ["init", { x: 1 }, STATE]);
});

test("begin → finish: identity merged, headers to strip lowercased, record shaped", async () => {
  use({ [writePlugin(RECORDER)]: {} });
  const b = await plugins.begin(REQ);
  assert.equal(b.ok, true);
  assert.deepEqual([...b.call.stripHeaders], ["x-secret"]);
  await b.call.finish({ status: 200, outcome: "ok", inputTokens: 5 });
  const done = globalThis.__seen.find((e) => e[0] === "done")[1];
  assert.equal(done.route, "native");
  assert.equal(done.path, "/v1/messages");
  assert.equal(done.model, "m1");
  assert.equal(done.stream, true);
  assert.equal(done.user, "u1");
  assert.equal(done.status, 200);
  assert.equal(done.inputTokens, 5);
  assert.ok(Number.isInteger(done.durationMs) && done.durationMs >= 0);
  assert.ok(!Number.isNaN(Date.parse(done.ts)));
});

test("finish runs once; a throwing onComplete is swallowed", async () => {
  const boom = writePlugin(`module.exports = { name: "boom", onComplete() { globalThis.__seen.push(["boom"]); throw new Error("disk full"); } };`);
  use({ [boom]: {}, [writePlugin(RECORDER)]: {} });
  const b = await plugins.begin(REQ);
  await b.call.finish({ status: 200, outcome: "ok" });
  await b.call.finish({ status: 500, outcome: "upstream_error" });
  assert.equal(globalThis.__seen.filter((e) => e[0] === "boom").length, 1);
  const dones = globalThis.__seen.filter((e) => e[0] === "done");
  assert.equal(dones.length, 1, "later plugins still ran, once");
  assert.equal(dones[0][1].status, 200);
});

test("hooks run in config order; the first reject wins and stops the chain", async () => {
  const first = writePlugin(`module.exports = { name: "first", onRequest() { globalThis.__seen.push("first"); return { identity: { deviceId: "d1" }, reject: { status: 401, type: "authentication_error", message: "no key" } }; } };`);
  const second = writePlugin(`module.exports = { name: "second", onRequest() { globalThis.__seen.push("second"); } };`);
  use({ [first]: {}, [second]: {} });
  const b = await plugins.begin(REQ);
  assert.equal(b.ok, false);
  assert.deepEqual(b.reject, { status: 401, type: "authentication_error", message: "no key" });
  assert.equal(b.call.record.deviceId, "d1", "identity from the rejecting hook is kept");
  assert.deepEqual(globalThis.__seen, ["first"]);
});

test("a throwing onRequest rejects with 500 plugin_error", async () => {
  use({ [writePlugin(`module.exports = { name: "bad", onRequest() { throw new Error("kaboom"); } };`)]: {} });
  const b = await plugins.begin(REQ);
  assert.equal(b.ok, false);
  assert.equal(b.reject.status, 500);
  assert.equal(b.reject.type, "plugin_error");
  assert.match(b.reject.message, /bad.*kaboom/);
});

test("a plugin that cannot load: load() throws, enabled() stays true, begin() rejects", async () => {
  use({ [path.join(STATE, "nope.cjs")]: {} });
  assert.throws(() => plugins.load(), /failed to load/);
  assert.equal(plugins.enabled(), true, "a broken config must not fall back to no plugins");
  const b = await plugins.begin(REQ);
  assert.equal(b.ok, false);
  assert.equal(b.reject.type, "plugin_error");
});

test("invalid BARNOWL_PLUGINS JSON and a throwing init both fail the load", () => {
  use("{not json");
  assert.throws(() => plugins.load(), /BARNOWL_PLUGINS/);
  use({ [writePlugin(`module.exports = { name: "i", init() { throw new Error("no dir"); } };`)]: {} });
  assert.throws(() => plugins.load(), /init failed.*no dir/);
});

test("stream flag follows each route's default", async () => {
  use({ [writePlugin(RECORDER)]: {} });
  const s = async (p, body) => (await plugins.begin({ route: "api", path: p, headers: {}, body })).call.record.stream;
  assert.equal(await s("/v1/chat/completions", {}), false);
  assert.equal(await s("/v1/chat/completions", { stream: true }), true);
  assert.equal(await s("/api/chat", {}), true);
  assert.equal(await s("/api/generate", { stream: false }), false);
  assert.equal(await s("/api/stream", {}), true);
  assert.equal(await s("/api/run", {}), false);
});

test("outcomeOf", () => {
  assert.equal(plugins.outcomeOf(200), "ok");
  assert.equal(plugins.outcomeOf(204), "ok");
  assert.equal(plugins.outcomeOf(403), "blocked");
  assert.equal(plugins.outcomeOf(500), "upstream_error");
  assert.equal(plugins.outcomeOf(429), "upstream_error");
});

test("beginEngine: reject is shaped per route and recorded as rejected", async () => {
  const rej = writePlugin(`module.exports = { name: "rej",
    onRequest() { return { reject: { status: 401, type: "authentication_error", message: "no key" } }; },
    onComplete(r) { globalThis.__seen.push({ ...r }); } };`);
  use({ [rej]: {} });
  const openai = await plugins.beginEngine("/v1/chat/completions", {}, { model: "sonnet" });
  assert.deepEqual(openai, { ok: false, status: 401, error: { error: { message: "no key", type: "authentication_error", code: 401 } } });
  const plain = await plugins.beginEngine("/api/chat", {}, {});
  assert.deepEqual(plain, { ok: false, status: 401, error: { error: "no key" } });
  assert.deepEqual(globalThis.__seen.map((r) => [r.route, r.outcome, r.status]), [["api", "rejected", 401], ["api", "rejected", 401]]);
});

test("attach + metrics tap: concurrent requests keep their own token counts", async () => {
  use({ [writePlugin(`module.exports = { name: "m", onComplete(r) { globalThis.__seen.push({ ...r }); } };`)]: {} });
  async function request(model, tokens, delayMs, status) {
    const b = await plugins.beginEngine("/v1/chat/completions", {}, { model });
    const res = new EventEmitter();
    res.statusCode = status;
    plugins.attach(res, b.call);
    await new Promise((r) => setTimeout(r, delayMs)); // the engine works; another request interleaves
    await Promise.resolve().then(() => globalThis.__barnowlOnMetrics({ inputTokens: tokens, outputTokens: tokens * 2, toolCalls: 1 }));
    res.emit("close");
  }
  await Promise.all([request("a", 10, 30, 200), request("b", 20, 5, 200), request("c", 30, 15, 403)]);
  await tick();
  const by = Object.fromEntries(globalThis.__seen.map((r) => [r.model, r]));
  assert.deepEqual([by.a.inputTokens, by.a.outputTokens, by.a.toolCalls, by.a.outcome], [10, 20, 1, "ok"]);
  assert.deepEqual([by.b.inputTokens, by.b.outputTokens, by.b.outcome], [20, 40, "ok"]);
  assert.deepEqual([by.c.inputTokens, by.c.outcome, by.c.status], [30, "blocked", 403]);
});

test("metrics tap outside any request is a no-op", () => {
  use(null);
  assert.doesNotThrow(() => globalThis.__barnowlOnMetrics({ inputTokens: 1 }));
  assert.doesNotThrow(() => globalThis.__barnowlOnMetrics(undefined));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/plugins.test.js`
Expected: FAIL with `Cannot find module '../lib/plugins.cjs'`

- [ ] **Step 3: Write the implementation**

Create `lib/plugins.cjs`:

```js
"use strict";
// plugins.cjs — opt-in plugin loader.
//
// Config: the config file's "plugins" block, handed to the server process as
// JSON in BARNOWL_PLUGINS by `barnowl start`:
//
//   { "plugins": { "usage": { "requireKey": true }, "~/my/plugin.cjs": {} } }
//
// A bare name is a bundled plugin (plugins/<name>/index.cjs); anything with a
// path separator is a file. `false` skips an entry. With no block configured
// this module does nothing and barnowl behaves exactly as before.
//
// A plugin is a CommonJS module:
//   { name, init(options, { stateDir, log }), onRequest(req), onComplete(record), cli(argv, ctx) }
// all optional. onRequest receives { route, path, headers, body } and may
// return { identity, stripHeaders, reject: { status, type, message } }.
//
// Failure policy: a plugin that cannot load is never skipped silently
// (`barnowl start` refuses to start; a request reaching a broken config is
// rejected). A throwing onRequest rejects the request. A throwing onComplete
// is logged and swallowed — the response has already been sent.

const os = require("os");
const path = require("path");
const { AsyncLocalStorage } = require("async_hooks");
const { stateDir } = require("./model-catalog.cjs");

const als = new AsyncLocalStorage();
let loaded = null;

function log(msg) {
  console.error(`[barnowl] ${msg}`);
}

function parseConfig(env) {
  const raw = env.BARNOWL_PLUGINS;
  if (!raw) return {};
  let cfg;
  try { cfg = JSON.parse(raw); }
  catch (e) { throw new Error(`BARNOWL_PLUGINS is not valid JSON: ${e.message}`); }
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) {
    throw new Error('BARNOWL_PLUGINS / "plugins" must be an object: { "<name-or-path>": { ...options } }');
  }
  return cfg;
}

function resolvePlugin(spec) {
  if (spec.includes("/") || spec.includes(path.sep)) {
    const p = spec === "~" || spec.startsWith("~/") || spec.startsWith("~" + path.sep)
      ? path.join(os.homedir(), spec.slice(1))
      : spec;
    return path.resolve(p);
  }
  return path.join(__dirname, "..", "plugins", spec, "index.cjs");
}

/** Load and init every configured plugin. Throws on any failure. */
function load(env = process.env) {
  const out = [];
  for (const [spec, options] of Object.entries(parseConfig(env))) {
    if (options === false) continue;
    const file = resolvePlugin(spec);
    let mod;
    try { mod = require(file); }
    catch (e) { throw new Error(`plugin "${spec}" failed to load (${file}): ${e.message}`); }
    if (!mod || typeof mod !== "object") throw new Error(`plugin "${spec}" failed to load (${file}): it does not export an object`);
    const name = typeof mod.name === "string" && mod.name ? mod.name : spec;
    if (typeof mod.init === "function") {
      const opts = options && typeof options === "object" ? options : {};
      try { mod.init(opts, { stateDir: stateDir(env), log }); }
      catch (e) { throw new Error(`plugin "${name}" init failed: ${e.message}`); }
    }
    out.push({ name, mod });
  }
  return out;
}

function list() {
  if (!loaded) loaded = load();
  return loaded;
}

function enabled() {
  if (!process.env.BARNOWL_PLUGINS) return false;
  // A broken config counts as enabled so begin() rejects instead of the
  // request silently running with no plugins.
  try { return list().length > 0; } catch { return true; }
}

function isStream(reqPath, body) {
  if (reqPath === "/api/stream") return true;
  if (reqPath === "/api/chat" || reqPath === "/api/generate") return !(body && body.stream === false);
  return !!(body && body.stream === true);
}

function outcomeOf(status) {
  if (status >= 200 && status < 300) return "ok";
  return status === 403 ? "blocked" : "upstream_error";
}

/** Start one request: run every onRequest. The returned call collects the
 *  record; the caller must finish() it exactly once (extra calls are no-ops). */
async function begin({ route, path: reqPath, headers, body }) {
  const startedAt = Date.now();
  const record = {
    ts: new Date(startedAt).toISOString(),
    route,
    path: reqPath,
    model: body && typeof body.model === "string" ? body.model : null,
    stream: isStream(reqPath, body),
  };
  const notes = {};
  let finished = false;
  let active = [];
  const call = {
    record,
    stripHeaders: new Set(),
    note(fields) { if (!finished) Object.assign(notes, fields); },
    async finish(fields = {}) {
      if (finished) return;
      finished = true;
      Object.assign(record, notes, fields);
      if (record.durationMs === undefined) record.durationMs = Date.now() - startedAt;
      for (const { name, mod } of active) {
        if (typeof mod.onComplete !== "function") continue;
        try { await mod.onComplete(record); }
        catch (e) { log(`plugin "${name}" onComplete failed: ${e.message}`); }
      }
    },
  };

  try { active = list(); }
  catch (e) {
    return { ok: false, call, reject: { status: 500, type: "plugin_error", message: `barnowl plugin error: ${e.message}` } };
  }
  for (const { name, mod } of active) {
    if (typeof mod.onRequest !== "function") continue;
    let r;
    try { r = await mod.onRequest({ route, path: reqPath, headers: headers || {}, body }); }
    catch (e) {
      return { ok: false, call, reject: { status: 500, type: "plugin_error", message: `barnowl plugin "${name}" failed: ${e.message}` } };
    }
    if (!r) continue;
    if (r.identity && typeof r.identity === "object") Object.assign(record, r.identity);
    if (Array.isArray(r.stripHeaders)) for (const h of r.stripHeaders) call.stripHeaders.add(String(h).toLowerCase());
    if (r.reject) return { ok: false, call, reject: r.reject };
  }
  return { ok: true, call };
}

/** Engine routes (the patched otterly server/index.js). On reject the record
 *  is finished here and the error comes back in the route's own shape. */
async function beginEngine(reqPath, headers, body) {
  const b = await begin({ route: "api", path: reqPath, headers, body });
  if (b.ok) return { ok: true, call: b.call };
  const { status, type, message } = b.reject;
  await b.call.finish({ status, outcome: "rejected" });
  const openai = reqPath === "/v1/chat/completions" || reqPath === "/v1/images/generations";
  return { ok: false, status, error: openai ? { error: { message, type, code: status } } : { error: message } };
}

/** Bind `call` to the caller's async context and finish it when the response
 *  closes. Must be called synchronously from the request handler itself: an
 *  enterWith() inside an awaited helper would not reach the handler's later
 *  awaits. */
function attach(res, call) {
  als.enterWith(call);
  res.on("close", () => {
    const status = res.statusCode || 200;
    call.finish({ status, outcome: outcomeOf(status) });
  });
}

// otterly's Metrics.record(run) is patched to call this; every engine route
// reports its token counts there. The store is per request, so concurrent
// requests do not mix.
globalThis.__barnowlOnMetrics = (run) => {
  const call = als.getStore();
  if (!call || !run || typeof run !== "object") return;
  call.note({
    inputTokens: typeof run.inputTokens === "number" ? run.inputTokens : null,
    outputTokens: typeof run.outputTokens === "number" ? run.outputTokens : null,
    toolCalls: typeof run.toolCalls === "number" ? run.toolCalls : null,
  });
};

function _reset() {
  loaded = null;
}

module.exports = { load, enabled, begin, beginEngine, attach, outcomeOf, resolvePlugin, _reset };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/plugins.test.js`
Expected: `pass 14`, `fail 0`

- [ ] **Step 5: Commit**

```bash
git add lib/plugins.cjs test/plugins.test.js
git commit -m "Add plugins: opt-in loader with onRequest / onComplete hooks

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: `plugins/usage/keys.cjs` — key store

**Files:**
- Create: `plugins/usage/keys.cjs`
- Test: `test/usage-keys.test.js`

**Interfaces:**
- Produces (all take `dir`, the `<stateDir>/usage` directory):
  - `add(dir, user, now = new Date()) → key: string` (throws on an invalid user)
  - `verify(dir, key) → user: string | null`
  - `revoke(dir, user, now = new Date()) → number` (keys revoked)
  - `list(dir) → [{ user, createdAt, revokedAt }]`

- [ ] **Step 1: Write the failing test**

Create `test/usage-keys.test.js`:

```js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const keys = require("../plugins/usage/keys.cjs");

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "barnowl-keys-"));
test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
let n = 0;
const freshDir = () => path.join(ROOT, `d${++n}`, "usage");
const mode = (p) => fs.statSync(p).mode & 0o777;

test("add → verify; only the hash is on disk; modes are private", { skip: process.platform === "win32" && "POSIX modes" }, () => {
  const dir = freshDir();
  const key = keys.add(dir, "sato");
  assert.match(key, /^bo_[A-Za-z0-9_-]{43}$/);
  assert.equal(keys.verify(dir, key), "sato");
  const raw = fs.readFileSync(path.join(dir, "keys.json"), "utf8");
  assert.ok(!raw.includes(key), "raw key must not be stored");
  assert.match(JSON.parse(raw).keys[0].hash, /^[0-9a-f]{64}$/);
  assert.equal(mode(dir), 0o700);
  assert.equal(mode(path.join(dir, "keys.json")), 0o600);
});

test("unknown, empty and non-string keys do not verify; no file is fine", () => {
  const dir = freshDir();
  assert.equal(keys.verify(dir, "bo_nope"), null);
  assert.equal(keys.verify(dir, ""), null);
  assert.equal(keys.verify(dir, undefined), null);
  assert.equal(keys.verify(dir, ["a", "b"]), null);
  assert.deepEqual(keys.list(dir), []);
});

test("several keys per user; revoke kills all of that user's keys only", () => {
  const dir = freshDir();
  const a1 = keys.add(dir, "sato");
  const a2 = keys.add(dir, "sato");
  const b1 = keys.add(dir, "鈴木");
  assert.notEqual(a1, a2);
  assert.equal(keys.revoke(dir, "sato"), 2);
  assert.equal(keys.verify(dir, a1), null);
  assert.equal(keys.verify(dir, a2), null);
  assert.equal(keys.verify(dir, b1), "鈴木");
  assert.equal(keys.revoke(dir, "sato"), 0, "nothing left to revoke");
  assert.equal(keys.revoke(dir, "nobody"), 0);
});

test("list shows users and dates, never a key or hash", () => {
  const dir = freshDir();
  const key = keys.add(dir, "sato", new Date("2026-10-01T00:00:00Z"));
  keys.revoke(dir, "sato", new Date("2026-10-02T00:00:00Z"));
  const out = keys.list(dir);
  assert.deepEqual(out, [{ user: "sato", createdAt: "2026-10-01T00:00:00.000Z", revokedAt: "2026-10-02T00:00:00.000Z" }]);
  assert.ok(!JSON.stringify(out).includes(key));
});

test("invalid user names are refused", () => {
  const dir = freshDir();
  for (const bad of ["", "   ", "a\nb", "x".repeat(65), "unknown", undefined]) {
    assert.throws(() => keys.add(dir, bad), /user/, JSON.stringify(bad));
  }
  assert.equal(fs.existsSync(dir), false, "nothing written for a refused name");
});

test("a key file changed by another process is picked up", () => {
  const dir = freshDir();
  const key = keys.add(dir, "sato");
  const file = path.join(dir, "keys.json");
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  data.keys[0].revokedAt = "2026-10-01T00:00:00.000Z";
  fs.writeFileSync(file, JSON.stringify(data));
  fs.utimesSync(file, new Date(), new Date(Date.now() + 5000)); // make the mtime change unmistakable
  assert.equal(keys.verify(dir, key), null);
});

test("a corrupted key file rejects everything, and the next add recovers", () => {
  const dir = freshDir();
  const key = keys.add(dir, "sato");
  const file = path.join(dir, "keys.json");
  fs.writeFileSync(file, '{"keys": [{"user": "sa');
  fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));
  assert.equal(keys.verify(dir, key), null);
  assert.deepEqual(keys.list(dir), []);
  const fresh = keys.add(dir, "tanaka");
  assert.equal(keys.verify(dir, fresh), "tanaka");
});

test("entries with a malformed hash are ignored, not thrown on", () => {
  const dir = freshDir();
  const key = keys.add(dir, "sato");
  const file = path.join(dir, "keys.json");
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  data.keys.unshift({ user: "broken", hash: "zz", createdAt: "x", revokedAt: null }, { user: "nohash" }, null);
  fs.writeFileSync(file, JSON.stringify(data));
  fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));
  assert.equal(keys.verify(dir, key), "sato");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/usage-keys.test.js`
Expected: FAIL with `Cannot find module '../plugins/usage/keys.cjs'`

- [ ] **Step 3: Write the implementation**

Create `plugins/usage/keys.cjs`:

```js
"use strict";
// keys.cjs — admin-issued keys for the usage plugin.
//
// <stateDir>/usage/keys.json: { "keys": [{ user, hash, createdAt, revokedAt }] }
// A key is shown once, at creation; only its SHA-256 is stored. The file is
// re-read when its mtime changes, so `barnowl usage key add|revoke` reaches a
// running server without a restart. An unreadable file matches no key.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const RESERVED = new Set(["unknown"]); // the label requireKey:false gives keyless requests
let cache = { file: null, mtimeMs: -1, keys: [] };

const fileOf = (dir) => path.join(dir, "keys.json");
const hashOf = (key) => crypto.createHash("sha256").update(key, "utf8").digest("hex");

function load(dir) {
  const file = fileOf(dir);
  let st;
  try { st = fs.statSync(file); }
  catch { cache = { file, mtimeMs: -1, keys: [] }; return cache.keys; }
  if (cache.file === file && cache.mtimeMs === st.mtimeMs) return cache.keys;
  let data;
  try { data = JSON.parse(fs.readFileSync(file, "utf8")); } catch { data = null; }
  const keys = data && Array.isArray(data.keys)
    ? data.keys.filter((k) => k && typeof k === "object" && typeof k.user === "string" && typeof k.hash === "string")
    : [];
  cache = { file, mtimeMs: st.mtimeMs, keys };
  return keys;
}

function save(dir, keys) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = fileOf(dir);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ keys }, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
  cache = { file, mtimeMs: fs.statSync(file).mtimeMs, keys };
}

function checkUser(user) {
  if (typeof user !== "string" || !user.trim() || user !== user.trim() || user.length > 64
    || /[\u0000-\u001f\u007f]/.test(user) || RESERVED.has(user)) {
    throw new Error('user must be 1-64 characters, no control characters or surrounding spaces, and not "unknown"');
  }
}

function add(dir, user, now = new Date()) {
  checkUser(user);
  const key = "bo_" + crypto.randomBytes(32).toString("base64url");
  const keys = load(dir).slice();
  keys.push({ user, hash: hashOf(key), createdAt: now.toISOString(), revokedAt: null });
  save(dir, keys);
  return key;
}

function verify(dir, key) {
  if (typeof key !== "string" || !key) return null;
  const want = Buffer.from(hashOf(key), "hex");
  let user = null;
  for (const k of load(dir)) {
    if (k.revokedAt) continue;
    const have = Buffer.from(k.hash, "hex");
    if (have.length === want.length && crypto.timingSafeEqual(have, want)) user = k.user;
  }
  return user;
}

function revoke(dir, user, now = new Date()) {
  let n = 0;
  const keys = load(dir).map((k) => {
    if (k.user !== user || k.revokedAt) return k;
    n++;
    return { ...k, revokedAt: now.toISOString() };
  });
  if (n) save(dir, keys);
  return n;
}

function list(dir) {
  return load(dir).map((k) => ({ user: k.user, createdAt: k.createdAt || null, revokedAt: k.revokedAt || null }));
}

module.exports = { add, verify, revoke, list };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/usage-keys.test.js`
Expected: `pass 8`, `fail 0`

- [ ] **Step 5: Commit**

```bash
git add plugins/usage/keys.cjs test/usage-keys.test.js
git commit -m "usage plugin: key store (hash only, hot reload, revoke)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: `plugins/usage/records.cjs` + `report.cjs` — log and aggregation

**Files:**
- Create: `plugins/usage/records.cjs`
- Create: `plugins/usage/report.cjs`
- Test: `test/usage-records.test.js`
- Test: `test/usage-report.test.js`

**Interfaces:**
- Produces, `records.cjs`:
  - `FIELDS: string[]` — the only fields ever written.
  - `dayOf(date: Date) → "YYYY-MM-DD"` (local time)
  - `append(dir, record) → void`
  - `readRange(dir, from, to) → record[]` (inclusive `YYYY-MM-DD` bounds; skips unparseable lines)
- Produces, `report.cjs`:
  - `GAP_MS`, `activeMs(records) → number`
  - `summarize(records) → rows[]` where a row is `{ user, route, requests, blocked, rejected, errors, inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens, devices, sessions, activeMinutes }`, sorted by user then route.
  - `formatTable(rows) → string`

- [ ] **Step 1: Write the failing tests**

Create `test/usage-records.test.js`:

```js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const records = require("../plugins/usage/records.cjs");

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "barnowl-records-"));
test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
let n = 0;
const freshDir = () => path.join(ROOT, `d${++n}`, "usage");
const mode = (p) => fs.statSync(p).mode & 0o777;
const localNoon = (y, m, d) => new Date(y, m - 1, d, 12, 0, 0).toISOString();

test("dayOf uses the local date", () => {
  assert.equal(records.dayOf(new Date(2026, 9, 1, 0, 0, 1)), "2026-10-01");
  assert.equal(records.dayOf(new Date(2026, 0, 9, 23, 59, 59)), "2026-01-09");
});

test("append writes one whitelisted line into the day file, private modes", { skip: process.platform === "win32" && "POSIX modes" }, () => {
  const dir = freshDir();
  records.append(dir, {
    ts: localNoon(2026, 10, 1), route: "native", path: "/v1/messages", user: "sato",
    deviceId: "dev", accountUuid: "acc", sessionId: "ses", model: "m", stream: true,
    status: 200, outcome: "ok", durationMs: 12, inputTokens: 1, outputTokens: 2,
    cacheCreationTokens: 3, cacheReadTokens: 4, tools: ["Read", "Bash"],
    // none of these may reach the disk:
    key: "bo_secret", prompt: "TOP SECRET PROMPT", headers: { authorization: "Bearer x" }, body: { messages: [] },
  });
  const file = path.join(dir, "2026-10-01.jsonl");
  const raw = fs.readFileSync(file, "utf8");
  assert.equal(raw.split("\n").length, 2, "one line plus the trailing newline");
  const rec = JSON.parse(raw);
  assert.deepEqual(Object.keys(rec), records.FIELDS);
  assert.equal(rec.toolCalls, 2, "derived from tools when not given");
  assert.ok(!/bo_secret|TOP SECRET|Bearer/.test(raw));
  assert.equal(mode(dir), 0o700);
  assert.equal(mode(file), 0o600);
});

test("missing fields are written as null; api records keep toolCalls", () => {
  const dir = freshDir();
  records.append(dir, { ts: localNoon(2026, 10, 1), route: "api", path: "/v1/chat/completions", user: "sato", status: 200, outcome: "ok", toolCalls: 3 });
  const [rec] = records.readRange(dir, "2026-10-01", "2026-10-01");
  assert.equal(rec.deviceId, null);
  assert.equal(rec.tools, null);
  assert.equal(rec.cacheReadTokens, null);
  assert.equal(rec.toolCalls, 3);
});

test("a record with an unusable ts falls back to now instead of throwing", () => {
  const dir = freshDir();
  records.append(dir, { ts: "not a date", route: "api", outcome: "ok" });
  const today = records.dayOf(new Date());
  assert.equal(records.readRange(dir, today, today).length, 1);
});

test("readRange is inclusive, ordered, and skips broken lines and stray files", () => {
  const dir = freshDir();
  for (const d of [30, 1, 2, 3]) {
    const m = d === 30 ? 9 : 10;
    records.append(dir, { ts: localNoon(2026, m, d), route: "native", user: `u${d}`, outcome: "ok" });
  }
  fs.appendFileSync(path.join(dir, "2026-10-02.jsonl"), '{"ts":"2026-10-02T03:00:00.000Z","user":"half\n');
  fs.writeFileSync(path.join(dir, "notes.txt"), "ignore me");
  fs.writeFileSync(path.join(dir, "keys.json"), "{}");
  assert.deepEqual(records.readRange(dir, "2026-10-01", "2026-10-02").map((r) => r.user), ["u1", "u2"]);
  assert.deepEqual(records.readRange(dir, "2026-09-01", "2026-12-31").map((r) => r.user), ["u30", "u1", "u2", "u3"]);
  assert.deepEqual(records.readRange(path.join(ROOT, "missing"), "2026-01-01", "2026-12-31"), []);
});

test("many appends stay one valid line each", () => {
  const dir = freshDir();
  for (let i = 0; i < 300; i++) records.append(dir, { ts: localNoon(2026, 10, 1), route: "native", user: "u", status: 200, outcome: "ok", inputTokens: i });
  const recs = records.readRange(dir, "2026-10-01", "2026-10-01");
  assert.equal(recs.length, 300);
  assert.equal(recs.reduce((s, r) => s + r.inputTokens, 0), (299 * 300) / 2);
});
```

Create `test/usage-report.test.js`:

```js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { GAP_MS, activeMs, summarize, formatTable } = require("../plugins/usage/report.cjs");

const T0 = Date.parse("2026-10-01T03:00:00.000Z");
const at = (min, extra = {}) => ({
  ts: new Date(T0 + min * 60_000).toISOString(), route: "native", user: "sato",
  sessionId: "s1", deviceId: "d1", outcome: "ok", durationMs: 60_000,
  inputTokens: 10, outputTokens: 20, cacheCreationTokens: 1, cacheReadTokens: 2, ...extra,
});

test("activeMs merges intervals up to the gap and splits beyond it", () => {
  assert.equal(GAP_MS, 5 * 60_000);
  assert.equal(activeMs([]), 0);
  assert.equal(activeMs([at(0)]), 60_000, "one request = its own duration");
  // 0-1, 3-4 (gap 2 min → merged: 0-4), then 20-21 (gap 16 min → new span)
  assert.equal(activeMs([at(20), at(0), at(3)]), 4 * 60_000 + 60_000);
  // exactly on the gap: end 1, next start 6 → still merged (0-7)
  assert.equal(activeMs([at(0), at(6)]), 7 * 60_000);
  // overlapping requests are not double counted
  assert.equal(activeMs([at(0, { durationMs: 10 * 60_000 }), at(2)]), 10 * 60_000);
  assert.equal(activeMs([at(0, { ts: "garbage" }), at(1, { durationMs: null })]), 0);
});

test("summarize groups by user then route and counts outcomes", () => {
  const rows = summarize([
    at(0), at(2, { outcome: "blocked" }), at(30, { sessionId: "s2", deviceId: "d2" }),
    at(40, { outcome: "upstream_error", inputTokens: null, outputTokens: null }),
    at(0, { route: "api", sessionId: null, deviceId: null, cacheCreationTokens: null, cacheReadTokens: null }),
    at(0, { user: "aoki", outcome: "ok" }),
    at(1, { user: null, outcome: "rejected", sessionId: null, deviceId: "d9" }),
  ]);
  assert.deepEqual(rows.map((r) => [r.user, r.route]), [["(no key)", "native"], ["aoki", "native"], ["sato", "api"], ["sato", "native"]]);
  const sato = rows[3];
  assert.equal(sato.requests, 4);
  assert.equal(sato.blocked, 1);
  assert.equal(sato.errors, 1);
  assert.equal(sato.rejected, 0);
  assert.equal(sato.inputTokens, 30);
  assert.equal(sato.outputTokens, 60);
  assert.equal(sato.cacheCreationTokens, 4);
  assert.equal(sato.cacheReadTokens, 8);
  assert.equal(sato.devices, 2);
  assert.equal(sato.sessions, 2);
  // s1: 0-1 and 2-3 merged (3 min) + 40-41 (1 min). s2: 30-31 (1 min).
  assert.equal(sato.activeMinutes, 5);
  const api = rows[2];
  assert.deepEqual([api.requests, api.sessions, api.devices, api.activeMinutes, api.cacheReadTokens], [1, 0, 0, 1, 0]);
  assert.deepEqual([rows[0].requests, rows[0].rejected, rows[0].devices], [1, 1, 1]);
});

test("summarize: api records without a session group per local day", () => {
  const day1 = new Date(2026, 9, 1, 23, 58).toISOString();
  const day2 = new Date(2026, 9, 2, 0, 1).toISOString();
  const rows = summarize([
    { ts: day1, route: "api", user: "sato", outcome: "ok", durationMs: 60_000 },
    { ts: day2, route: "api", user: "sato", outcome: "ok", durationMs: 60_000 },
  ]);
  assert.equal(rows[0].activeMinutes, 2, "3 minutes apart but on different days → two spans");
});

test("formatTable: header, aligned rows, thousands separators, empty set", () => {
  const out = formatTable(summarize([at(0, { inputTokens: 1234567 }), at(0, { route: "api", sessionId: null })]));
  const lines = out.split("\n");
  assert.match(lines[0], /^user\s+route\s+reqs\s+blocked\s+rejected\s+errors\s+input\s+output\s+cache-w\s+cache-r\s+devices\s+sessions\s+active$/);
  assert.equal(lines.length, 3);
  assert.match(lines[2], /^sato\s+native\s+1\s+0\s+0\s+0\s+1,234,567\s+20\s+1\s+2\s+1\s+1\s+1m$/);
  assert.ok(lines.every((l) => l.length === lines[0].length || l.trimEnd() === l), "no ragged trailing space");
  assert.equal(formatTable([]), "");
  const long = formatTable(summarize([at(0, { durationMs: 125 * 60_000 })]));
  assert.match(long.split("\n")[1], /2h 5m$/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/usage-records.test.js test/usage-report.test.js`
Expected: FAIL with `Cannot find module '../plugins/usage/records.cjs'` and `'../plugins/usage/report.cjs'`

- [ ] **Step 3: Write `plugins/usage/records.cjs`**

```js
"use strict";
// records.cjs — the usage log: one JSON line per request in
// <stateDir>/usage/YYYY-MM-DD.jsonl (local date). Metadata only. FIELDS is a
// whitelist: whatever else a record object carries never reaches the disk.

const fs = require("fs");
const path = require("path");

const FIELDS = [
  "ts", "route", "path", "user", "deviceId", "accountUuid", "sessionId",
  "model", "stream", "status", "outcome", "durationMs",
  "inputTokens", "outputTokens", "cacheCreationTokens", "cacheReadTokens",
  "tools", "toolCalls",
];
const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;

function dayOf(date) {
  const p = (v) => String(v).padStart(2, "0");
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

function shape(record) {
  const out = {};
  for (const f of FIELDS) out[f] = record[f] === undefined ? null : record[f];
  if (out.toolCalls === null && Array.isArray(out.tools)) out.toolCalls = out.tools.length;
  return out;
}

function append(dir, record) {
  const line = shape(record);
  let when = new Date(line.ts);
  if (Number.isNaN(when.getTime())) {
    when = new Date();
    line.ts = when.toISOString();
  }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.appendFileSync(path.join(dir, dayOf(when) + ".jsonl"), JSON.stringify(line) + "\n", { mode: 0o600 });
}

function readRange(dir, from, to) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const name of names.sort()) {
    const m = DAY_FILE.exec(name);
    if (!m || m[1] < from || m[1] > to) continue;
    for (const line of fs.readFileSync(path.join(dir, name), "utf8").split("\n")) {
      if (!line) continue;
      try {
        const rec = JSON.parse(line);
        if (rec && typeof rec === "object") out.push(rec);
      } catch { /* a line cut short by a crash: skip it */ }
    }
  }
  return out;
}

module.exports = { FIELDS, dayOf, append, readRange };
```

- [ ] **Step 4: Write `plugins/usage/report.cjs`**

```js
"use strict";
// report.cjs — per-user aggregation of usage records.

const { dayOf } = require("./records.cjs");

const GAP_MS = 5 * 60 * 1000;
const NO_KEY = "(no key)";

/** Active time of one session: each record is [ts, ts + durationMs]; intervals
 *  at most GAP_MS apart merge into a span; the result is the spans' total. */
function activeMs(records) {
  const spans = [];
  for (const r of records) {
    const start = Date.parse(r.ts);
    if (Number.isNaN(start)) continue;
    spans.push([start, start + (typeof r.durationMs === "number" && r.durationMs > 0 ? r.durationMs : 0)]);
  }
  spans.sort((a, b) => a[0] - b[0]);
  let total = 0;
  let cur = null;
  for (const [start, end] of spans) {
    if (cur && start - cur[1] <= GAP_MS) cur[1] = Math.max(cur[1], end);
    else {
      if (cur) total += cur[1] - cur[0];
      cur = [start, end];
    }
  }
  if (cur) total += cur[1] - cur[0];
  return total;
}

function summarize(records) {
  const groups = new Map();
  for (const r of records) {
    const user = typeof r.user === "string" && r.user ? r.user : NO_KEY;
    const route = typeof r.route === "string" && r.route ? r.route : "?";
    const id = user + "\u0000" + route;
    let g = groups.get(id);
    if (!g) {
      g = {
        user, route, requests: 0, blocked: 0, rejected: 0, errors: 0,
        inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0,
        deviceIds: new Set(), sessionIds: new Set(), buckets: new Map(),
      };
      groups.set(id, g);
    }
    g.requests++;
    if (r.outcome === "blocked") g.blocked++;
    else if (r.outcome === "rejected") g.rejected++;
    else if (r.outcome !== "ok") g.errors++;
    for (const f of ["inputTokens", "outputTokens", "cacheCreationTokens", "cacheReadTokens"]) {
      if (typeof r[f] === "number") g[f] += r[f];
    }
    if (r.deviceId) g.deviceIds.add(r.deviceId);
    if (r.sessionId) g.sessionIds.add(r.sessionId);
    // No session id (api route): one bucket per local day.
    const when = new Date(r.ts);
    const bucket = r.sessionId ? "s:" + r.sessionId : "d:" + (Number.isNaN(when.getTime()) ? "?" : dayOf(when));
    if (!g.buckets.has(bucket)) g.buckets.set(bucket, []);
    g.buckets.get(bucket).push(r);
  }
  return [...groups.values()]
    .map((g) => {
      let ms = 0;
      for (const recs of g.buckets.values()) ms += activeMs(recs);
      return {
        user: g.user, route: g.route, requests: g.requests,
        blocked: g.blocked, rejected: g.rejected, errors: g.errors,
        inputTokens: g.inputTokens, outputTokens: g.outputTokens,
        cacheCreationTokens: g.cacheCreationTokens, cacheReadTokens: g.cacheReadTokens,
        devices: g.deviceIds.size, sessions: g.sessionIds.size,
        activeMinutes: Math.round(ms / 60000),
      };
    })
    .sort((a, b) => (a.user < b.user ? -1 : a.user > b.user ? 1 : a.route < b.route ? -1 : a.route > b.route ? 1 : 0));
}

function minutes(m) {
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
}

function formatTable(rows) {
  if (!rows.length) return "";
  const num = (v) => v.toLocaleString("en-US");
  const cols = [
    ["user", (r) => r.user, false], ["route", (r) => r.route, false],
    ["reqs", (r) => num(r.requests), true], ["blocked", (r) => num(r.blocked), true],
    ["rejected", (r) => num(r.rejected), true], ["errors", (r) => num(r.errors), true],
    ["input", (r) => num(r.inputTokens), true], ["output", (r) => num(r.outputTokens), true],
    ["cache-w", (r) => num(r.cacheCreationTokens), true], ["cache-r", (r) => num(r.cacheReadTokens), true],
    ["devices", (r) => num(r.devices), true], ["sessions", (r) => num(r.sessions), true],
    ["active", (r) => minutes(r.activeMinutes), true],
  ];
  const cells = [cols.map((c) => c[0]), ...rows.map((r) => cols.map((c) => c[1](r)))];
  const width = cols.map((_, i) => Math.max(...cells.map((row) => row[i].length)));
  return cells
    .map((row) => row.map((v, i) => (cols[i][2] ? v.padStart(width[i]) : v.padEnd(width[i]))).join("  ").trimEnd())
    .join("\n");
}

module.exports = { GAP_MS, NO_KEY, activeMs, summarize, formatTable };
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test test/usage-records.test.js test/usage-report.test.js`
Expected: `pass 10`, `fail 0`

- [ ] **Step 6: Commit**

```bash
git add plugins/usage/records.cjs plugins/usage/report.cjs test/usage-records.test.js test/usage-report.test.js
git commit -m "usage plugin: metadata-only day log and per-user report

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: `plugins/usage/index.cjs` — hooks and CLI

**Files:**
- Create: `plugins/usage/index.cjs`
- Modify: `package.json:19-25` (`files`)
- Test: `test/usage-plugin.test.js`

**Interfaces:**
- Consumes: `keys.add/verify/revoke/list` (Task 3), `records.append/readRange/dayOf` (Task 4), `report.summarize/formatTable` (Task 4), the plugin contract (Task 2).
- Produces: a plugin module `{ name: "usage", init, onRequest, onComplete, cli }`.
  - `cli(argv, { stateDir, out(str), err(str), now? }) → exit code`.
  - `onRequest` always returns `{ identity: { user, deviceId, accountUuid, sessionId }, stripHeaders: ["x-barnowl-key"] }`, plus `reject` when the key is missing/invalid and `requireKey` is not `false`.

- [ ] **Step 1: Write the failing test**

Create `test/usage-plugin.test.js`:

```js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const usage = require("../plugins/usage/index.cjs");
const keys = require("../plugins/usage/keys.cjs");
const records = require("../plugins/usage/records.cjs");

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "barnowl-usage-"));
test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
let n = 0;
function fresh(options = {}) {
  const stateDir = path.join(ROOT, `s${++n}`);
  usage.init(options, { stateDir, log() {} });
  return { stateDir, dir: path.join(stateDir, "usage") };
}
const META = JSON.stringify({ device_id: "dev1", account_uuid: "acc1", session_id: "ses1" });
const nativeReq = (headers, metadata = { user_id: META }) => ({ route: "native", path: "/v1/messages", headers, body: { model: "m", metadata } });
function io() {
  const o = { out: [], err: [] };
  return { ...o, ctx: (stateDir, now) => ({ stateDir, now, out: (s) => o.out.push(s), err: (s) => o.err.push(s) }) };
}

test("name and hooks are exported", () => {
  assert.equal(usage.name, "usage");
  for (const f of ["init", "onRequest", "onComplete", "cli"]) assert.equal(typeof usage[f], "function");
});

test("valid key → user + device/account/session; the key header is always stripped", () => {
  const { dir } = fresh();
  const key = keys.add(dir, "sato");
  const r = usage.onRequest(nativeReq({ "x-barnowl-key": key }));
  assert.deepEqual(r, {
    identity: { user: "sato", deviceId: "dev1", accountUuid: "acc1", sessionId: "ses1" },
    stripHeaders: ["x-barnowl-key"],
  });
});

test("a key with stray whitespace around it still works", () => {
  const { dir } = fresh();
  const key = keys.add(dir, "sato");
  assert.equal(usage.onRequest(nativeReq({ "x-barnowl-key": `  ${key} \t` })).identity.user, "sato");
});

test("missing, wrong, revoked and duplicated keys are rejected with 401", () => {
  const { dir } = fresh();
  const key = keys.add(dir, "sato");
  const dead = keys.add(dir, "tanaka");
  keys.revoke(dir, "tanaka");
  for (const headers of [{}, { "x-barnowl-key": "bo_wrong" }, { "x-barnowl-key": dead }, { "x-barnowl-key": `${key}, ${key}` }, { "x-barnowl-key": "" }]) {
    const r = usage.onRequest(nativeReq(headers));
    assert.deepEqual(r.reject, {
      status: 401, type: "authentication_error",
      message: "barnowl: missing or invalid X-Barnowl-Key (ask your administrator)",
    });
    assert.equal(r.identity.user, null);
    assert.equal(r.identity.deviceId, "dev1", "a rejected request is still attributed to its device");
    assert.deepEqual(r.stripHeaders, ["x-barnowl-key"]);
  }
});

test("requireKey: false lets keyless requests through as unknown", () => {
  fresh({ requireKey: false });
  const r = usage.onRequest(nativeReq({}));
  assert.equal(r.reject, undefined);
  assert.equal(r.identity.user, "unknown");
});

test("metadata that is absent, not JSON, or the wrong shape is ignored", () => {
  const { dir } = fresh();
  const key = keys.add(dir, "sato");
  const none = { user: "sato", deviceId: null, accountUuid: null, sessionId: null };
  for (const metadata of [null, {}, { user_id: "plain-string-id" }, { user_id: "[1,2]" }, { user_id: 42 }, { user_id: '{"device_id":7}' }]) {
    assert.deepEqual(usage.onRequest(nativeReq({ "x-barnowl-key": key }, metadata)).identity, none, JSON.stringify(metadata));
  }
});

test("api route: key identifies the user; metadata is not read", () => {
  const { dir } = fresh();
  const key = keys.add(dir, "sato");
  const r = usage.onRequest({ route: "api", path: "/v1/chat/completions", headers: { "x-barnowl-key": key }, body: { model: "sonnet", metadata: { user_id: META } } });
  assert.deepEqual(r.identity, { user: "sato", deviceId: null, accountUuid: null, sessionId: null });
});

test("onComplete appends the record to today's file", () => {
  const { dir } = fresh();
  const ts = new Date().toISOString();
  usage.onComplete({ ts, route: "native", user: "sato", status: 200, outcome: "ok", inputTokens: 3 });
  const today = records.dayOf(new Date());
  const [rec] = records.readRange(dir, today, today);
  assert.equal(rec.user, "sato");
  assert.equal(rec.inputTokens, 3);
});

test("cli key add / list / revoke", () => {
  const { stateDir, dir } = fresh();
  const a = io();
  assert.equal(usage.cli(["key", "add", "sato"], a.ctx(stateDir)), 0);
  const key = /bo_[A-Za-z0-9_-]{43}/.exec(a.out.join("\n"))[0];
  assert.equal(keys.verify(dir, key), "sato");
  assert.match(a.out.join("\n"), /ANTHROPIC_CUSTOM_HEADERS="X-Barnowl-Key: bo_/);

  const l = io();
  assert.equal(usage.cli(["key", "list"], l.ctx(stateDir)), 0);
  assert.match(l.out.join("\n"), /sato\s+active/);
  assert.ok(!l.out.join("\n").includes(key));

  const r = io();
  assert.equal(usage.cli(["key", "revoke", "sato"], r.ctx(stateDir)), 0);
  assert.equal(keys.verify(dir, key), null);
  const again = io();
  assert.equal(usage.cli(["key", "revoke", "sato"], again.ctx(stateDir)), 1);

  const l2 = io();
  usage.cli(["key", "list"], l2.ctx(stateDir));
  assert.match(l2.out.join("\n"), /sato\s+revoked/);
});

test("cli key: bad input prints usage and exits 1; a refused name explains why", () => {
  const { stateDir } = fresh();
  for (const argv of [["key"], ["key", "add"], ["key", "revoke"], ["key", "frobnicate", "x"]]) {
    const o = io();
    assert.equal(usage.cli(argv, o.ctx(stateDir)), 1, argv.join(" "));
    assert.match(o.err.join("\n"), /barnowl usage key add <user>/);
  }
  const o = io();
  assert.equal(usage.cli(["key", "add", "unknown"], o.ctx(stateDir)), 1);
  assert.match(o.err.join("\n"), /user must be/);
});

test("cli report: default 7 days, --days, --from/--to, --json, empty", () => {
  const { stateDir, dir } = fresh();
  const now = new Date(2026, 9, 10, 12, 0, 0);
  const on = (day, extra) => records.append(dir, {
    ts: new Date(2026, 9, day, 9, 0, 0).toISOString(), route: "native", user: "sato",
    sessionId: "s" + day, outcome: "ok", durationMs: 60000, inputTokens: 100, outputTokens: 10, ...extra,
  });
  on(1); on(4); on(9); on(10, { route: "api", sessionId: null });

  const empty = io();
  assert.equal(usage.cli(["--from", "2025-01-01", "--to", "2025-01-02"], empty.ctx(stateDir, now)), 0);
  assert.match(empty.out.join("\n"), /No usage recorded between 2025-01-01 and 2025-01-02/);

  const def = io();
  assert.equal(usage.cli([], def.ctx(stateDir, now)), 0);
  const text = def.out.join("\n");
  assert.match(text, /Usage 2026-10-04 → 2026-10-10/);
  assert.match(text, /sato\s+api\s+1/);
  assert.match(text, /sato\s+native\s+2/);

  const j = io();
  assert.equal(usage.cli(["--days", "1", "--json"], j.ctx(stateDir, now)), 0);
  const parsed = JSON.parse(j.out.join("\n"));
  assert.equal(parsed.from, "2026-10-10");
  assert.equal(parsed.to, "2026-10-10");
  assert.deepEqual(parsed.rows.map((r) => [r.user, r.route, r.requests]), [["sato", "api", 1]]);

  const range = io();
  assert.equal(usage.cli(["--from", "2026-10-01", "--to", "2026-10-04", "--json"], range.ctx(stateDir, now)), 0);
  assert.equal(JSON.parse(range.out.join("\n")).rows[0].requests, 2);
});

test("cli report: bad options exit 1 with a reason", () => {
  const { stateDir } = fresh();
  for (const [argv, re] of [
    [["--days", "0"], /--days/], [["--days", "abc"], /--days/], [["--days"], /--days/],
    [["--from", "10/01"], /YYYY-MM-DD/], [["--from", "2026-10-05", "--to", "2026-10-01"], /after/],
    [["--bogus"], /unknown option/],
  ]) {
    const o = io();
    assert.equal(usage.cli(argv, o.ctx(stateDir)), 1, argv.join(" "));
    assert.match(o.err.join("\n"), re);
  }
});

test("the loader finds this plugin by its bare name", () => {
  const plugins = require("../lib/plugins.cjs");
  const saved = { p: process.env.BARNOWL_PLUGINS, s: process.env.BARNOWL_STATE_DIR };
  process.env.BARNOWL_STATE_DIR = path.join(ROOT, "loader");
  process.env.BARNOWL_PLUGINS = JSON.stringify({ usage: { requireKey: false } });
  plugins._reset();
  try {
    assert.deepEqual(plugins.load().map((p) => p.name), ["usage"]);
  } finally {
    for (const [k, v] of [["BARNOWL_PLUGINS", saved.p], ["BARNOWL_STATE_DIR", saved.s]]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    plugins._reset();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/usage-plugin.test.js`
Expected: FAIL with `Cannot find module '../plugins/usage/index.cjs'`

- [ ] **Step 3: Write the implementation**

Create `plugins/usage/index.cjs`:

```js
"use strict";
// usage plugin — who used barnowl, when, with which model, and how many tokens.
//
// Enable:   { "plugins": { "usage": {} } }             (config file)
// Options:  requireKey (default true) — false lets keyless requests through,
//           recorded as user "unknown".
// Client:   ANTHROPIC_CUSTOM_HEADERS="X-Barnowl-Key: <key>"   (Claude Code)
//           or the X-Barnowl-Key header on any OpenAI / Ollama client.
// Admin:    barnowl usage key add <user> | key revoke <user> | key list
//           barnowl usage [--days N | --from D --to D] [--json]
//
// Records are metadata only (records.cjs FIELDS): no prompt, no response, no key.

const path = require("path");
const keys = require("./keys.cjs");
const records = require("./records.cjs");
const report = require("./report.cjs");

const HEADER = "x-barnowl-key";
const REJECT = {
  status: 401,
  type: "authentication_error",
  message: "barnowl: missing or invalid X-Barnowl-Key (ask your administrator)",
};
const KEY_USAGE = "Usage: barnowl usage key add <user> | barnowl usage key revoke <user> | barnowl usage key list";

let state = { dir: null, requireKey: true };

function init(options, ctx) {
  state = { dir: path.join(ctx.stateDir, "usage"), requireKey: !(options && options.requireKey === false) };
}

/** Claude Code puts a JSON string in metadata.user_id:
 *  {"device_id","account_uuid","session_id"}. Anything else is ignored. */
function parseMetadata(body) {
  const none = { deviceId: null, accountUuid: null, sessionId: null };
  const raw = body && body.metadata && body.metadata.user_id;
  if (typeof raw !== "string") return none;
  let m;
  try { m = JSON.parse(raw); } catch { return none; }
  if (!m || typeof m !== "object" || Array.isArray(m)) return none;
  const str = (v) => (typeof v === "string" && v ? v : null);
  return { deviceId: str(m.device_id), accountUuid: str(m.account_uuid), sessionId: str(m.session_id) };
}

function onRequest({ route, headers, body }) {
  const meta = route === "native" ? parseMetadata(body) : { deviceId: null, accountUuid: null, sessionId: null };
  const raw = headers ? headers[HEADER] : undefined;
  const user = typeof raw === "string" ? keys.verify(state.dir, raw.trim()) : null;
  const base = { stripHeaders: [HEADER] };
  if (user) return { identity: { user, ...meta }, ...base };
  if (!state.requireKey) return { identity: { user: "unknown", ...meta }, ...base };
  return { identity: { user: null, ...meta }, ...base, reject: { ...REJECT } };
}

function onComplete(record) {
  records.append(state.dir, record);
}

function parseReportArgs(argv, now) {
  let days = 7;
  let from = null;
  let to = null;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--days") days = Number(argv[++i]);
    else if (a === "--from") from = argv[++i];
    else if (a === "--to") to = argv[++i];
    else if (a === "--json") json = true;
    else return { error: `unknown option: ${a}` };
  }
  const DAY = /^\d{4}-\d{2}-\d{2}$/;
  if ((from !== null && !DAY.test(String(from))) || (to !== null && !DAY.test(String(to)))) {
    return { error: "--from and --to take a date as YYYY-MM-DD" };
  }
  if (from === null && (!Number.isInteger(days) || days < 1)) return { error: "--days takes a positive whole number" };
  const end = to === null ? now : new Date(`${to}T12:00:00`);
  if (to === null) to = records.dayOf(now);
  if (from === null) {
    const start = new Date(end);
    start.setDate(start.getDate() - (days - 1));
    from = records.dayOf(start);
  }
  if (from > to) return { error: `--from ${from} is after --to ${to}` };
  return { from, to, json };
}

function cliKey(argv, dir, ctx) {
  const [sub, user] = argv;
  if (sub === "add" && user) {
    let key;
    try { key = keys.add(dir, user); }
    catch (e) { ctx.err(e.message); return 1; }
    ctx.out([
      `Key for ${user} (shown once — it cannot be recovered, only revoked):`,
      "",
      `  ${key}`,
      "",
      "Claude Code:",
      `  export ANTHROPIC_CUSTOM_HEADERS="X-Barnowl-Key: ${key}"`,
      "Other clients: send the header  X-Barnowl-Key: <key>",
    ].join("\n"));
    return 0;
  }
  if (sub === "revoke" && user) {
    const n = keys.revoke(dir, user);
    if (!n) { ctx.err(`No active key for ${user}.`); return 1; }
    ctx.out(`Revoked ${n} key${n === 1 ? "" : "s"} for ${user}.`);
    return 0;
  }
  if (sub === "list" && argv.length === 1) {
    const all = keys.list(dir);
    if (!all.length) { ctx.out("No keys issued."); return 0; }
    const width = Math.max(4, ...all.map((k) => k.user.length));
    ctx.out(all.map((k) => `${k.user.padEnd(width)}  ${k.revokedAt ? "revoked" : "active "}  created ${k.createdAt || "?"}${k.revokedAt ? `  revoked ${k.revokedAt}` : ""}`).join("\n"));
    return 0;
  }
  ctx.err(KEY_USAGE);
  return 1;
}

/** `barnowl usage ...` — ctx: { stateDir, out, err, now? }. Returns an exit code. */
function cli(argv, ctx) {
  const dir = path.join(ctx.stateDir, "usage");
  if (argv[0] === "key") return cliKey(argv.slice(1), dir, ctx);
  const args = parseReportArgs(argv, ctx.now || new Date());
  if (args.error) {
    ctx.err(`${args.error}\nUsage: barnowl usage [--days N | --from YYYY-MM-DD --to YYYY-MM-DD] [--json]\n${KEY_USAGE}`);
    return 1;
  }
  const rows = report.summarize(records.readRange(dir, args.from, args.to));
  if (args.json) {
    ctx.out(JSON.stringify({ from: args.from, to: args.to, rows }, null, 2));
    return 0;
  }
  if (!rows.length) {
    ctx.out(`No usage recorded between ${args.from} and ${args.to}.`);
    return 0;
  }
  ctx.out(`Usage ${args.from} → ${args.to}\n\n${report.formatTable(rows)}`);
  return 0;
}

module.exports = { name: "usage", init, onRequest, onComplete, cli };
```

- [ ] **Step 4: Ship the plugin directory in the npm package**

In `package.json`, the `files` array (lines 19-25) gains `"plugins"`:

```json
  "files": [
    "bin",
    "lib",
    "plugins",
    "config",
    "vendor",
    "README.md"
  ],
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test test/usage-plugin.test.js`
Expected: `pass 13`, `fail 0`

- [ ] **Step 6: Commit**

```bash
git add plugins/usage/index.cjs package.json test/usage-plugin.test.js
git commit -m "usage plugin: key check on request, record on completion, CLI

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: `/v1/messages` passthrough runs the plugins

**Files:**
- Modify: `lib/guard.cjs:27-31` (requires), `lib/guard.cjs:362-416` (`handleMessages`), `lib/guard.cjs:418` (exports)
- Test: `test/passthrough-plugins.test.js`

**Interfaces:**
- Consumes: `plugins.enabled/begin` (Task 2), `createTap` (Task 1), the `usage` plugin (Task 5).
- Produces: `guard.plugins` — the `lib/plugins.cjs` module, re-exported so the otterly patch (Task 7) reaches it through the already-imported `__barnowlGuard`.

- [ ] **Step 1: Write the failing test**

Create `test/passthrough-plugins.test.js`:

```js
"use strict";
process.env.BARNOWL_GUARD_MASK_TIMEOUT_MS = "1500";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const STATE = fs.mkdtempSync(path.join(os.tmpdir(), "barnowl-pass-"));
process.env.BARNOWL_STATE_DIR = STATE;
delete process.env.BARNOWL_GUARD;
delete process.env.BARNOWL_PLUGINS;

const guard = require("../lib/guard.cjs");
const keys = require("../plugins/usage/keys.cjs");
const records = require("../plugins/usage/records.cjs");

const USAGE_DIR = path.join(STATE, "usage");
test.after(() => fs.rmSync(STATE, { recursive: true, force: true }));

const maskStub = path.join(STATE, "mask.js");
fs.writeFileSync(maskStub, `
  let d = "";
  process.stdin.on("data", (c) => (d += c));
  process.stdin.on("end", () => process.stdout.write(d.split("SECRET").join("<MASKED>")));
`);
const MASK_CMD = `node ${JSON.stringify(maskStub)}`;

const SSE = [
  'data: {"type":"message_start","message":{"usage":{"input_tokens":12,"cache_creation_input_tokens":3,"cache_read_input_tokens":100,"output_tokens":1}}}',
  "",
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"t1","name":"Read","input":{}}}',
  "",
  'data: {"type":"message_delta","delta":{},"usage":{"output_tokens":40}}',
  "",
  "",
].join("\n");
const META = JSON.stringify({ device_id: "dev1", account_uuid: "acc1", session_id: "ses1" });
const PROMPT = "TOPSECRET-PROMPT-TEXT";

const listen = (server) => new Promise((r) => server.listen(0, "127.0.0.1", () => r(server.address().port)));
const today = () => records.dayOf(new Date());
const allRecords = () => records.readRange(USAGE_DIR, today(), today());

/** Run fn against a front (handleMessages) + mock upstream pair. */
async function withServers(env, upstreamHandler, fn) {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      seen.push({ headers: req.headers, raw });
      upstreamHandler(req, res, raw);
    });
  });
  const front = http.createServer((req, res) => guard.handleMessages(req, res));
  const upPort = await listen(upstream);
  const frontPort = await listen(front);
  const vars = { BARNOWL_GUARD_UPSTREAM: `http://127.0.0.1:${upPort}`, ...env };
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  guard.plugins._reset();
  try {
    await fn({
      seen,
      post: (headers, body) => fetch(`http://127.0.0.1:${frontPort}/v1/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer sk-test", ...headers },
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
    });
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    guard.plugins._reset();
    upstream.closeAllConnections?.();
    front.closeAllConnections?.();
    upstream.close();
    front.close();
  }
}

const sseReply = (req, res) => {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  res.end(SSE);
};
const body = (extra = {}) => ({
  model: "claude-haiku-4-5", max_tokens: 10, stream: true,
  metadata: { user_id: META }, messages: [{ role: "user", content: PROMPT }], ...extra,
});
const USAGE_ON = { BARNOWL_PLUGINS: JSON.stringify({ usage: {} }) };
const resetLog = () => fs.rmSync(USAGE_DIR, { recursive: true, force: true });

test("no plugins configured: nothing is recorded and no usage dir appears", async () => {
  resetLog();
  await withServers({ BARNOWL_PLUGINS: undefined }, sseReply, async ({ post, seen }) => {
    const resp = await post({ "X-Barnowl-Key": "bo_whatever" }, body());
    assert.equal(resp.status, 200);
    await resp.text();
    assert.equal(seen.length, 1);
    assert.equal(seen[0].headers["x-barnowl-key"], "bo_whatever", "untouched without plugins");
  });
  assert.equal(fs.existsSync(USAGE_DIR), false);
});

test("no key → 401 in anthropic shape, upstream not called, request recorded as rejected", async () => {
  resetLog();
  await withServers(USAGE_ON, sseReply, async ({ post, seen }) => {
    const resp = await post({}, body());
    assert.equal(resp.status, 401);
    assert.deepEqual(await resp.json(), {
      type: "error",
      error: { type: "authentication_error", message: "barnowl: missing or invalid X-Barnowl-Key (ask your administrator)" },
    });
    assert.equal(seen.length, 0);
  });
  const [rec] = allRecords();
  assert.deepEqual([rec.route, rec.user, rec.outcome, rec.status, rec.deviceId], ["native", null, "rejected", 401, "dev1"]);
});

test("valid key → forwarded without the key header; tokens, tools and identity recorded; no text on disk", async () => {
  resetLog();
  const key = keys.add(USAGE_DIR, "sato");
  await withServers(USAGE_ON, sseReply, async ({ post, seen }) => {
    const sent = JSON.stringify(body());
    const resp = await post({ "X-Barnowl-Key": key, "anthropic-version": "2023-06-01" }, sent);
    assert.equal(resp.status, 200);
    assert.equal(await resp.text(), SSE, "the response is passed through byte for byte");
    assert.equal(seen[0].headers["x-barnowl-key"], undefined, "the key must never reach the upstream");
    assert.equal(seen[0].headers.authorization, "Bearer sk-test");
    assert.equal(seen[0].headers["anthropic-version"], "2023-06-01");
    assert.equal(seen[0].raw, sent, "guard off → body forwarded verbatim");
  });
  const [rec] = allRecords();
  assert.deepEqual(
    [rec.route, rec.path, rec.user, rec.deviceId, rec.accountUuid, rec.sessionId, rec.model, rec.stream, rec.status, rec.outcome],
    ["native", "/v1/messages", "sato", "dev1", "acc1", "ses1", "claude-haiku-4-5", true, 200, "ok"],
  );
  assert.deepEqual(
    [rec.inputTokens, rec.outputTokens, rec.cacheCreationTokens, rec.cacheReadTokens, rec.tools, rec.toolCalls],
    [12, 40, 3, 100, ["Read"], 1],
  );
  assert.ok(Number.isInteger(rec.durationMs));
  const disk = fs.readdirSync(USAGE_DIR).map((f) => fs.readFileSync(path.join(USAGE_DIR, f), "utf8")).join("\n");
  assert.ok(!disk.includes(PROMPT), "prompt text must not be stored");
  assert.ok(!disk.includes(key), "the raw key must not be stored");
  assert.ok(!disk.includes("sk-test"), "the client's credential must not be stored");
});

test("non-streaming JSON response: usage read from the body", async () => {
  resetLog();
  const key = keys.add(USAGE_DIR, "sato");
  const reply = (req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ id: "msg_1", content: [{ type: "text", text: "ok" }], usage: { input_tokens: 7, output_tokens: 2 } }));
  };
  await withServers(USAGE_ON, reply, async ({ post }) => {
    const resp = await post({ "X-Barnowl-Key": key }, body({ stream: false }));
    assert.equal((await resp.json()).id, "msg_1");
  });
  const [rec] = allRecords();
  assert.deepEqual([rec.stream, rec.inputTokens, rec.outputTokens, rec.tools], [false, 7, 2, []]);
});

test("guard on: a blocked image is recorded against the user; masked text still forwards", async () => {
  resetLog();
  const key = keys.add(USAGE_DIR, "sato");
  const env = { ...USAGE_ON, BARNOWL_GUARD: "1", BARNOWL_GUARD_MASK_CMD: MASK_CMD };
  await withServers(env, sseReply, async ({ post, seen }) => {
    const image = body({ messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }] }] });
    const blocked = await post({ "X-Barnowl-Key": key }, image);
    assert.equal(blocked.status, 403);
    assert.equal((await blocked.json()).error.type, "guard_blocked");
    assert.equal(seen.length, 0);

    const ok = await post({ "X-Barnowl-Key": key }, body({ messages: [{ role: "user", content: "my SECRET" }] }));
    assert.equal(ok.status, 200);
    await ok.text();
    assert.equal(JSON.parse(seen[0].raw).messages[0].content, "my <MASKED>");
    assert.equal(seen[0].headers["x-barnowl-key"], undefined);
  });
  assert.deepEqual(allRecords().map((r) => [r.user, r.outcome, r.status]), [["sato", "blocked", 403], ["sato", "ok", 200]]);
});

test("requireKey: false → keyless request passes and is recorded as unknown", async () => {
  resetLog();
  await withServers({ BARNOWL_PLUGINS: JSON.stringify({ usage: { requireKey: false } }) }, sseReply, async ({ post, seen }) => {
    const resp = await post({}, body());
    assert.equal(resp.status, 200);
    await resp.text();
    assert.equal(seen.length, 1);
  });
  assert.deepEqual(allRecords().map((r) => [r.user, r.outcome]), [["unknown", "ok"]]);
});

test("upstream error and unreachable upstream are recorded as upstream_error", async () => {
  resetLog();
  const key = keys.add(USAGE_DIR, "sato");
  const overloaded = (req, res) => {
    res.writeHead(529, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }));
  };
  await withServers(USAGE_ON, overloaded, async ({ post }) => {
    const resp = await post({ "X-Barnowl-Key": key }, body());
    assert.equal(resp.status, 529);
    assert.equal((await resp.json()).error.type, "overloaded_error");
  });
  await withServers({ ...USAGE_ON, BARNOWL_GUARD_UPSTREAM: "http://127.0.0.1:1" }, sseReply, async ({ post }) => {
    const resp = await post({ "X-Barnowl-Key": key }, body());
    assert.equal(resp.status, 502);
    await resp.text();
  });
  assert.deepEqual(allRecords().map((r) => [r.outcome, r.status, r.inputTokens]), [["upstream_error", 529, null], ["upstream_error", 502, null]]);
});

test("upstream drops mid-stream: the request is still recorded with what was seen", async () => {
  resetLog();
  const key = keys.add(USAGE_DIR, "sato");
  const drop = (req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(SSE.split("\n").slice(0, 2).join("\n") + "\n"); // message_start only
    setTimeout(() => res.destroy(), 30);
  };
  await withServers(USAGE_ON, drop, async ({ post }) => {
    const resp = await post({ "X-Barnowl-Key": key }, body());
    await resp.text().catch(() => {}); // the truncated body may or may not surface as an error client-side
  });
  for (let i = 0; i < 50 && allRecords().length === 0; i++) await new Promise((r) => setTimeout(r, 20));
  const [rec] = allRecords();
  assert.deepEqual([rec.user, rec.status, rec.inputTokens, rec.outputTokens], ["sato", 200, 12, 1]);
});

test("invalid JSON with plugins on → 400, upstream not called", async () => {
  resetLog();
  await withServers(USAGE_ON, sseReply, async ({ post, seen }) => {
    const resp = await post({}, "{not json");
    assert.equal(resp.status, 400);
    assert.equal((await resp.json()).error.type, "invalid_request_error");
    assert.equal(seen.length, 0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/passthrough-plugins.test.js`
Expected: FAIL — `guard.plugins` is undefined (`Cannot read properties of undefined (reading '_reset')`).

- [ ] **Step 3: Require the two modules in `lib/guard.cjs`**

After the existing requires (line 31, `const { createHash } = require("crypto");`) add:

```js
const plugins = require("./plugins.cjs");
const { createTap } = require("./anthropic-usage.cjs");
```

- [ ] **Step 4: Replace `handleMessages` (lines 362-416) with**

```js
/** POST /v1/messages: run plugins (identify the caller), mask (when the guard
 *  is on), then forward to the anthropic upstream with the client's own auth
 *  headers, streaming the response back. barnowl holds no API key of its own.
 *  Order matters: plugins run before the guard so a blocked request is still
 *  attributed to its user. */
async function handleMessages(req, res) {
  const send = (status, body) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
  let raw;
  try { raw = await readBody(req); }
  catch (e) { return send(413, anthropicError(413, "invalid_request_error", e.message).body); }

  const usePlugins = plugins.enabled();
  let payload = raw;
  let body = null;
  if (enabled() || usePlugins) {
    try { body = JSON.parse(raw.toString("utf8")); }
    catch { return send(400, anthropicError(400, "invalid_request_error", "invalid JSON body").body); }
  }

  let call = null;
  if (usePlugins) {
    const b = await plugins.begin({ route: "native", path: "/v1/messages", headers: req.headers, body });
    call = b.call;
    if (!b.ok) {
      const { status, type, message } = b.reject;
      await call.finish({ status, outcome: "rejected" });
      return send(status, anthropicError(status, type, message).body);
    }
  }

  if (enabled()) {
    try {
      await applyMask(collectAnthropic(body));
    } catch (e) {
      const msg = e instanceof GuardBlocked ? e.message : `guard failed closed: ${e.message}`;
      if (call) await call.finish({ status: 403, outcome: "blocked" });
      return send(403, anthropicError(403, "guard_blocked", msg).body);
    }
    payload = Buffer.from(JSON.stringify(body), "utf8");
  }

  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    const name = k.toLowerCase();
    if (HOP_HEADERS.has(name)) continue;
    if (call && call.stripHeaders.has(name)) continue; // e.g. x-barnowl-key: never leaves this machine
    headers[k] = v;
  }
  headers["content-length"] = String(payload.length);

  let upstream;
  try {
    upstream = await fetch(upstreamBase() + "/v1/messages", {
      method: "POST",
      headers,
      body: payload,
    });
  } catch (e) {
    if (call) await call.finish({ status: 502, outcome: "upstream_error" });
    return send(502, anthropicError(502, "api_error", `upstream unreachable: ${e.message}`).body);
  }

  const respHeaders = {};
  upstream.headers.forEach((v, k) => {
    if (!HOP_HEADERS.has(k) && k !== "content-encoding") respHeaders[k] = v;
  });
  const tap = call ? createTap(upstream.headers.get("content-type")) : null;
  res.writeHead(upstream.status, respHeaders);
  if (upstream.body) {
    try {
      for await (const chunk of upstream.body) {
        res.write(chunk);
        if (tap) tap.push(chunk);
      }
    } catch (_) { /* client or upstream dropped mid-stream */ }
  }
  res.end();
  if (call) {
    await call.finish({ status: upstream.status, outcome: upstream.ok ? "ok" : "upstream_error", ...tap.result() });
  }
}
```

- [ ] **Step 5: Export `plugins`**

In `module.exports` (line 418) add `plugins,` after `handleMessages,`:

```js
module.exports = {
  enabled,
  guardEngineBody,
  handleMessages,
  plugins,
```

(the rest of the export list is unchanged).

- [ ] **Step 6: Run the new test and the existing guard tests**

Run: `node --test test/passthrough-plugins.test.js test/guard.test.js`
Expected: `fail 0` (9 new tests plus the existing guard tests).

- [ ] **Step 7: Commit**

```bash
git add lib/guard.cjs test/passthrough-plugins.test.js
git commit -m "passthrough: run plugins before the guard, strip plugin headers, tap usage

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: otterly patches — engine routes (`api`)

**Files:**
- Modify: `lib/patch-otterly.js` — new locator after `findServerIndex` (line 170), new constants after the guard block (line 714), two `applyPatch` calls after line 877, two entries in `results` (line 890)
- Modify: `test/patch-otterly.test.js`

**Interfaces:**
- Consumes: `__barnowlGuard.plugins.enabled/beginEngine/attach` (Tasks 2 and 6), `globalThis.__barnowlOnMetrics` (Task 2).
- Produces: patched `node_modules/otterly/dist/server/index.js` and `server/metrics.js`.

- [ ] **Step 1: Write the failing tests**

Append to `test/patch-otterly.test.js`, before the final `models.js serves the catalog in place` test (which must stay last):

```js
test("server/index.js: plugins hook sits before the guard on engine routes", () => {
  const src = read("server/index.js");
  const hook = src.indexOf("barnowl: plugins on engine routes");
  const guardBlock = src.indexOf("barnowl: outbound PII guard on engine routes");
  assert.ok(hook > 0, "plugins hook present");
  assert.ok(hook < guardBlock, "plugins run before the guard so blocked requests are attributed");
  assert.ok(src.includes("await __barnowlGuard.plugins.beginEngine(path, req.headers, parsed.body)"));
  assert.ok(src.includes("__barnowlGuard.plugins.attach(res, __p.call);"));
  assert.equal(src.split("barnowl: plugins on engine routes").length, 2, "applied exactly once");
});

test("server/metrics.js: record() reports to the plugin tap, totals unchanged", async () => {
  assert.ok(read("server/metrics.js").includes("barnowl: plugins metrics tap"));
  const { metrics } = await load("server/metrics.js");
  const before = metrics.totalRequests;
  const saved = globalThis.__barnowlOnMetrics;
  const seen = [];
  globalThis.__barnowlOnMetrics = (run) => seen.push(run);
  try {
    metrics.record({ ts: 1, endpoint: "chat", status: 200, durationMs: 5, inputTokens: 7, outputTokens: 9, toolCalls: 0 });
  } finally {
    globalThis.__barnowlOnMetrics = saved;
  }
  assert.equal(seen.length, 1);
  assert.equal(seen[0].inputTokens, 7);
  assert.equal(metrics.totalRequests, before + 1);
  delete globalThis.__barnowlOnMetrics;
  assert.doesNotThrow(() => metrics.record({ ts: 2, endpoint: "chat", status: 200, durationMs: 1 }), "no tap installed → no-op");
  globalThis.__barnowlOnMetrics = saved;
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/patch-otterly.test.js`
Expected: the two new tests FAIL (`plugins hook present`, and the `metrics.js` marker assertion).

- [ ] **Step 3: Add the locator**

In `lib/patch-otterly.js`, after `findServerIndex()` (ends line 170):

```js
/** Resolve server/metrics.js (the in-memory request metrics), or null. */
function findMetrics() {
  const dir = otterlyDistDir();
  return dir ? path.join(dir, "server", "metrics.js") : null;
}
```

- [ ] **Step 4: Add the patch constants**

After `GUARD_BODY_REPLACEMENT` (ends line 713), before `applyPatch`:

```js
// ── plugins (lib/plugins.cjs, reached through the guard module) ─────────────
// 1) server/index.js, engine routes: run the plugins' onRequest before the
//    guard (so a guard-blocked request is still attributed), reject in the
//    route's error shape, otherwise bind the call to this request's async
//    context and finish it when the response closes.
// 2) server/metrics.js: every engine route reports its token counts through
//    Metrics.record(); forward them to the current request's call.
// Both are no-ops unless a "plugins" block is configured.
const PLUGINS_BODY_MARKER = "barnowl: plugins on engine routes";
const PLUGINS_BODY_ANCHOR = [
  "        // " + GUARD_BODY_MARKER,
  "        if (__barnowlGuard && __barnowlGuard.enabled()) {",
].join("\n");
const PLUGINS_BODY_REPLACEMENT = [
  "        // " + PLUGINS_BODY_MARKER + " (identify + record; before the guard)",
  "        if (__barnowlGuard && __barnowlGuard.plugins && __barnowlGuard.plugins.enabled()) {",
  "            const __p = await __barnowlGuard.plugins.beginEngine(path, req.headers, parsed.body);",
  "            if (!__p.ok) {",
  "                jsonResponse(res, __p.status, __p.error);",
  "                logResponse(requestId, req.method, path, __p.status, Date.now() - startTime);",
  "                return;",
  "            }",
  "            __barnowlGuard.plugins.attach(res, __p.call);",
  "        }",
  PLUGINS_BODY_ANCHOR,
].join("\n");

const METRICS_TAP_MARKER = "barnowl: plugins metrics tap";
const METRICS_TAP_ANCHOR = [
  "    record(run) {",
  "        this.totalRequests++;",
].join("\n");
const METRICS_TAP_REPLACEMENT = [
  "    record(run) {",
  "        globalThis.__barnowlOnMetrics?.(run); // " + METRICS_TAP_MARKER,
  "        this.totalRequests++;",
].join("\n");
```

- [ ] **Step 5: Apply them in `ensurePatched`**

After the `guardBodyResult` assignment (line 877):

```js
  // Plugins: the index.js hook anchors on the guard body block, so it needs
  // that patch in place first. metrics.js is independent.
  const guardBodyReady = guardBodyResult === "patched" || guardBodyResult === "already";
  const pluginsBodyResult = guardBodyReady
    ? applyPatch(serverIndex, PLUGINS_BODY_MARKER, PLUGINS_BODY_ANCHOR, PLUGINS_BODY_REPLACEMENT)
    : guardBodyResult;
  const metricsTapResult = applyPatch(findMetrics(), METRICS_TAP_MARKER, METRICS_TAP_ANCHOR, METRICS_TAP_REPLACEMENT);
```

and extend the last line of the `results` array (line 890):

```js
    guardImportResult, guardRouteResult, guardBodyResult,
    pluginsBodyResult, metricsTapResult,
  ];
```

- [ ] **Step 6: Run the patch tests**

Run: `node --test test/patch-otterly.test.js`
Expected: `fail 0`. The first test (`ensurePatched applies everything and is idempotent`) applies the two new patches to the installed otterly and then reports `already`.

- [ ] **Step 7: Confirm the patched file still parses**

Run: `node --check node_modules/otterly/dist/server/index.js && node --check node_modules/otterly/dist/server/metrics.js && echo OK`
Expected: `OK`

- [ ] **Step 8: Commit**

```bash
git add lib/patch-otterly.js test/patch-otterly.test.js
git commit -m "patch-otterly: plugins hook on engine routes, metrics tap for token counts

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: `bin/barnowl.js` — config, start, plugin subcommands, help

**Files:**
- Modify: `bin/barnowl.js:151-152` (end of `parseFlags`), `:292-293` (`cmdStart`, after the guard block), `:566-616` (`cmdHelp`), `:660-673` (`config` output), `:693-695` (`default:` of the dispatch)
- Test: `test/cli-plugins.test.js`

**Interfaces:**
- Consumes: `plugins.load()` (Task 2), the plugin `cli(argv, ctx)` contract (Task 5).
- Produces: `cfg.pluginsJson: string | null` from `parseFlags`; env `BARNOWL_PLUGINS` for the server process; `barnowl <plugin-name> ...` dispatch.

- [ ] **Step 1: Write the failing test**

Create `test/cli-plugins.test.js`:

```js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const BIN = path.join(__dirname, "..", "bin", "barnowl.js");
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "barnowl-cli-"));
test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

let n = 0;
function setup(config) {
  const dir = path.join(ROOT, `c${++n}`);
  fs.mkdirSync(dir, { recursive: true });
  const stateDir = path.join(dir, "state");
  const file = path.join(dir, "config.json");
  fs.writeFileSync(file, JSON.stringify({ autoUpdate: false, paths: { stateDir }, ...config }));
  return { file, stateDir };
}
function run(args, env = {}) {
  const clean = { ...process.env };
  for (const k of Object.keys(clean)) if (k.startsWith("BARNOWL_")) delete clean[k];
  // cwd is a temp dir so a stray ./barnowl.config.json can never be picked up.
  return spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8", cwd: ROOT, env: { ...clean, ...env } });
}

test("config shows the plugins block, or null when unset", () => {
  const on = setup({ plugins: { usage: { requireKey: false } } });
  const shown = JSON.parse(run(["config", "--config", on.file]).stdout.replace(/^.*\n/, ""));
  assert.deepEqual(shown.plugins, { usage: { requireKey: false } });
  const off = setup({});
  assert.equal(JSON.parse(run(["config", "--config", off.file]).stdout.replace(/^.*\n/, "")).plugins, null);
});

test("usage key add → usage --json, through the real CLI", () => {
  const { file, stateDir } = setup({ plugins: { usage: {} } });
  const add = run(["usage", "key", "add", "sato", "--config", file]);
  assert.equal(add.status, 0, add.stderr);
  assert.match(add.stdout, /bo_[A-Za-z0-9_-]{43}/);
  assert.ok(fs.existsSync(path.join(stateDir, "usage", "keys.json")), "written under the config's state dir");

  const list = run(["usage", "key", "list", "--config", file]);
  assert.match(list.stdout, /sato\s+active/);

  const rep = run(["usage", "--json", "--config", file]);
  assert.equal(rep.status, 0, rep.stderr);
  assert.deepEqual(JSON.parse(rep.stdout).rows, []);
});

test("usage without the plugin configured explains how to enable it", () => {
  const { file } = setup({});
  const r = run(["usage", "--config", file]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /"usage" is a bundled plugin that is not enabled/);
  assert.match(r.stderr, /"plugins": \{ "usage": \{\} \}/);
});

test("an unknown command is still unknown", () => {
  const { file } = setup({ plugins: { usage: {} } });
  for (const cmd of ["frobnicate", "../lib", "keys"]) {
    const r = run([cmd, "--config", file]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Unknown command/);
  }
});

test("start refuses to run with a plugin that cannot load", () => {
  const { file } = setup({ port: 11497, plugins: { [path.join(ROOT, "missing-plugin.cjs")]: {} } });
  const r = run(["start", "--no-update", "--config", file]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /plugin .* failed to load/);
});

test("BARNOWL_PLUGINS env wins over the file", () => {
  const { file } = setup({ plugins: { usage: {} } });
  const out = run(["config", "--config", file], { BARNOWL_PLUGINS: '{"usage":{"requireKey":false}}' }).stdout;
  assert.deepEqual(JSON.parse(out.replace(/^.*\n/, "")).plugins, { usage: { requireKey: false } });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/cli-plugins.test.js`
Expected: FAIL — `shown.plugins` is `undefined`, `usage` is an unknown command.

- [ ] **Step 3: `parseFlags` — carry the plugins block**

In `bin/barnowl.js`, just before `return out;` at the end of `parseFlags` (line 152):

```js
  // "plugins" block → JSON for the server process (lib/plugins.cjs). env > file.
  // Kept as a string: validation happens in one place, plugins.load().
  const filePlugins = f.plugins && typeof f.plugins === "object" && !Array.isArray(f.plugins) ? f.plugins : null;
  out.pluginsJson = process.env.BARNOWL_PLUGINS
    || (filePlugins && Object.keys(filePlugins).length ? JSON.stringify(filePlugins) : null);
```

- [ ] **Step 4: `cmdStart` — validate and export**

Directly after the guard block's closing `}` (line 293), before the `// Make sure the speed patch is applied` comment:

```js
  // Plugins → env for the server process. Load them here first: a plugin that
  // cannot load must stop the start, not be skipped inside the server.
  if (cfg.pluginsJson) {
    process.env.BARNOWL_PLUGINS = cfg.pluginsJson;
    let names;
    try { names = require("../lib/plugins.cjs").load().map((p) => p.name); }
    catch (e) {
      console.error(`ERROR: ${e.message}`);
      return 1;
    }
    if (names.length) console.log(`  Plugins  : ${names.join(", ")}`);
  }
```

- [ ] **Step 5: Plugin subcommands**

Add this function above the `// ── Dispatch` comment:

```js
/** `barnowl <name> ...` for a configured plugin that exports cli(). Returns an
 *  exit code, or null when <name> is not a plugin command at all. */
async function cmdPlugin(cmd, argv) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(cmd)) return null;
  const cfg = parseFlags(argv);
  let loaded = [];
  if (cfg.pluginsJson) {
    process.env.BARNOWL_PLUGINS = cfg.pluginsJson;
    try { loaded = require("../lib/plugins.cjs").load(); }
    catch (e) {
      console.error(`ERROR: ${e.message}`);
      return 1;
    }
  }
  const hit = loaded.find((p) => p.name === cmd && typeof p.mod.cli === "function");
  if (hit) {
    const args = [];
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === "--config") i++;
      else args.push(argv[i]);
    }
    return hit.mod.cli(args, { stateDir: STATE_DIR, out: (s) => console.log(s), err: (s) => console.error(s) });
  }
  if (fs.existsSync(path.join(__dirname, "..", "plugins", cmd, "index.cjs"))) {
    console.error(`"${cmd}" is a bundled plugin that is not enabled.`);
    console.error(`Add this to ${cfg.configFile || GLOBAL_CONFIG} and restart barnowl:`);
    console.error(`  "plugins": { "${cmd}": {} }`);
    return 1;
  }
  return null;
}
```

and replace the dispatch `default:` (lines 693-695):

```js
    default: {
      const code = cmd ? await cmdPlugin(cmd, rest) : null;
      if (code !== null) return code;
      console.error(`Unknown command: ${cmd}. Run 'barnowl help'.`);
      return 1;
    }
```

- [ ] **Step 6: `config` output**

In the `config` case, after the `guard: …` entry (line 672) and before `configFile: cfg.configFile,`:

```js
          plugins: (() => {
            if (!cfg.pluginsJson) return null;
            try { return JSON.parse(cfg.pluginsJson); } catch { return "(invalid JSON)"; }
          })(),
```

- [ ] **Step 7: `cmdHelp`**

In the `Usage:` list, after the `barnowl config init [path]` line:

```
    barnowl usage [--days N] [--json]      Per-user usage (usage plugin)
    barnowl usage key add|revoke|list      Issue / revoke user keys (usage plugin)
```

and after the `Outbound PII guard` paragraph (before the closing backtick, line 616):

```
  Plugins (config "plugins" block, off by default):
    { "plugins": { "usage": {} } }
    usage — identifies callers by an admin-issued X-Barnowl-Key, records one
    metadata line per request (no prompt text) under <state dir>/usage/, and
    reports per user with 'barnowl usage'. Routes are tagged native
    (/v1/messages passthrough) or api (engine routes). "requireKey": false
    lets keyless requests through as "unknown". A path instead of a name
    loads your own plugin.
    env: BARNOWL_PLUGINS (the block as JSON)
```

- [ ] **Step 8: Run the CLI tests, then everything**

Run: `node --test test/cli-plugins.test.js`
Expected: `pass 6`, `fail 0`

Run: `npm test`
Expected: `fail 0`; `pass` is 78 plus every test added in Tasks 1-8.

- [ ] **Step 9: Commit**

```bash
git add bin/barnowl.js test/cli-plugins.test.js
git commit -m "barnowl: plugins config block, start-time validation, plugin subcommands

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: READMEs

**Files:**
- Modify: `README.md` — two new sections before `## Outbound PII guard` (line 480)
- Modify: `README.ja.md` — two new sections before `## 送信 PII ガード` (line 469)

- [ ] **Step 1: `README.md` — insert before `## Outbound PII guard`**

````markdown
## Use Claude Code's chat screen through barnowl

Point Claude Code at barnowl and keep using it exactly as before — same chat
screen, same tools, same login:

```bash
export ANTHROPIC_BASE_URL=http://localhost:11435
claude
```

or permanently, in Claude Code's `settings.json`:

```json
{ "env": { "ANTHROPIC_BASE_URL": "http://localhost:11435" } }
```

On this path barnowl does **not** run a CLI of its own. Claude Code sends its
normal `POST /v1/messages` request; barnowl forwards it, with the client's own
credentials, to `api.anthropic.com` and streams the answer back. No API key is
involved: a subscription login works (verified with Claude Max).

barnowl has two ways in, and they are different things:

| | `native` — `/v1/messages` | `api` — `/v1/chat/completions`, `/api/*` |
| --- | --- | --- |
| client | Claude Code | Cursor, Aider, any OpenAI / Ollama SDK |
| what barnowl does | forwards the request | spawns `claude -p` / `codex` and answers |
| whose login | the user's own | the login on the barnowl machine |
| tools, hooks, sessions | Claude Code's, unchanged | none (barnowl's engine) |

What changes for the user: nothing, unless you turn on the
[guard](#outbound-pii-guard) (text is masked, images are refused — Claude Code
shows the refusal as an API error) or the [usage plugin](#plugins) (a key is
required).

## Plugins

Opt-in extensions, off unless the config file names them:

```json
{ "plugins": { "usage": {} } }
```

A bare name is a plugin bundled in `plugins/`; a path (`"~/my/plugin.cjs"`)
loads your own. `barnowl start` prints `Plugins : usage` and refuses to start
if a configured plugin cannot load. Env: `BARNOWL_PLUGINS` (the block as JSON).

### `usage` — who used it, and how much

Identifies each caller by a key you issue, and writes one line of metadata per
request.

```bash
barnowl usage key add sato        # prints the key once
barnowl usage key list
barnowl usage key revoke sato     # takes effect immediately, no restart
```

Each user adds the key on their side:

```bash
# Claude Code
export ANTHROPIC_CUSTOM_HEADERS="X-Barnowl-Key: bo_…"
# any other client: send the header  X-Barnowl-Key: bo_…
```

A request without a valid key gets `401`. This covers both routes, so the key
also locks the engine routes. `"usage": { "requireKey": false }` lets keyless
requests through, recorded as `unknown`.

```bash
barnowl usage                 # last 7 days, per user and route
barnowl usage --days 30
barnowl usage --from 2026-10-01 --to 2026-10-31 --json
```

```
user  route   reqs  blocked  rejected  errors   input  output  cache-w  cache-r  devices  sessions  active
sato  api        3        0         0       0   1,204     310        0        0        0         0      2m
sato  native    42        1         0       0  18,331   9,120   40,112  611,904        1         3  1h 12m
```

- **Recorded** (`<state dir>/usage/YYYY-MM-DD.jsonl`, mode 0600): time, route
  (`native` / `api`), user, model, status, outcome (`ok` / `blocked` by the
  guard / `rejected` for a bad key / `upstream_error`), duration, input /
  output / cache tokens, and on `native` the tool names Claude called plus
  Claude Code's `device_id`, `account_uuid` and `session_id`.
- **Not recorded**: prompt text, response text, the key (only its SHA-256 is
  stored), the client's credentials.
- The key is removed before the request is forwarded; it never reaches
  Anthropic.
- `active` merges a session's requests that are at most 5 minutes apart.
- On `api`, device / account / session, cache tokens and tool names are not
  available and stay empty.
- `/ws` is not covered.

### Writing a plugin

A CommonJS module exporting any of:

```js
module.exports = {
  name: "mine",
  init(options, { stateDir, log }) {},
  // may return { identity: {...}, stripHeaders: ["x-…"], reject: { status, type, message } }
  onRequest({ route, path, headers, body }) {},
  onComplete(record) {},          // after the response has been sent
  cli(argv, { stateDir, out, err }) { return 0; },   // `barnowl mine ...`
};
```

A throwing `onRequest` rejects the request (`500`). A throwing `onComplete`
is logged and ignored.
````

- [ ] **Step 2: `README.ja.md` — insert before `## 送信 PII ガード`**

````markdown
## Claude Code のチャット画面からそのまま使う

Claude Code の接続先を barnowl に向けるだけです。チャット画面・ツール・
ログインは今までどおりです:

```bash
export ANTHROPIC_BASE_URL=http://localhost:11435
claude
```

恒久的に設定するなら Claude Code の `settings.json` に:

```json
{ "env": { "ANTHROPIC_BASE_URL": "http://localhost:11435" } }
```

この経路では barnowl は自分で CLI を起動**しません**。Claude Code が送る通常の
`POST /v1/messages` を、クライアント自身の認証情報ごと `api.anthropic.com` へ
転送し、応答をそのまま返します。API キーは不要で、サブスクリプションの
ログインで動きます（Claude Max で確認済み）。

barnowl の入口は 2 つあり、別物です:

| | `native` — `/v1/messages` | `api` — `/v1/chat/completions`、`/api/*` |
| --- | --- | --- |
| クライアント | Claude Code | Cursor・Aider・OpenAI / Ollama SDK |
| barnowl の動き | リクエストを転送する | `claude -p` / `codex` を起動して答える |
| 使われるログイン | 利用者本人 | barnowl を動かしているマシン |
| ツール・フック・セッション | Claude Code のものがそのまま動く | なし（barnowl のエンジン） |

利用者から見て変わる点はありません。[ガード](#送信-pii-ガード)を有効にした場合
（テキストはマスク、画像は拒否。拒否は Claude Code 上で API エラーとして
表示されます）と、[usage プラグイン](#プラグイン)を入れた場合（キーが必要）
だけ挙動が変わります。

## プラグイン

後から足す拡張機能です。設定ファイルに書いたものだけが読み込まれます:

```json
{ "plugins": { "usage": {} } }
```

名前だけ書くと `plugins/` 同梱のプラグイン、パス（`"~/my/plugin.cjs"`）を
書くと自作のものを読み込みます。`barnowl start` は `Plugins : usage` と
表示し、設定したプラグインを読み込めない場合は起動しません。
環境変数: `BARNOWL_PLUGINS`（このブロックの JSON）。

### `usage` — 誰がどれだけ使ったか

管理者が発行するキーで利用者を識別し、リクエストごとにメタデータを 1 行
記録します。

```bash
barnowl usage key add sato        # キーは一度だけ表示される
barnowl usage key list
barnowl usage key revoke sato     # 即時反映、再起動不要
```

利用者側はキーを設定するだけです:

```bash
# Claude Code
export ANTHROPIC_CUSTOM_HEADERS="X-Barnowl-Key: bo_…"
# それ以外のクライアント: ヘッダー X-Barnowl-Key: bo_… を送る
```

有効なキーがないリクエストは `401` になります。両方の経路が対象なので、
エンジン経路もキーなしでは使えなくなります。`"usage": { "requireKey": false }`
にするとキーなしも通し、`unknown` として記録します。

```bash
barnowl usage                 # 直近 7 日、利用者・経路ごと
barnowl usage --days 30
barnowl usage --from 2026-10-01 --to 2026-10-31 --json
```

```
user  route   reqs  blocked  rejected  errors   input  output  cache-w  cache-r  devices  sessions  active
sato  api        3        0         0       0   1,204     310        0        0        0         0      2m
sato  native    42        1         0       0  18,331   9,120   40,112  611,904        1         3  1h 12m
```

- **記録するもの**（`<state dir>/usage/YYYY-MM-DD.jsonl`、モード 0600）: 時刻、
  経路（`native` / `api`）、利用者、モデル、ステータス、結果（`ok` /
  ガードによる `blocked` / キー不正の `rejected` / `upstream_error`）、
  所要時間、入力・出力・キャッシュのトークン数。`native` では Claude が
  呼んだツール名と、Claude Code の `device_id`・`account_uuid`・`session_id`。
- **記録しないもの**: プロンプト本文、応答本文、キー（保存するのは SHA-256
  だけ）、クライアントの認証情報。
- キーは転送前に取り除かれ、Anthropic には届きません。
- `active` は、同じセッション内で 5 分以内に続いたリクエストをまとめた
  利用時間です。
- `api` では device / account / session、キャッシュのトークン数、ツール名は
  取得できないため空になります。
- `/ws` は対象外です。

### プラグインを書く

次のいずれかをエクスポートする CommonJS モジュールです:

```js
module.exports = {
  name: "mine",
  init(options, { stateDir, log }) {},
  // { identity: {...}, stripHeaders: ["x-…"], reject: { status, type, message } } を返せる
  onRequest({ route, path, headers, body }) {},
  onComplete(record) {},          // 応答を返した後
  cli(argv, { stateDir, out, err }) { return 0; },   // `barnowl mine ...`
};
```

`onRequest` が例外を投げるとリクエストは拒否されます（`500`）。`onComplete`
の例外はログに残して無視します。
````

- [ ] **Step 3: Check the anchors resolve**

Run: `grep -n '^## Outbound PII guard\|^## Plugins\|^## Use Claude Code' README.md && grep -n '^## 送信 PII ガード\|^## プラグイン\|^## Claude Code のチャット画面' README.ja.md`
Expected: three headings per file, the two new ones above the guard heading.

- [ ] **Step 4: Commit**

```bash
git add README.md README.ja.md
git commit -m "Docs: Claude Code through the passthrough, plugins, usage plugin

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: E2E on an isolated server

Nothing here touches port 11435, `~/.barnowl` or `~/dev/BarnOwl-kit`. Run from the repo root.

**Files:** none (verification only).

- [ ] **Step 1: Start an isolated server with the plugin**

```bash
E2E=$(mktemp -d)
cat > "$E2E/config.json" <<EOF
{ "port": 11497, "autoUpdate": false, "mcp": "none",
  "paths": { "stateDir": "$E2E/state" },
  "plugins": { "usage": {} } }
EOF
node bin/barnowl.js start --no-update --config "$E2E/config.json"
```

Expected: the output contains `Plugins  : usage` and `Started (PID …)`.

- [ ] **Step 2: Issue a key**

```bash
KEY=$(node bin/barnowl.js usage key add e2e --config "$E2E/config.json" | grep -o 'bo_[A-Za-z0-9_-]*' | head -1)
echo "${KEY:0:6}… (${#KEY} chars)"
```

Expected: `bo_…` and `46 chars`.

- [ ] **Step 3: `native` — Claude Code without and with the key**

```bash
cd "$E2E"
ANTHROPIC_BASE_URL=http://localhost:11497 command claude -p "Reply with the single word: pong" --model haiku --setting-sources "" < /dev/null
ANTHROPIC_BASE_URL=http://localhost:11497 ANTHROPIC_CUSTOM_HEADERS="X-Barnowl-Key: $KEY" command claude -p "Reply with the single word: pong" --model haiku --setting-sources "" < /dev/null
cd -
```

Expected: the first prints an API error containing `401` and `missing or invalid X-Barnowl-Key`; the second prints `pong`.

- [ ] **Step 4: `api` — an OpenAI-style request without and with the key**

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:11497/v1/chat/completions \
  -H 'Content-Type: application/json' -d '{"model":"haiku","messages":[{"role":"user","content":"Reply with the single word: pong"}]}'
curl -s http://localhost:11497/v1/chat/completions -H "X-Barnowl-Key: $KEY" \
  -H 'Content-Type: application/json' -d '{"model":"haiku","messages":[{"role":"user","content":"Reply with the single word: pong"}]}' | head -c 300
```

Expected: `401`, then a chat completion JSON whose content is `pong`.

- [ ] **Step 5: The report shows both routes with tokens**

```bash
node bin/barnowl.js usage --config "$E2E/config.json"
node bin/barnowl.js usage --json --config "$E2E/config.json" \
  | node -e 'const r=JSON.parse(require("fs").readFileSync(0,"utf8")).rows; for (const x of r) console.log(x.user, x.route, x.requests, x.rejected, x.inputTokens>0, x.outputTokens>0)'
```

Expected rows: `(no key) api 1 1 false false`, `(no key) native ≥1 ≥1 false false`, `e2e api 1 0 true true`, `e2e native ≥1 0 true true`.

- [ ] **Step 6: Nothing sensitive on disk; modes are private**

```bash
grep -rl -e "$KEY" -e "pong" -e "Reply with" "$E2E/state/usage" ; echo "grep exit=$?"
stat -f '%Lp %N' "$E2E/state/usage" "$E2E/state/usage"/* 2>/dev/null || stat -c '%a %n' "$E2E/state/usage" "$E2E/state/usage"/*
```

Expected: no file names printed and `grep exit=1`; the directory is `700`, each file `600`.

- [ ] **Step 7: Revoke takes effect without a restart**

```bash
node bin/barnowl.js usage key revoke e2e --config "$E2E/config.json"
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:11497/v1/chat/completions -H "X-Barnowl-Key: $KEY" \
  -H 'Content-Type: application/json' -d '{"model":"haiku","messages":[{"role":"user","content":"hi"}]}'
```

Expected: `Revoked 1 key for e2e.` then `401`.

- [ ] **Step 8: Stop the isolated server and clean up**

```bash
node bin/barnowl.js stop -p 11497 --config "$E2E/config.json"
curl -s -m 2 -o /dev/null -w '%{http_code}\n' http://localhost:11497/v1/models ; rm -rf "$E2E"
curl -s -m 3 -o /dev/null -w 'live server on 11435: %{http_code}\n' http://localhost:11435/api/status
```

Expected: the stop message, `000` for 11497, and `live server on 11435: 200` (untouched).

- [ ] **Step 9: Full suite, clean tree**

Run: `npm test 2>&1 | tail -8 && git status -s`
Expected: `fail 0`; `git status -s` prints nothing.
