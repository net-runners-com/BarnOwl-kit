/**
 * Warm session pool — keeps one live `claude` process per session id.
 *
 * Why: the one-shot path spawns a fresh `claude` per request, paying ~2s of
 * process startup every turn. The claude CLI's stream-json input mode is a
 * long-lived multi-turn REPL (the same mechanism the official SDK uses), so a
 * conversation pinned to a live process answers in pure model time.
 *
 * Lifecycle:
 *   request with session_id ──► pool hit?  ──► write msg to stdin (WARM)
 *                                └─ miss ──► spawn `claude --resume <id>` and
 *                                            keep it (first turn pays startup)
 *   idle > BARNOWL_SESSION_IDLE (600s) or LRU beyond BARNOWL_MAX_SESSIONS (8)
 *   ──► process killed; the next request falls back to the one-shot
 *       `--resume` path upstream, so conversation context is never lost.
 *
 * Loaded from patched routes-openai.js via createRequire. Any failure here
 * returns false and the caller falls back to the stateless resume path.
 */
"use strict";

const { spawn } = require("child_process");
const crypto = require("crypto");
const path = require("path");

const IDLE_SECONDS = parseInt(process.env.BARNOWL_SESSION_IDLE || "600", 10);
const MAX_SESSIONS = parseInt(process.env.BARNOWL_MAX_SESSIONS || "8", 10);
const TURN_TIMEOUT_MS = 5 * 60 * 1000;
const CLAUDE_BIN = process.env.BARNOWL_CLAUDE_BIN || "claude";

/** @type {Map<string, Entry>} */
const pool = new Map();

const reaper = setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of pool) {
    if (!entry.inFlight && now - entry.lastUsed > IDLE_SECONDS * 1000) {
      destroy(id);
    }
  }
}, 60_000);
reaper.unref();

function destroy(id) {
  const entry = pool.get(id);
  if (!entry) return;
  pool.delete(id);
  try { entry.proc.stdin.end(); } catch (_) {}
  try { entry.proc.kill(); } catch (_) {}
}

function evictLruIfNeeded() {
  while (pool.size >= MAX_SESSIONS) {
    let oldest = null;
    for (const [id, entry] of pool) {
      if (entry.inFlight) continue;
      if (!oldest || entry.lastUsed < pool.get(oldest).lastUsed) oldest = id;
    }
    if (!oldest) return; // everything busy — let the new spawn proceed anyway
    destroy(oldest);
  }
}

function spawnEntry(sessionId, options, model) {
  const args = [
    "--print", "--verbose",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--strict-mcp-config",
    "--setting-sources", "",
    "--resume", sessionId,
  ];
  if (process.env.BARNOWL_MCP_CONFIG) {
    args.push("--mcp-config", process.env.BARNOWL_MCP_CONFIG);
  }
  if (model) args.push("--model", String(model));
  if (options && options.systemPrompt) {
    args.push("--system-prompt", String(options.systemPrompt));
  }
  const proc = spawn(CLAUDE_BIN, args, {
    cwd: process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
  });
  const entry = {
    proc,
    buf: "",
    stderrTail: "",
    inFlight: null, // Promise while a turn is running
    onEvent: null, // per-turn stream-json event callback
    lastUsed: Date.now(),
    dead: false,
  };
  proc.stdout.on("data", (d) => {
    entry.buf += d.toString();
    let idx;
    while ((idx = entry.buf.indexOf("\n")) >= 0) {
      const line = entry.buf.slice(0, idx).trim();
      entry.buf = entry.buf.slice(idx + 1);
      if (!line) continue;
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }
      if (entry.onEvent) entry.onEvent(ev);
    }
  });
  proc.stderr.on("data", (d) => {
    entry.stderrTail = (entry.stderrTail + d.toString()).slice(-1000);
  });
  proc.on("exit", () => {
    entry.dead = true;
    if (pool.get(sessionId) === entry) pool.delete(sessionId);
    if (entry.onEvent) entry.onEvent({ type: "_exit" });
  });
  proc.on("error", () => {
    entry.dead = true;
    if (pool.get(sessionId) === entry) pool.delete(sessionId);
    if (entry.onEvent) entry.onEvent({ type: "_exit" });
  });
  pool.set(sessionId, entry);
  return entry;
}

