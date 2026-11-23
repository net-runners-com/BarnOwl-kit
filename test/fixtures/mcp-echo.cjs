"use strict";
// Minimal stdio MCP server for tests: one tool, `echo`, returns "pong:<text>".
const readline = require("readline");
const rl = readline.createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
rl.on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch (_) { return; }
  if (msg.id === undefined) return; // notification
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "echo", version: "1" } } });
  } else if (msg.method === "tools/list") {
    send({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "echo", description: "echo back", inputSchema: { type: "object", properties: { text: { type: "string" } } } }] } });
  } else if (msg.method === "tools/call") {
    send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: `pong:${msg.params.arguments.text}` }] } });
  } else {
    send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "no such method" } });
  }
});
