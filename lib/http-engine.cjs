"use strict";
/**
 * http-engine.cjs — replaces otterly's `claude -p` QueryFn with direct HTTP.
 *
 * Claude Code is "build the Messages request, send it, loop on tool_use".
 * This does the same against barnowl's own /v1/messages route
 * (BARNOWL_SELF_URL), so OAuth, the Claude Code identity block, token
 * refresh, seed-prepend, rewrite/block rules and the wire log all apply
 * exactly as they do for any other /v1/messages client. That route is
 * served ahead of otterly's queue, so the loopback cannot deadlock.
 *
 * The QueryFn yields the same raw events `claude -p --output-format
 * stream-json` prints (system/init, stream_event deltas, assistant, user
 * tool results, result), so otterly's normalizeEvents and every route
 * (OpenAI, Ollama, native, WebSocket) keep working unchanged.
 *
 * What `claude -p` used to provide and now lives here:
 *   --resume <id>     → lib/http-sessions.cjs (barnowl stores the history)
 *   MCP client        → lib/mcp-client.cjs via the tool provider
 *   native Bash       → lib/local-tools.cjs via the tool provider
 *   canUseTool / seal → checked before every server-side tool call
 */
const crypto = require("crypto");
const sessions = require("./http-sessions.cjs");

const DEFAULT_MAX_TOKENS = 16384;
const DEFAULT_MAX_TURNS = 20;
const TOTAL_TIMEOUT_MS = 10 * 60 * 1000;
const BETA_1M = "context-1m-2025-08-07";
const BETA_INTERLEAVED = "interleaved-thinking-2025-05-14";
const FAMILY_FALLBACK = {
  sonnet: "claude-sonnet-5-5",
  opus: "claude-opus-5-5",
  haiku: "claude-haiku-5-5",
  fable: "claude-fable-5-2",
};

function httpActive(env = process.env) {
  if (env.BARNOWL_ENGINE === "cli") return false;
  if (!env.BARNOWL_SELF_URL) return false;
  return env.BARNOWL_MESSAGES_OAUTH === "1" || !!env.ANTHROPIC_API_KEY;
}

// ── model / effort ───────────────────────────────────────────────────────────
function catalogIds() {
  try {
    const c = require("./model-catalog.cjs").readCatalog();
    const models = (c && c.providers && c.providers.claude && c.providers.claude.models) || [];
    return models.map((m) => (typeof m === "string" ? m : m && m.id)).filter(Boolean);
  } catch (_) {
    return [];
  }
}

/** Alias → concrete model id, "[1m]" suffix → 1M-context beta. Catalog ids are
 *  newest-first per family, so the first match is the current one. */
function resolveModel(name, ids = catalogIds()) {
  let model = String(name || "sonnet");
  const betas = [];
  if (/\[1m\]$/i.test(model)) {
    model = model.replace(/\[1m\]$/i, "");
    betas.push(BETA_1M);
  }
  const family = model === "default" ? "sonnet" : model;
  if (FAMILY_FALLBACK[family]) {
    const hit = ids.find((id) => id.startsWith(`claude-${family}-`) && !/\[1m\]$/i.test(id));
    model = hit || FAMILY_FALLBACK[family];
  }
  return { model, betas };
}

function effortParams(effort) {
  if (!effort) return {};
  const e = String(effort).toLowerCase();
  if (e === "none") return {};
  const mapped = e === "minimal" ? "low" : e === "xhigh" || e === "ultra" ? "max" : e;
  if (!["low", "medium", "high", "max"].includes(mapped)) return {};
  return { thinking: { type: "adaptive", display: "omitted" }, output_config: { effort: mapped } };
}

// ── message helpers ──────────────────────────────────────────────────────────
function asBlocks(content) {
  if (Array.isArray(content)) return content;
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  return [];
}

function appendTurns(history, turns) {
  const out = history.map((m) => ({ role: m.role, content: asBlocks(m.content).slice() }));
  for (const t of turns) {
    const blocks = asBlocks(t.content);
    if (!blocks.length) continue;
    const last = out[out.length - 1];
    if (last && last.role === t.role) last.content.push(...blocks);
    else out.push({ role: t.role, content: blocks.slice() });
  }
  return out;
}