/** Run one turn on a live entry. Resolves {text, sessionId, usage}. */
function runTurn(entry, prompt) {
  return new Promise((resolve, reject) => {
    if (entry.dead) return reject(new Error("session process is dead"));
    const timer = setTimeout(() => {
      finish(new Error(`turn timed out after ${TURN_TIMEOUT_MS}ms`));
      try { entry.proc.kill(); } catch (_) {}
    }, TURN_TIMEOUT_MS);
    function finish(err, val) {
      clearTimeout(timer);
      entry.onEvent = null;
      if (err) reject(err); else resolve(val);
    }
    entry.onEvent = (ev) => {
      if (ev.type === "_exit") {
        finish(new Error("claude exited mid-turn" + (entry.stderrTail ? `: ${entry.stderrTail.slice(-300)}` : "")));
      } else if (ev.type === "result") {
        if (ev.is_error) {
          finish(new Error(String(ev.result || "claude returned an error")));
        } else {
          finish(null, {
            text: String(ev.result ?? ""),
            sessionId: ev.session_id || null,
            usage: ev.usage || null,
          });
        }
      }
    };
    entry.proc.stdin.write(JSON.stringify({
      type: "user",
      message: { role: "user", content: prompt },
    }) + "\n", (err) => { if (err) finish(err); });
  });
}

function openaiUsage(usage) {
  const inp = (usage && usage.input_tokens) || 0;
  const out = (usage && usage.output_tokens) || 0;
  return { prompt_tokens: inp, completion_tokens: out, total_tokens: inp + out };
}

function writeNonStreaming(res, { text, sessionId, usage }, model) {
  const body = {
    id: `chatcmpl-barnowl-${crypto.randomUUID().slice(0, 12)}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage: openaiUsage(usage),
  };
  if (sessionId) body.session_id = sessionId;
  res.writeHead(200, {
    "Content-Type": "application/json",
    ...(sessionId ? { "X-Session-Id": sessionId } : {}),
  });
  res.end(JSON.stringify(body));
}

function writeStreaming(res, { text, sessionId, usage }, model) {
  const id = `chatcmpl-barnowl-${crypto.randomUUID().slice(0, 12)}`;
  const created = Math.floor(Date.now() / 1000);
  const chunk = (delta, finish) => ({
    id, object: "chat.completion.chunk", created, model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  });
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    ...(sessionId ? { "X-Session-Id": sessionId } : {}),
  });
  res.write(`data: ${JSON.stringify(chunk({ role: "assistant" }, null))}\n\n`);
  if (text) res.write(`data: ${JSON.stringify(chunk({ content: text }, null))}\n\n`);
  const stop = chunk({}, "stop");
  if (sessionId) stop.session_id = sessionId;
  stop.usage = openaiUsage(usage);
  res.write(`data: ${JSON.stringify(stop)}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
}

/**
 * Serve one chat turn from the warm pool. Returns true when the response has
 * been written; false when the caller should fall back to the one-shot
 * `--resume` path (pool disabled, spawn failed, process died, ...). Nothing
 * is written to `res` before the turn succeeds, so falling back is always safe.
 */
async function handle(req, res, ctx) {
  const { sessionId, prompt, options, model, stream } = ctx;
  if (process.env.BARNOWL_WARM_SESSIONS === "off") return false;
  if (!sessionId || typeof prompt !== "string") return false;
  try {
    let entry = pool.get(sessionId);
    if (!entry || entry.dead) {
      evictLruIfNeeded();
      entry = spawnEntry(sessionId, options, model);
    }
    // Serialize turns on the same session.
    while (entry.inFlight) await entry.inFlight.catch(() => {});
    if (entry.dead || pool.get(sessionId) !== entry) return false;
    const turn = runTurn(entry, prompt);
    entry.inFlight = turn;
    let result;
    try {
      result = await turn;
    } finally {
      entry.inFlight = null;
      entry.lastUsed = Date.now();
    }
    if (stream) writeStreaming(res, result, model);
    else writeNonStreaming(res, result, model);
    return true;
  } catch (_) {
    destroy(sessionId);
    return res.headersSent; // fall back unless we already started responding
  }
}

/** Test/ops helpers. */
function stats() {
  return {
    sessions: [...pool.keys()],
    count: pool.size,
    maxSessions: MAX_SESSIONS,
    idleSeconds: IDLE_SECONDS,
  };
}

module.exports = { handle, stats, _pool: pool, _destroy: destroy };
