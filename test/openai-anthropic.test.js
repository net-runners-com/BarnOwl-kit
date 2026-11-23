"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { toAnthropic, toolUseToOpenAI } = require("../lib/openai-anthropic.cjs");

const JSON_RULE = "You must respond with valid JSON only. No markdown, no explanation, no code fences, just a JSON object.";

test("system + developer joined; json_object appends rule", () => {
  const r = toAnthropic({
    messages: [{ role: "system", content: "A" }, { role: "developer", content: "B" }, { role: "user", content: "hi" }],
    response_format: { type: "json_object" },
  });
  assert.equal(r.system, `A\n\nB\n\n${JSON_RULE}`);
  assert.deepEqual(r.messages, [{ role: "user", content: [{ type: "text", text: "hi" }] }]);
});

test("no system → null", () => {
  assert.equal(toAnthropic({ messages: [{ role: "user", content: "x" }] }).system, null);
});

test("image_url data: and https become image blocks", () => {
  const r = toAnthropic({ messages: [{ role: "user", content: [
    { type: "text", text: "look" },
    { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
    { type: "image_url", image_url: "https://e.x/a.png" },
  ] }] });
  assert.deepEqual(r.messages[0].content, [
    { type: "text", text: "look" },
    { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
    { type: "image", source: { type: "url", url: "https://e.x/a.png" } },
  ]);
});

test("assistant tool_calls → tool_use, tool → tool_result; consecutive tools merge", () => {
  const r = toAnthropic({ messages: [
    { role: "user", content: "go" },
    { role: "assistant", content: "ok", tool_calls: [
      { id: "c1", type: "function", function: { name: "f", arguments: "{\"a\":1}" } },
      { id: "c2", type: "function", function: { name: "g", arguments: "not json" } },
    ] },
    { role: "tool", tool_call_id: "c1", content: "r1" },
    { role: "tool", tool_call_id: "c2", content: "r2" },
  ] });
  assert.deepEqual(r.messages[1], { role: "assistant", content: [
    { type: "text", text: "ok" },
    { type: "tool_use", id: "c1", name: "f", input: { a: 1 } },
    { type: "tool_use", id: "c2", name: "g", input: {} },
  ] });
  assert.deepEqual(r.messages[2], { role: "user", content: [
    { type: "tool_result", tool_use_id: "c1", content: "r1" },
    { type: "tool_result", tool_use_id: "c2", content: "r2" },
  ] });
  assert.equal(r.messages.length, 3);
});

test("consecutive user turns merge", () => {
  const r = toAnthropic({ messages: [{ role: "user", content: "a" }, { role: "user", content: "b" }] });
  assert.deepEqual(r.messages, [{ role: "user", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }]);
});

test("tools + tool_choice mapping", () => {
  const tools = [{ type: "function", function: { name: "f", description: "d", parameters: { type: "object", properties: { a: { type: "string" } } } } },
    { type: "function", function: { name: "g" } }];
  const base = { messages: [{ role: "user", content: "x" }], tools };
  const r = toAnthropic(base);
  assert.deepEqual(r.tools, [
    { name: "f", description: "d", input_schema: { type: "object", properties: { a: { type: "string" } } } },
    { name: "g", description: "", input_schema: { type: "object", properties: {} } },
  ]);
  assert.equal(r.tool_choice, undefined);
  assert.deepEqual(toAnthropic({ ...base, tool_choice: "auto" }).tool_choice, { type: "auto" });
  assert.deepEqual(toAnthropic({ ...base, tool_choice: "required" }).tool_choice, { type: "any" });
  assert.deepEqual(toAnthropic({ ...base, tool_choice: { type: "function", function: { name: "f" } } }).tool_choice, { type: "tool", name: "f" });
  const none = toAnthropic({ ...base, tool_choice: "none" });
  assert.equal(none.tools, undefined);
});

test("toolUseToOpenAI", () => {
  assert.deepEqual(toolUseToOpenAI({ type: "tool_use", id: "t1", name: "f", input: { a: 1 } }),
    { id: "t1", type: "function", function: { name: "f", arguments: "{\"a\":1}" } });
});