/** Copy of messages with one cache breakpoint on the last block of the last
 *  user turn — the history prefix is then read from cache on the next turn. */
function withCacheBreakpoint(messages) {
  const out = messages.map((m) => ({ role: m.role, content: m.content.map((b) => ({ ...b })) }));
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i].role !== "user" || !out[i].content.length) continue;
    const blocks = out[i].content;
    const last = blocks[blocks.length - 1];
    if (last.type !== "thinking" && last.type !== "redacted_thinking") last.cache_control = { type: "ephemeral" };
    break;
  }
  return out;
}

function stripCache(messages) {
  return messages.map((m) => ({
    role: m.role,
    content: m.content.map((b) => {
      if (!b || !b.cache_control) return b;
      const { cache_control, ...rest } = b;
      return rest;
    }),
  }));
}

function addUsage(total, u) {
  if (!u) return;
  for (const [k, v] of Object.entries(u)) {
    if (typeof v === "number") total[k] = (total[k] || 0) + v;
  }
}

// ── SSE ──────────────────────────────────────────────────────────────────────
async function* readSse(body) {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of body) {
    buf += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buf.search(/\r?\n\r?\n/)) !== -1) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx).replace(/^\r?\n\r?\n/, "");
      const data = frame.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
      if (!data || data === "[DONE]") continue;
      try { yield JSON.parse(data); } catch (_) { /* skip non-JSON frame */ }
    }
  }
}

function errorText(status, raw) {
  try {
    const j = JSON.parse(raw);
    const msg = j && j.error && (j.error.message || j.error.type);
    if (msg) return `API Error: ${status} ${msg}`;
  } catch (_) {}
  return `API Error: ${status} ${String(raw).slice(0, 500)}`;
}

class UpstreamError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

// ── one Messages call ────────────────────────────────────────────────────────
/** Streams one /v1/messages call. Yields raw stream_event wrappers for text
 *  deltas; returns { content, stopReason, usage }. */
async function* callMessages({ url, headers, body, signal, fetchImpl }) {
  const res = await fetchImpl(url, { method: "POST", headers, body: JSON.stringify(body), signal });
  if (!res.ok) {
    const raw = await res.text().catch(() => "");
    throw new UpstreamError(errorText(res.status, raw), res.status);
  }
  const ctype = String(res.headers.get("content-type") || "");
  const usage = {};
  if (!ctype.includes("event-stream")) {
    // A block rule or rewrite can answer with a plain JSON message.
    const msg = await res.json();
    if (msg && msg.type === "error") throw new UpstreamError(errorText(res.status, JSON.stringify(msg)), res.status);
    addUsage(usage, msg.usage);
    for (const b of msg.content || []) {
      if (b.type === "text" && b.text) {
        yield { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: b.text } } };
      }
    }
    return { content: msg.content || [], stopReason: msg.stop_reason || null, usage };
  }
  const blocks = [];
  const partialJson = [];
  let stopReason = null;
  for await (const ev of readSse(res.body)) {
    switch (ev.type) {
      case "message_start":
        addUsage(usage, ev.message && ev.message.usage);
        break;
      case "content_block_start": {
        const b = { ...ev.content_block };
        if (b.type === "tool_use") { b.input = {}; partialJson[ev.index] = ""; }
        if (b.type === "text") b.text = b.text || "";
        if (b.type === "thinking") b.thinking = b.thinking || "";
        blocks[ev.index] = b;
        break;
      }
      case "content_block_delta": {
        const b = blocks[ev.index];
        const d = ev.delta || {};
        if (!b) break;
        if (d.type === "text_delta") {
          b.text += d.text;
          yield { type: "stream_event", event: ev };
        } else if (d.type === "input_json_delta") {
          partialJson[ev.index] += d.partial_json || "";
        } else if (d.type === "thinking_delta") {
          b.thinking += d.thinking || "";
        } else if (d.type === "signature_delta") {
          b.signature = (b.signature || "") + (d.signature || "");
        } else if (d.type === "citations_delta" && d.citation) {
          (b.citations = b.citations || []).push(d.citation);
        }
        break;
      }
      case "content_block_stop": {
        const b = blocks[ev.index];
        if (b && b.type === "tool_use") {
          const raw = partialJson[ev.index];
          try { b.input = raw ? JSON.parse(raw) : {}; } catch (_) { b.input = {}; }
        }
        break;
      }
      case "message_delta":
        if (ev.delta && ev.delta.stop_reason) stopReason = ev.delta.stop_reason;
        if (ev.usage && typeof ev.usage.output_tokens === "number") usage.output_tokens = ev.usage.output_tokens;
        break;
      case "error":
        throw new UpstreamError(`API Error: ${(ev.error && (ev.error.message || ev.error.type)) || "stream error"}`, 500);
      default:
        break;
    }
  }
  return { content: blocks.filter(Boolean), stopReason, usage };
}

