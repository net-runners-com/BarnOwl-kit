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
  try {
    guard.plugins._reset();
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
