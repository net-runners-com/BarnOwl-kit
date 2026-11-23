"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { createMcpHub } = require("../lib/mcp-client.cjs");

const ECHO = path.join(__dirname, "fixtures", "mcp-echo.cjs");

function profile(servers) {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "bo-mcp-")), "p.json");
  fs.writeFileSync(f, JSON.stringify({ mcpServers: servers }));
  return f;
}

test("stdio server: definitions + call", async () => {
  const hub = createMcpHub(profile({ echo: { command: process.execPath, args: [ECHO] } }));
  try {
    const defs = await hub.definitions();
    assert.deepEqual(defs, [{ name: "mcp__echo__echo", description: "echo back",
      input_schema: { type: "object", properties: { text: { type: "string" } } } }]);
    const r = await hub.call("mcp__echo__echo", { text: "abc" }, {});
    assert.deepEqual(r, { output: "pong:abc", isError: false });
  } finally { hub.close(); }
});

test("a broken server is skipped; others still work", async () => {
  const hub = createMcpHub(profile({
    bad: { command: "/nonexistent/binary" },
    echo: { command: process.execPath, args: [ECHO] },
  }));
  try {
    const defs = await hub.definitions();
    assert.deepEqual(defs.map((d) => d.name), ["mcp__echo__echo"]);
  } finally { hub.close(); }
});

test("http server (JSON and SSE responses) with session id", async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const msg = JSON.parse(raw);
      seen.push({ method: msg.method, sid: req.headers["mcp-session-id"] });
      if (msg.id === undefined) { res.writeHead(202); return res.end(); }
      let result;
      if (msg.method === "initialize") {
        res.setHeader("Mcp-Session-Id", "S1");
        result = { protocolVersion: "2025-06-18", capabilities: {} };
      } else if (msg.method === "tools/list") {
        result = { tools: [{ name: "t", inputSchema: { type: "object" } }] };
      } else {
        // answer tools/call as SSE
        res.writeHead(200, { "content-type": "text/event-stream" });
        return res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "ok" }], isError: true } })}\n\n`);
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const hub = createMcpHub(profile({ web: { type: "http", url: `http://127.0.0.1:${server.address().port}/mcp` } }));
  try {
    const defs = await hub.definitions();
    assert.equal(defs[0].name, "mcp__web__t");
    const r = await hub.call("mcp__web__t", {}, {});
    assert.deepEqual(r, { output: "ok", isError: true });
    assert.equal(seen.find((s) => s.method === "tools/list").sid, "S1");
  } finally { hub.close(); await new Promise((r) => server.close(r)); }
});