// ── tool provider (Bash + MCP) ───────────────────────────────────────────────
function createDefaultToolProvider(env = process.env) {
  const local = require("./local-tools.cjs");
  let hub = null;
  const getHub = () => {
    if (hub === null) {
      hub = env.BARNOWL_MCP_CONFIG ? require("./mcp-client.cjs").createMcpHub(env.BARNOWL_MCP_CONFIG) : false;
    }
    return hub || null;
  };
  return {
    async definitions() {
      const defs = [];
      if (local.allowedLocalTools(env).includes("Bash")) defs.push(local.bashDefinition());
      const h = getHub();
      if (h) defs.push(...(await h.definitions()));
      return defs;
    },
    async call(name, input, ctx) {
      if (name === "Bash" && local.allowedLocalTools(env).includes("Bash")) {
        return local.runBash(input && input.command, ctx);
      }
      const h = getHub();
      if (h && name.startsWith("mcp__")) return h.call(name, input, ctx);
      return { output: `Unknown tool: ${name}`, isError: true };
    },
  };
}

async function permit(canUseTool, name, input, signal) {
  if (typeof canUseTool !== "function") return { allow: true, input };
  try {
    const d = await canUseTool(name, input, { signal });
    if (d && d.behavior === "allow") return { allow: true, input: d.updatedInput || input };
    return { allow: false, message: (d && d.message) || "Denied by permission handler" };
  } catch (e) {
    return { allow: false, message: `Permission check failed: ${e && e.message ? e.message : e}` };
  }
}

function errorResult(message, status, sessionId) {
  return { type: "result", subtype: "error_during_execution", is_error: true, result: message,
    api_error_status: status || null, session_id: sessionId };
}

