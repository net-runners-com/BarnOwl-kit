"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.BARNOWL_SESSIONS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bo-het-"));
const { createHttpQueryFn, createDefaultToolProvider } = require("../lib/http-engine.cjs");

function sse(events) {
  return events.map((d) => `event: ${d.type}\ndata: ${JSON.stringify(d)}\n\n`).join("");
}
function textReply(t) {
  return sse([
    { type: "message_start", message: { usage: { input_tokens: 1 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: t } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
  ]);
}
function toolReply(name, input, { thinking = false } = {}) {
  const ev = [{ type: "message_start", message: { usage: {} } }];
  let i = 0;
  if (thinking) {
    ev.push({ type: "content_block_start", index: i, content_block: { type: "thinking", thinking: "" } },
      { type: "content_block_delta", index: i, delta: { type: "signature_delta", signature: "SIG" } },
      { type: "content_block_stop", index: i });
    i++;
  }
  ev.push({ type: "content_block_start", index: i, content_block: { type: "tool_use", id: `tu${i}`, name, input: {} } },
    { type: "content_block_delta", index: i, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } },
    { type: "content_block_stop", index: i },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 1 } });
  return sse(ev);
}
async function mock(handler) {
  const bodies = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      bodies.push(JSON.parse(raw));
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(handler(bodies.length));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}`, bodies, close: () => new Promise((r) => server.close(r)) };
}
async function collect(it) { const o = []; for await (const e of it) o.push(e); return o; }

const bashProvider = () => createDefaultToolProvider({ BARNOWL_ALLOW_TOOLS: "Bash" });

test("(a) Bash tool_use runs locally and its output goes back", async () => {
  const m = await mock((n) => (n === 1 ? toolReply("Bash", { command: "echo hi" }) : textReply("done")));
  try {
    const ev = await collect(createHttpQueryFn({ selfUrl: m.url, toolProvider: bashProvider() })({ prompt: "x", options: {} }));
    assert.equal(m.bodies.length, 2);
    assert.equal(m.bodies[0].tools[0].name, "Bash");
    const tr = m.bodies[1].messages[2].content[0];
    assert.equal(tr.type, "tool_result");
    assert.equal(tr.content, "hi\n");
    assert.equal(tr.is_error, undefined);
    assert.ok(ev.some((e) => e.type === "user" && e.tool_use_result));
    assert.equal(ev[ev.length - 1].result, "done");
  } finally { await m.close(); }
});

test("(b) canUseTool deny → is_error result, command never runs", async () => {
  const marker = path.join(os.tmpdir(), `bo-deny-${process.pid}`);
  try { fs.unlinkSync(marker); } catch (_) {}
  const m = await mock((n) => (n === 1 ? toolReply("Bash", { command: `touch ${marker}` }) : textReply("ok")));
  try {
    const canUseTool = async () => ({ behavior: "deny", message: "sealed: no" });
    await collect(createHttpQueryFn({ selfUrl: m.url, toolProvider: bashProvider() })({ prompt: "x", options: { canUseTool } }));
    const tr = m.bodies[1].messages[2].content[0];
    assert.equal(tr.is_error, true);
    assert.equal(tr.content, "sealed: no");
    assert.equal(fs.existsSync(marker), false);
  } finally { await m.close(); }
});

test("(b2) canUseTool throwing is a deny", async () => {
  const m = await mock((n) => (n === 1 ? toolReply("Bash", { command: "echo x" }) : textReply("ok")));
  try {
    const canUseTool = async () => { throw new Error("boom"); };
    await collect(createHttpQueryFn({ selfUrl: m.url, toolProvider: bashProvider() })({ prompt: "x", options: { canUseTool } }));
    assert.equal(m.bodies[1].messages[2].content[0].is_error, true);
  } finally { await m.close(); }
});

test("(c) client tools → never executed server-side", async () => {
  const m = await mock(() => toolReply("Bash", { command: "echo nope" }));
  try {
    const ev = await collect(createHttpQueryFn({ selfUrl: m.url, toolProvider: bashProvider() })({ prompt: "x", options: {
      anthropic: { system: null, messages: [{ role: "user", content: "x" }], tools: [{ name: "Bash", input_schema: { type: "object" } }] } } }));
    assert.equal(m.bodies.length, 1);
    assert.equal(ev[ev.length - 1].stop_reason, "tool_use");
  } finally { await m.close(); }
});

test("(d) thinking block with signature is kept in the resent history", async () => {
  const m = await mock((n) => (n === 1 ? toolReply("Bash", { command: "true" }, { thinking: true }) : textReply("ok")));
  try {
    await collect(createHttpQueryFn({ selfUrl: m.url, toolProvider: bashProvider() })({ prompt: "x", options: { effort: "high" } }));
    const asst = m.bodies[1].messages[1];
    assert.equal(asst.role, "assistant");
    assert.deepEqual(asst.content[0], { type: "thinking", thinking: "", signature: "SIG" });
    assert.equal(asst.content[1].type, "tool_use");
  } finally { await m.close(); }
});

test("(e) maxTurns exceeded → error result", async () => {
  const m = await mock(() => toolReply("Bash", { command: "true" }));
  try {
    const ev = await collect(createHttpQueryFn({ selfUrl: m.url, toolProvider: bashProvider() })({ prompt: "x", options: { maxTurns: 2 } }));
    const r = ev[ev.length - 1];
    assert.equal(r.is_error, true);
    assert.match(r.result, /max turns/);
    assert.equal(m.bodies.length, 2);
  } finally { await m.close(); }
});

test("no Bash in BARNOWL_ALLOW_TOOLS → no tools sent", async () => {
  const m = await mock(() => textReply("ok"));
  try {
    await collect(createHttpQueryFn({ selfUrl: m.url, toolProvider: createDefaultToolProvider({}) })({ prompt: "x", options: {} }));
    assert.equal(m.bodies[0].tools, undefined);
  } finally { await m.close(); }
});
