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