// ── QueryFn ──────────────────────────────────────────────────────────────────
function createHttpQueryFn({ selfUrl, toolProvider, fetchImpl, catalog } = {}) {
  const doFetch = fetchImpl || ((...a) => fetch(...a));
  const provider = toolProvider === undefined ? createDefaultToolProvider() : toolProvider;

  return function httpQuery(args) {
    const opts = (args && args.options) || {};
    const prompt = typeof args.prompt === "string" ? args.prompt : JSON.stringify(args.prompt);
    return {
      async *[Symbol.asyncIterator]() {
        const startedAt = Date.now();
        const base = String(selfUrl || process.env.BARNOWL_SELF_URL || "").replace(/\/+$/, "");
        const url = `${base}/v1/messages`;
        const outer = opts.abortController ? opts.abortController.signal : null;
        const signal = outer ? AbortSignal.any([outer, AbortSignal.timeout(TOTAL_TIMEOUT_MS)]) : AbortSignal.timeout(TOTAL_TIMEOUT_MS);

        const sessionId = opts.resume && sessions.validId(opts.resume) ? opts.resume : crypto.randomUUID();
        const prior = opts.resume ? sessions.load(opts.resume) : null;
        const a = opts.anthropic || null;
        const newTurns = a && Array.isArray(a.messages)
          ? a.messages
          : [{ role: "user", content: [...(opts.images || []), { type: "text", text: prompt }] }];
        let system = a ? a.system : opts.systemPrompt;
        if ((system == null || system === "") && prior) system = prior.system;
        const history = appendTurns(prior ? prior.messages : [], newTurns);

        const { model, betas } = resolveModel(opts.model || (prior && prior.model) || "sonnet", catalog || catalogIds());
        const clientTools = a && Array.isArray(a.tools) && a.tools.length ? a.tools : null;
        const serverTools = !clientTools && provider ? await provider.definitions() : [];
        const tools = clientTools || (serverTools.length ? serverTools : null);
        const effort = effortParams(opts.effort);
        const headerBetas = new Set(betas);
        if (effort.thinking && tools) headerBetas.add(BETA_INTERLEAVED);

        const headers = { "content-type": "application/json", "anthropic-version": "2023-06-01" };
        if (process.env.ANTHROPIC_API_KEY) headers["x-api-key"] = process.env.ANTHROPIC_API_KEY;
        if (headerBetas.size) headers["anthropic-beta"] = [...headerBetas].join(",");

        yield { type: "system", subtype: "init", session_id: sessionId, model, cwd: opts.cwd || process.cwd(),
          tools: (tools || []).map((t) => t.name) };

        const usage = {};
        const maxTurns = opts.maxTurns || DEFAULT_MAX_TURNS;
        let lastText = "";
        let stopReason = null;
        let turns = 0;
        for (;;) {
          if (turns >= maxTurns) {
            yield errorResult(`Reached max turns (${maxTurns})`, null, sessionId);
            return;
          }
          turns++;
          const body = { model, max_tokens: (a && a.max_tokens) || DEFAULT_MAX_TOKENS, stream: true,
            messages: withCacheBreakpoint(history) };
          if (system) body.system = system;
          if (tools) body.tools = tools;
          if (clientTools && a.tool_choice) body.tool_choice = a.tool_choice;
          Object.assign(body, effort, opts.extraBody || {});

          let reply;
          try {
            const gen = callMessages({ url, headers, body, signal, fetchImpl: doFetch });
            for (;;) {
              const step = await gen.next();
              if (step.done) { reply = step.value; break; }
              yield step.value;
            }
          } catch (e) {
            if (outer && outer.aborted) throw Object.assign(new Error("Aborted"), { name: "AbortError" });
            if (e instanceof UpstreamError) { yield errorResult(e.message, e.status, sessionId); return; }
            yield errorResult(`API Error: ${e && e.message ? e.message : e}`, null, sessionId);
            return;
          }

          addUsage(usage, reply.usage);
          stopReason = reply.stopReason;
          const assistant = { role: "assistant", content: reply.content };
          history.push(assistant);
          const text = reply.content.filter((b) => b.type === "text").map((b) => b.text).join("");
          if (text) lastText = text;
          yield { type: "assistant", message: assistant };

          const toolUses = reply.content.filter((b) => b.type === "tool_use");
          if (stopReason !== "tool_use" || clientTools || !toolUses.length || !serverTools.length) break;

          const results = [];
          for (const tu of toolUses) {
            const p = await permit(opts.canUseTool, tu.name, tu.input, signal);
            if (!p.allow) {
              results.push({ type: "tool_result", tool_use_id: tu.id, content: p.message, is_error: true });
              continue;
            }
            const r = await provider.call(tu.name, p.input, { signal, cwd: opts.cwd });
            const block = { type: "tool_result", tool_use_id: tu.id, content: String(r.output ?? "") };
            if (r.isError) block.is_error = true;
            results.push(block);
          }
          if (outer && outer.aborted) throw Object.assign(new Error("Aborted"), { name: "AbortError" });
          const user = { role: "user", content: results };
          history.push(user);
          yield { type: "user", tool_use_result: true, message: user };
        }

        try {
          sessions.save(sessionId, { model: opts.model || (prior && prior.model) || null, system: system ?? null,
            messages: stripCache(history) });
        } catch (e) {
          console.warn(`[barnowl] http engine: session save failed: ${e.message}`);
        }
        yield { type: "result", subtype: "success", is_error: false, result: lastText, usage, stop_reason: stopReason,
          duration_ms: Date.now() - startedAt, total_cost_usd: 0, session_id: sessionId, num_turns: turns };
      },
    };
  };
}

module.exports = {
  httpActive,
  resolveModel,
  effortParams,
  createHttpQueryFn,
  createDefaultToolProvider,
  readSse,
  appendTurns,
  withCacheBreakpoint,
  stripCache,
};
