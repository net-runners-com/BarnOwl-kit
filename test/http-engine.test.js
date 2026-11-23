"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.BARNOWL_SESSIONS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bo-he-"));
const { createHttpQueryFn, httpActive, resolveModel, effortParams } = require("../lib/http-engine.cjs");
const sessions = require("../lib/http-sessions.cjs");

// ── mock /v1/messages ────────────────────────────────────────────────────────
function sse(events) {
  return events.map(([ev, data]) => `event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`).join("");
}
function textReply(text, { usage = { input_tokens: 10, output_tokens: 2 } } = {}) {
  const parts = Array.isArray(text) ? text : [text];
  return sse([
    ["message_start", { type: "message_start", message: { id: "m", role: "assistant", content: [], usage } }],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
    ...parts.map((t) => ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: t } }]),
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } }],
    ["message_stop", { type: "message_stop" }],
  ]);
}
function toolReply(name, input, { thinking = false } = {}) {
  const ev = [["message_start", { type: "message_start", message: { usage: { input_tokens: 5, output_tokens: 0 } } }]];
  let i = 0;
  if (thinking) {
    ev.push(["content_block_start", { type: "content_block_start", index: i, content_block: { type: "thinking", thinking: "" } }]);
    ev.push(["content_block_delta", { type: "content_block_delta", index: i, delta: { type: "signature_delta", signature: "SIG" } }]);
    ev.push(["content_block_stop", { type: "content_block_stop", index: i }]);
    i++;
  }
  ev.push(["content_block_start", { type: "content_block_start", index: i, content_block: { type: "tool_use", id: "tu1", name, input: {} } }]);
  const js = JSON.stringify(input);
  ev.push(["content_block_delta", { type: "content_block_delta", index: i, delta: { type: "input_json_delta", partial_json: js.slice(0, 3) } }]);
  ev.push(["content_block_delta", { type: "content_block_delta", index: i, delta: { type: "input_json_delta", partial_json: js.slice(3) } }]);
  ev.push(["content_block_stop", { type: "content_block_stop", index: i }]);
  ev.push(["message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 7 } }]);
  return sse(ev);
}

async function mock(handler) {
  const bodies = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw);
      bodies.push({ body, headers: req.headers });
      handler(body, res, bodies.length);
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, bodies, close: () => new Promise((r) => server.close(r)) };
}
function sendSse(res, payload) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end(payload);
}
async function collect(iter) {
  const out = [];
  for await (const e of iter) out.push(e);
  return out;
}

test("httpActive needs self url + oauth or api key, and not cli", () => {
  assert.equal(httpActive({ BARNOWL_SELF_URL: "x", BARNOWL_MESSAGES_OAUTH: "1" }), true);
  assert.equal(httpActive({ BARNOWL_SELF_URL: "x", ANTHROPIC_API_KEY: "k" }), true);
  assert.equal(httpActive({ BARNOWL_SELF_URL: "x" }), false);
  assert.equal(httpActive({ BARNOWL_MESSAGES_OAUTH: "1" }), false);
  assert.equal(httpActive({ BARNOWL_SELF_URL: "x", BARNOWL_MESSAGES_OAUTH: "1", BARNOWL_ENGINE: "cli" }), false);
});

test("resolveModel: aliases and [1m]", () => {
  const cat = ["claude-sonnet-5-5", "claude-sonnet-5-5[1m]", "claude-sonnet-5", "claude-opus-5-5"];
  assert.deepEqual(resolveModel("sonnet", cat), { model: "claude-sonnet-5-5", betas: [] });
  assert.deepEqual(resolveModel("default", cat), { model: "claude-sonnet-5-5", betas: [] });
  assert.deepEqual(resolveModel("claude-opus-5-5[1m]", cat), { model: "claude-opus-5-5", betas: ["context-1m-2025-08-07"] });
  assert.deepEqual(resolveModel("claude-x", cat), { model: "claude-x", betas: [] });
});

test("effortParams mapping", () => {
  assert.deepEqual(effortParams(null), {});
  assert.deepEqual(effortParams("none"), {});
  assert.deepEqual(effortParams("minimal").output_config, { effort: "low" });
  assert.deepEqual(effortParams("xhigh").output_config, { effort: "max" });
  assert.deepEqual(effortParams("medium"), { thinking: { type: "adaptive", display: "omitted" }, output_config: { effort: "medium" } });
});

test("(a) text stream → init, deltas, assistant, result", async () => {
  const m = await mock((b, res) => sendSse(res, textReply(["Hel", "lo"])));
  try {
    const q = createHttpQueryFn({ selfUrl: m.url });
    const ev = await collect(q({ prompt: "hi", options: { model: "claude-sonnet-5-5", systemPrompt: "S" } }));
    assert.deepEqual(ev.map((e) => e.type), ["system", "stream_event", "stream_event", "assistant", "result"]);
    assert.equal(ev[0].subtype, "init");
    assert.equal(ev[1].event.delta.text, "Hel");
    assert.deepEqual(ev[3].message.content, [{ type: "text", text: "Hello" }]);
    const r = ev[4];
    assert.equal(r.subtype, "success");
    assert.equal(r.result, "Hello");
    assert.equal(r.usage.input_tokens, 10);
    assert.equal(r.usage.output_tokens, 2);
    const sent = m.bodies[0].body;
    assert.equal(sent.system, "S");
    assert.equal(sent.stream, true);
    assert.equal(sent.max_tokens, 16384);
    assert.deepEqual(sent.messages[0].content[0].cache_control, { type: "ephemeral" });
    // saved without cache_control
    const saved = sessions.load(ev[0].session_id);
    assert.equal(saved.messages.length, 2);
    assert.equal(saved.messages[0].content[0].cache_control, undefined);
  } finally { await m.close(); }
});

