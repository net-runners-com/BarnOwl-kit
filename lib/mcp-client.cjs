"use strict";
/**
 * mcp-client.cjs — a small MCP client for the HTTP engine (no SDK dependency).
 *
 * The CLI engine got MCP from Claude Code (`--mcp-config`). Here barnowl talks
 * JSON-RPC 2.0 itself:
 *   initialize → notifications/initialized → tools/list (paged) → tools/call
 * Transports: stdio (newline-delimited JSON on a child process) and
 * Streamable HTTP (POST; JSON or SSE answer; Mcp-Session-Id kept).
 * Tool names follow Claude Code: mcp__<server>__<tool>.
 * Connections are lazy and cached for the process; a server that fails to
 * start is skipped (warning) without taking the others down.
 */
const fs = require("fs");
const { spawn } = require("child_process");

const PROTOCOL = "2025-06-18";
const CLIENT_INFO = { name: "barnowl", version: "1" };
const REQUEST_TIMEOUT_MS = 60_000;

function sseMessages(text) {
  const out = [];
  for (const frame of text.split(/\r?\n\r?\n/)) {
    const data = frame.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
    if (!data) continue;
    try { out.push(JSON.parse(data)); } catch (_) {}
  }
  return out;
}

function rpcError(msg) {
  const e = msg.error || {};
  return new Error(`MCP error ${e.code ?? ""}: ${e.message || "unknown"}`);
}

// ── stdio ────────────────────────────────────────────────────────────────────
function stdioTransport(cfg) {
  const child = spawn(cfg.command, cfg.args || [], {
    env: { ...process.env, ...(cfg.env || {}) },
    cwd: cfg.cwd,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const pending = new Map();
  let buf = "";
  let dead = null;
  const failAll = (err) => {
    dead = err;
    for (const p of pending.values()) p.reject(err);
    pending.clear();
  };
  child.on("error", (e) => failAll(e));
  child.on("exit", (code) => failAll(new Error(`MCP server exited (${code})`)));
  child.stderr.on("data", () => {});
  child.stdout.on("data", (c) => {
    buf += c.toString("utf8");
    let i;
    while ((i = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch (_) { continue; }
      const p = msg.id !== undefined && pending.get(msg.id);
      if (!p) continue;
      pending.delete(msg.id);
      if (msg.error) p.reject(rpcError(msg)); else p.resolve(msg.result);
    }
  });
  return {
    request(msg, signal) {
      if (dead) return Promise.reject(dead);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(msg.id); reject(new Error("MCP request timed out")); }, REQUEST_TIMEOUT_MS);
        const done = (fn) => (v) => { clearTimeout(timer); fn(v); };
        pending.set(msg.id, { resolve: done(resolve), reject: done(reject) });
        if (signal) signal.addEventListener("abort", () => { pending.delete(msg.id); clearTimeout(timer); reject(new Error("Aborted")); }, { once: true });
        child.stdin.write(JSON.stringify(msg) + "\n");
      });
    },
    notify(msg) { if (!dead) child.stdin.write(JSON.stringify(msg) + "\n"); },
    close() { try { child.kill(); } catch (_) {} },
  };
}

// ── Streamable HTTP ─────────────────────────────────────────────────────────
function httpTransport(cfg) {
  let sessionId = null;
  const post = async (msg, signal) => {
    const headers = { "content-type": "application/json", accept: "application/json, text/event-stream",
      "mcp-protocol-version": PROTOCOL, ...(cfg.headers || {}) };
    if (sessionId) headers["mcp-session-id"] = sessionId;
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const res = await fetch(cfg.url, { method: "POST", headers, body: JSON.stringify(msg),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    const sid = res.headers.get("mcp-session-id");
    if (sid) sessionId = sid;
    return res;
  };
  return {
    async request(msg, signal) {
      const res = await post(msg, signal);
      if (!res.ok) throw new Error(`MCP HTTP ${res.status}`);
      const ctype = String(res.headers.get("content-type") || "");
      const text = await res.text();
      const msgs = ctype.includes("event-stream") ? sseMessages(text) : [JSON.parse(text)];
      const hit = msgs.find((m) => m && m.id === msg.id);
      if (!hit) throw new Error("MCP HTTP: no response for request");
      if (hit.error) throw rpcError(hit);
      return hit.result;
    },
    notify(msg) { post(msg).then((r) => r.body && r.body.cancel && r.body.cancel()).catch(() => {}); },
    close() {},
  };
}

// ── client / hub ─────────────────────────────────────────────────────────────
function connect(name, cfg) {
  const t = cfg.type === "http" || cfg.type === "streamable-http" || (cfg.url && !cfg.command)
    ? httpTransport(cfg)
    : stdioTransport(cfg);
  let nextId = 1;
  const call = (method, params, signal) => t.request({ jsonrpc: "2.0", id: nextId++, method, params }, signal);
  const ready = (async () => {
    await call("initialize", { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: CLIENT_INFO });
    t.notify({ jsonrpc: "2.0", method: "notifications/initialized" });
  })();
  return {
    name,
    async listTools() {
      await ready;
      const tools = [];
      let cursor;
      do {
        const r = await call("tools/list", cursor ? { cursor } : {});
        tools.push(...((r && r.tools) || []));
        cursor = r && r.nextCursor;
      } while (cursor);
      return tools;
    },
    async callTool(tool, args, signal) {
      await ready;
      return call("tools/call", { name: tool, arguments: args || {} }, signal);
    },
    close: () => t.close(),
  };
}

function resultText(result) {
  const parts = ((result && result.content) || []).map((c) => {
    if (c.type === "text") return c.text;
    if (c.type === "resource" && c.resource && typeof c.resource.text === "string") return c.resource.text;
    return JSON.stringify(c);
  });
  if (!parts.length && result && result.structuredContent) parts.push(JSON.stringify(result.structuredContent));
  return parts.join("\n");
}

function createMcpHub(profilePath) {
  const servers = (JSON.parse(fs.readFileSync(profilePath, "utf8")).mcpServers) || {};
  const clients = new Map();
  let defsPromise = null;
  const toolMap = new Map(); // full name → { client, tool }

  const loadDefs = async () => {
    const defs = [];
    for (const [name, cfg] of Object.entries(servers)) {
      try {
        const client = connect(name, cfg || {});
        clients.set(name, client);
        for (const tool of await client.listTools()) {
          const full = `mcp__${name}__${tool.name}`;
          toolMap.set(full, { client, tool: tool.name });
          defs.push({ name: full, description: tool.description || "",
            input_schema: tool.inputSchema || { type: "object", properties: {} } });
        }
      } catch (e) {
        console.warn(`[barnowl] MCP server "${name}" unavailable: ${e.message}`);
        const c = clients.get(name);
        if (c) { c.close(); clients.delete(name); }
      }
    }
    return defs;
  };

  return {
    definitions() {
      if (!defsPromise) defsPromise = loadDefs();
      return defsPromise;
    },
    async call(fullName, input, { signal } = {}) {
      await this.definitions();
      const hit = toolMap.get(fullName);
      if (!hit) return { output: `Unknown MCP tool: ${fullName}`, isError: true };
      try {
        const r = await hit.client.callTool(hit.tool, input, signal);
        return { output: resultText(r), isError: !!(r && r.isError) };
      } catch (e) {
        return { output: e.message, isError: true };
      }
    },
    close() {
      for (const c of clients.values()) c.close();
      clients.clear();
    },
  };
}

module.exports = { createMcpHub };