test("(b) upstream 401 → is_error result with status", async () => {
  const m = await mock((b, res) => {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "login expired" } }));
  });
  try {
    const ev = await collect(createHttpQueryFn({ selfUrl: m.url })({ prompt: "hi", options: {} }));
    const r = ev[ev.length - 1];
    assert.equal(r.type, "result");
    assert.equal(r.is_error, true);
    assert.equal(r.api_error_status, 401);
    assert.match(r.result, /login expired/);
  } finally { await m.close(); }
});

test("(c) abort mid-stream ends iteration and saves nothing", async () => {
  const ac = new AbortController();
  const m = await mock((b, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(sse([["message_start", { type: "message_start", message: { usage: {} } }],
      ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
      ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "x" } }]]));
    // never ends
  });
  try {
    const before = fs.readdirSync(sessions.dir()).length;
    const it = createHttpQueryFn({ selfUrl: m.url })({ prompt: "hi", options: { abortController: ac, resume: "abort-sess" } });
    const ev = [];
    await assert.rejects(async () => {
      for await (const e of it) { ev.push(e); if (e.type === "stream_event") ac.abort(); }
    }, (e) => e.name === "AbortError");
    assert.equal(sessions.load("abort-sess"), null);
    assert.equal(fs.readdirSync(sessions.dir()).length, before);
  } finally { m.close(); }
});

test("(d) resume sends prior turns", async () => {
  const m = await mock((b, res, n) => sendSse(res, textReply(n === 1 ? "Nice to meet you" : "Hiro")));
  try {
    const q = createHttpQueryFn({ selfUrl: m.url });
    await collect(q({ prompt: "My name is Hiro", options: { resume: "s-d" } }));
    const ev = await collect(q({ prompt: "Name?", options: { resume: "s-d" } }));
    const msgs = m.bodies[1].body.messages;
    assert.equal(msgs.length, 3);
    assert.equal(msgs[0].content[0].text, "My name is Hiro");
    assert.equal(msgs[1].role, "assistant");
    assert.equal(ev[0].session_id, "s-d");
    assert.equal(sessions.load("s-d").messages.length, 4);
  } finally { await m.close(); }
});

test("(d2) unknown resume id starts empty and saves under that id", async () => {
  const m = await mock((b, res) => sendSse(res, textReply("ok")));
  try {
    await collect(createHttpQueryFn({ selfUrl: m.url })({ prompt: "x", options: { resume: "never-seen" } }));
    assert.equal(m.bodies[0].body.messages.length, 1);
    assert.equal(sessions.load("never-seen").messages.length, 2);
  } finally { await m.close(); }
});

test("(e)(f) effort + extraBody land in the body; alias resolved; betas sent", async () => {
  const m = await mock((b, res) => sendSse(res, textReply("ok")));
  try {
    await collect(createHttpQueryFn({ selfUrl: m.url, catalog: ["claude-opus-5-5"] })({ prompt: "x",
      options: { model: "opus[1m]", effort: "xhigh", extraBody: { temperature: 0.2 } } }));
    const { body, headers } = m.bodies[0];
    assert.equal(body.model, "claude-opus-5-5");
    assert.equal(body.output_config.effort, "max");
    assert.equal(body.thinking.type, "adaptive");
    assert.equal(body.temperature, 0.2);
    assert.match(headers["anthropic-beta"], /context-1m-2025-08-07/);
  } finally { await m.close(); }
});

test("anthropic options: structured messages + system + client tools stop at tool_use", async () => {
  const m = await mock((b, res) => sendSse(res, toolReply("lookup", { q: "x" })));
  try {
    const ev = await collect(createHttpQueryFn({ selfUrl: m.url })({ prompt: "ignored", options: {
      anthropic: { system: "SYS", messages: [{ role: "user", content: [{ type: "text", text: "find" }] }],
        tools: [{ name: "lookup", description: "", input_schema: { type: "object", properties: {} } }], tool_choice: { type: "auto" } },
    } }));
    assert.equal(m.bodies.length, 1);
    const sent = m.bodies[0].body;
    assert.equal(sent.system, "SYS");
    assert.equal(sent.tools[0].name, "lookup");
    assert.deepEqual(sent.tool_choice, { type: "auto" });
    const asst = ev.find((e) => e.type === "assistant");
    assert.deepEqual(asst.message.content, [{ type: "tool_use", id: "tu1", name: "lookup", input: { q: "x" } }]);
    const r = ev[ev.length - 1];
    assert.equal(r.subtype, "success");
    assert.equal(r.stop_reason, "tool_use");
  } finally { await m.close(); }
});
