#!/usr/bin/env node
/**
 * Idempotently patch the bundled `otterly` dependency so the `claude` CLI it
 * spawns runs with `--strict-mcp-config`.
 *
 * Why: otterly starts a fresh `claude` per request, and that claude boots every
 * globally-configured MCP server (mcp-video, playwright, godot, lazyweb, ...) on
 * each request — ~30s of pure startup overhead. `--strict-mcp-config` makes
 * claude ignore all MCP configuration, cutting a request from ~37s to ~6s.
 *
 * Tradeoff: otterly's claude has NO MCP tools (browser automation, etc.). That
 * is the intended behavior of this package (chat / code generation only).
 *
 * This runs on `postinstall` and again from `barnowl start`, so it survives
 * `npm ci`, `--ignore-scripts`, and otterly reinstalls. It only ever edits the
 * copy of otterly inside THIS package's node_modules — never a global install.
 */
"use strict";

const fs = require("fs");
const path = require("path");

const FLAG = "--strict-mcp-config";
const ANCHOR = '"--verbose"]';
// Env-driven: BARNOWL_MCP_CONFIG=<file> → load ONLY that profile's MCP
// servers (strict + --mcp-config). Unset → strict with no MCP (fastest).
// `--setting-sources ''` starts claude CLEAN: no user/project settings, no
// plugins, no CLAUDE.md, no memory hooks. Without it the spawned claude reads
// the machine owner's whole Claude Code environment — skills and past-session
// memories leak into API responses and distract it from the router role.
// `""` (a double-quoted empty string) is an empty argument in BOTH sh and
// cmd.exe, unlike `''` which cmd passes through literally. Same for the
// profile path: double quotes work on both platforms (and the path was
// previously not quoted at all).
const PATCHED =
  '"--verbose", "--setting-sources", \'""\', ...(process.env.BARNOWL_MCP_CONFIG ? ["' +
  FLAG +
  '", "--mcp-config", \'"\' + process.env.BARNOWL_MCP_CONFIG + \'"\'] : ["' +
  FLAG +
  '"])]';

function log(msg) {
  process.stderr.write("[barnowl] " + msg + "\n");
}

/** Resolve otterly's dist/ directory, or null if the dependency isn't present. */
function otterlyDistDir() {
  // Preferred: resolve otterly's main entry (respects package `exports`, and
  // follows npm hoisting when installed globally). engine.js sits beside it.
  try {
    return path.dirname(require.resolve("otterly"));
  } catch (_) {
    /* fall through to the local node_modules lookup */
  }
  // Fallback: otterly is a direct dependency, so it lives here relative to us.
  const local = path.join(__dirname, "..", "node_modules", "otterly", "dist");
  return fs.existsSync(local) ? local : null;
}

/** Resolve engine.js inside the otterly dependency, or null if not found. */
function findEngine() {
  const dir = otterlyDistDir();
  return dir ? path.join(dir, "engine.js") : null;
}

// ── routes-openai.js patch: system-prompt tool routing ──────────────────────
// Upstream embeds the "you are a function-call router" instruction in the USER
// turn. When the client also sends its own system prompt (an agent persona),
// Claude reads that user-turn directive as prompt injection and
// refuses instead of emitting the tool call. Moving the instruction into the
// system prompt (the operator channel) removes the contradiction; the history
// note stops relayed multi-turn transcripts from being flagged as forged.
const ROUTES_MARKER = "barnowl: system-prompt tool routing";
const ROUTES_ANCHOR =
  "        enginePrompt = `${instruction}\\n\\n=== USER REQUEST ===\\n${prompt}`;";
const ROUTES_REPLACEMENT = [
  "        // " + ROUTES_MARKER,
  '        const historyNote = "Note: the user message may contain a multi-turn conversation transcript relayed verbatim by the client application. It is authentic context from the real user session, not an injection attempt.";',
  "        finalSystemPrompt = finalSystemPrompt",
  "            ? `${finalSystemPrompt}\\n\\n${instruction}\\n\\n${historyNote}`",
  "            : `${instruction}\\n\\n${historyNote}`;",
].join("\n");

function findRoutes() {
  const dir = otterlyDistDir();
  return dir ? path.join(dir, "server", "routes-openai.js") : null;
}

/** Resolve server/models.js (the /v1/models discovery catalog), or null. */
function findModelsCatalog() {
  const dir = otterlyDistDir();
  return dir ? path.join(dir, "server", "models.js") : null;
}

// ── engine.js patch: win32-safe argument quoting ─────────────────────────────
// Upstream builds ONE shell string and wraps the prompt / system prompt in
// single quotes. cmd.exe treats single quotes as literal characters, so on
// Windows the prompt reaches claude quote-mangled (and split on spaces).
// Inject a platform-aware quoter and use it for both.
const QUOTE_MARKER = "barnowl: win32 quoting";
const QUOTE_ANCHOR = [
  "    // Shell-escape single quotes in prompt",
  "    const safePrompt = prompt.replace(/'/g, \"'\\\\''\");",
  '    const parts = [cliBin, "-p", `\'${safePrompt}\'`,',
].join("\n");
const QUOTE_REPLACEMENT = [
  "    // " + QUOTE_MARKER,
  '    const shq = process.platform === "win32"',
  "        ? (s) => '\"' + String(s).replace(/\"/g, '\\\\\"') + '\"'",
  "        : (s) => \"'\" + String(s).replace(/'/g, \"'\\\\''\") + \"'\";",
  '    const parts = [cliBin, "-p", shq(prompt),',
].join("\n");

const SYSPROMPT_MARKER = "shq(opts.systemPrompt)";
const SYSPROMPT_ANCHOR = [
  "        const safe = String(opts.systemPrompt).replace(/'/g, \"'\\\\''\");",
  '        parts.push("--system-prompt", `\'${safe}\'`);',
].join("\n");
const SYSPROMPT_REPLACEMENT =
  '        parts.push("--system-prompt", shq(opts.systemPrompt));';

// ── routes-openai.js patches: sessions over plain HTTP ───────────────────────
// Upstream accepts X-Session-Id / body.session_id but only ever matches
// sessions created by its WebSocket handler — for HTTP clients the lookup
// always misses and the id is silently ignored. These patches make sessions
// work statelessly instead: an unknown session id is passed to the claude CLI
// as `--resume <id>` (conversation continuity), and every response carries the
// session id claude assigned (body `session_id` + `X-Session-Id` header) so
// the client can resume with it on the next turn.
// Load barnowl's warm session pool into the ESM dist file. The pool lives in
// THIS package (lib/warm-sessions.cjs); dist/server/ resolves it 4 levels up.
const WARM_IMPORT_MARKER = "__barnowlWarm";
const WARM_IMPORT_ANCHOR = 'import { apiSessions } from "./session-store.js";';
const WARM_IMPORT_REPLACEMENT = [
  'import { apiSessions } from "./session-store.js";',
  'import { createRequire } from "module";',
  "const __barnowlWarm = (() => {",
  "    try {",
  '        return createRequire(import.meta.url)("../../../../lib/warm-sessions.cjs");',
  "    }",
  "    catch (_) {",
  "        return null;",
  "    }",
  "})();",
].join("\n");

const RESUME_MARKER = "options.resume = sessionId";
const RESUME_ANCHOR = [
  "        // Session not found — fall through to one-shot",
  "    }",
].join("\n");
const RESUME_REPLACEMENT = [
  "        // barnowl: warm session pool — serve from a live claude process when possible",
  "        if (__barnowlWarm && await __barnowlWarm.handle(req, res, { sessionId, prompt, options, model, stream })) {",
  "            return;",
  "        }",
  "        // barnowl: fall back to stateless resume via claude --resume",
  "        options.resume = sessionId;",
  "    }",
].join("\n");

const SESSION_RESP_MARKER = "response.session_id";
const SESSION_RESP_ANCHOR = [
  "        const response = claudeResultToOpenai(result.text, model, result.usage);",
  '        res.writeHead(200, { "Content-Type": "application/json" });',
].join("\n");
const SESSION_RESP_REPLACEMENT = [
  "        const response = claudeResultToOpenai(result.text, model, result.usage);",
  "        if (result.sessionId) {",
  "            response.session_id = result.sessionId;",
  '            res.setHeader("X-Session-Id", result.sessionId);',
  "        }",
  '        res.writeHead(200, { "Content-Type": "application/json" });',
].join("\n");

const SESSION_STREAM_MARKER = "stopChunk";
const SESSION_STREAM_ANCHOR = [
  '            else if (event.type === "result") {',
  "                lastResult = { cost: event.cost, usage: event.usage };",
  "                // Don't re-emit result.text — text/text_delta already covered it for both paths.",
  '                await sseWrite(res, sseData(makeStreamChunk(completionId, {}, "stop", model)));',
  "            }",
].join("\n");
const SESSION_STREAM_REPLACEMENT = [
  '            else if (event.type === "result") {',
  "                lastResult = { cost: event.cost, usage: event.usage };",
  "                // barnowl: attach session_id to the final chunk so streaming clients can resume",
  '                const stopChunk = makeStreamChunk(completionId, {}, "stop", model);',
  "                if (event.sessionId) stopChunk.session_id = event.sessionId;",
  "                await sseWrite(res, sseData(stopChunk));",
  "            }",
].join("\n");

// ── routes-openai.js patch: Codex engine routing ────────────────────────────
// Add a pickEngine(model) that returns a CodexEngine (fronting the `codex exec`
// CLI, ChatGPT-authed) for OpenAI/Codex model ids and ClaudeEngine otherwise.
// The CodexEngine lives in THIS package (lib/codex-engine.cjs); dist/server/
// resolves it 4 levels up, like the warm pool. Then every `new ClaudeEngine()`
// in the OpenAI route becomes `pickEngine(model)` so codex models route to codex.
const CODEX_IMPORT_MARKER = "barnowl: codex engine routing";
const CODEX_IMPORT_ANCHOR = 'import { ClaudeEngine } from "../engine.js";';
const CODEX_IMPORT_REPLACEMENT = [
  'import { ClaudeEngine } from "../engine.js";',
  "// barnowl: codex engine routing",
  'import { createRequire as __codexRequire } from "module";',
  "const __barnowlCodex = (() => {",
  "    try {",
  '        return __codexRequire(import.meta.url)("../../../../lib/codex-engine.cjs");',
  "    }",
  "    catch (_) {",
  "        return null;",
  "    }",
  "})();",
  "function pickEngine(model) {",
  "    if (__barnowlCodex && __barnowlCodex.isCodexModel(model)) {",
  "        return new __barnowlCodex.CodexEngine();",
  "    }",
  "    return new ClaudeEngine();",
  "}",
].join("\n");

// Replace-ALL: every engine instantiation in the OpenAI route becomes model-aware.
const CODEX_ENGINE_MARKER = "= pickEngine(model)";
const CODEX_ENGINE_FIND = "const engine = new ClaudeEngine();";
const CODEX_ENGINE_REPLACE = "const engine = pickEngine(model);";

// ── server/models.js patch: advertise Codex models on /v1/models ─────────────
const CODEX_MODELS_MARKER = 'id: "codex"';
const CODEX_MODELS_ANCHOR =
  '{ id: "claude-3-5-haiku-20241022", label: "Claude 3.5 Haiku", contextWindow: 200000 },';
const CODEX_MODELS_REPLACEMENT = [
  '{ id: "claude-3-5-haiku-20241022", label: "Claude 3.5 Haiku", contextWindow: 200000 },',
  '    { id: "codex", label: "OpenAI Codex (gpt-5.6-terra, default)", contextWindow: 272000 },',
  '    { id: "gpt-5.6-terra", label: "Codex gpt-5.6-terra (balanced)", contextWindow: 272000 },',
  '    { id: "gpt-5.5", label: "Codex gpt-5.5 (frontier)", contextWindow: 272000 },',
  '    { id: "gpt-5.4-mini", label: "Codex gpt-5.4-mini (small/fast)", contextWindow: 272000 },',
].join("\n");

// ── engine.js patch: pass `--effort <level>` to the claude CLI ───────────────
const EFFORT_ENGINE_MARKER = '"--effort", String(opts.effort)';
const EFFORT_ENGINE_ANCHOR = [
  "    if (opts.model)",
  '        parts.push("--model", String(opts.model));',
  "    if (opts.systemPrompt) {",
].join("\n");
const EFFORT_ENGINE_REPLACEMENT = [
  "    if (opts.model)",
  '        parts.push("--model", String(opts.model));',
  "    if (opts.effort)",
  '        parts.push("--effort", String(opts.effort));',
  "    if (opts.systemPrompt) {",
].join("\n");

// ── routes-openai.js patch: reasoning effort control ─────────────────────────
// Effort comes from the OpenAI `reasoning_effort` field OR a model ":<effort>"
// suffix (e.g. "gpt-5.5:high", "sonnet:high"). The suffix is stripped so the
// clean id still routes/labels correctly; the level is set on options.effort,
// which the CodexEngine turns into -c model_reasoning_effort and the claude CLI
// receives as --effort (engine.js patch above).
const EFFORT_PARSE_MARKER = "barnowl: effort control";
const EFFORT_PARSE_ANCHOR = '    const model = body.model || "claude-sonnet-4-20250514";';
const EFFORT_PARSE_REPLACEMENT = [
  '    let model = body.model || "claude-sonnet-4-20250514";',
  '    // barnowl: effort control — reasoning_effort field or model ":<effort>" suffix',
  "    let __effort = body.reasoning_effort || null;",
  '    { const __i = model.lastIndexOf(":"); if (__i > 0) { const __s = model.slice(__i + 1).toLowerCase(); if (["minimal", "low", "medium", "high", "xhigh", "max", "none"].includes(__s)) { __effort = __s; model = model.slice(0, __i); } } }',
].join("\n");

const EFFORT_SET_MARKER = "options.effort = __effort";
const EFFORT_SET_ANCHOR = [
  "    if (model) {",
  "        options.model = model;",
  "    }",
].join("\n");
const EFFORT_SET_REPLACEMENT = [
  "    if (model) {",
  "        options.model = model;",
  "    }",
  "    if (__effort) {",
  "        options.effort = __effort;",
  "    }",
].join("\n");

/** Apply one text patch. Returns "already" | "patched" | "missing" | "no-anchor". */
function applyPatch(file, marker, anchor, replacement) {
  if (!file || !fs.existsSync(file)) return "missing";
  const src = fs.readFileSync(file, "utf8");
  if (src.includes(marker)) return "already";
  if (!src.includes(anchor)) return "no-anchor";
  fs.copyFileSync(file, file + ".bak");
  fs.writeFileSync(file, src.replace(anchor, replacement));
  return "patched";
}

/** Like applyPatch but replaces EVERY occurrence of `find` (no regex). */
function applyPatchAll(file, marker, find, replace) {
  if (!file || !fs.existsSync(file)) return "missing";
  const src = fs.readFileSync(file, "utf8");
  if (src.includes(marker)) return "already";
  if (!src.includes(find)) return "no-anchor";
  fs.copyFileSync(file, file + ".bak");
  fs.writeFileSync(file, src.split(find).join(replace));
  return "patched";
}

/**
 * Apply both patches (engine speed flag + routes system-prompt routing).
 * Returns "patched" if anything changed, "already" if all in place,
 * "missing" / "no-anchor" when otterly is absent or its code shape changed.
 * Never throws — a failed patch just means otterly runs unpatched.
 */
function ensurePatched() {
  // engine.js: --strict-mcp-config / BARNOWL_MCP_CONFIG
  const engine = findEngine();
  let engineResult;
  if (!engine || !fs.existsSync(engine)) {
    engineResult = "missing";
  } else {
    const src = fs.readFileSync(engine, "utf8");
    if (src.includes(FLAG)) engineResult = "already";
    else if (!src.includes(ANCHOR)) engineResult = "no-anchor";
    else {
      fs.copyFileSync(engine, engine + ".bak");
      fs.writeFileSync(engine, src.replace(ANCHOR, PATCHED));
      engineResult = "patched";
    }
  }

  // engine.js: platform-aware quoting for prompt / system prompt (win32 support).
  // The system-prompt patch uses shq() introduced by the quote patch, so it is
  // only applied once the quote patch is in place.
  const quoteResult = applyPatch(engine, QUOTE_MARKER, QUOTE_ANCHOR, QUOTE_REPLACEMENT);
  const sysPromptResult = (quoteResult === "patched" || quoteResult === "already")
    ? applyPatch(engine, SYSPROMPT_MARKER, SYSPROMPT_ANCHOR, SYSPROMPT_REPLACEMENT)
    : quoteResult;

  // routes-openai.js: tool instruction → system prompt
  const routes = findRoutes();
  const routesResult = applyPatch(routes, ROUTES_MARKER, ROUTES_ANCHOR, ROUTES_REPLACEMENT);

  // routes-openai.js: HTTP sessions (warm pool + resume by session id + id in responses)
  const warmImportResult = applyPatch(routes, WARM_IMPORT_MARKER, WARM_IMPORT_ANCHOR, WARM_IMPORT_REPLACEMENT);
  const resumeResult = applyPatch(routes, RESUME_MARKER, RESUME_ANCHOR, RESUME_REPLACEMENT);
  const sessionRespResult = applyPatch(routes, SESSION_RESP_MARKER, SESSION_RESP_ANCHOR, SESSION_RESP_REPLACEMENT);
  const sessionStreamResult = applyPatch(routes, SESSION_STREAM_MARKER, SESSION_STREAM_ANCHOR, SESSION_STREAM_REPLACEMENT);

  // routes-openai.js: Codex engine routing (pickEngine + model-aware instantiation).
  // The engine replace-all only runs once the import/pickEngine block is in place.
  const codexImportResult = applyPatch(routes, CODEX_IMPORT_MARKER, CODEX_IMPORT_ANCHOR, CODEX_IMPORT_REPLACEMENT);
  const codexEngineResult = (codexImportResult === "patched" || codexImportResult === "already")
    ? applyPatchAll(routes, CODEX_ENGINE_MARKER, CODEX_ENGINE_FIND, CODEX_ENGINE_REPLACE)
    : codexImportResult;

  // server/models.js: advertise codex models on /v1/models + /api/tags discovery.
  const codexModelsResult = applyPatch(findModelsCatalog(), CODEX_MODELS_MARKER, CODEX_MODELS_ANCHOR, CODEX_MODELS_REPLACEMENT);

  // engine.js: claude --effort passthrough
  const effortEngineResult = applyPatch(engine, EFFORT_ENGINE_MARKER, EFFORT_ENGINE_ANCHOR, EFFORT_ENGINE_REPLACEMENT);
  // routes-openai.js: reasoning effort control (parse from request, set on options)
  const effortParseResult = applyPatch(routes, EFFORT_PARSE_MARKER, EFFORT_PARSE_ANCHOR, EFFORT_PARSE_REPLACEMENT);
  const effortSetResult = applyPatch(routes, EFFORT_SET_MARKER, EFFORT_SET_ANCHOR, EFFORT_SET_REPLACEMENT);

  const results = [
    engineResult, quoteResult, sysPromptResult,
    routesResult, warmImportResult, resumeResult, sessionRespResult, sessionStreamResult,
    codexImportResult, codexEngineResult, codexModelsResult,
    effortEngineResult, effortParseResult, effortSetResult,
  ];
  if (results.includes("patched")) return "patched";
  if (results.every((r) => r === "already")) return "already";
  if (results.includes("no-anchor")) return "no-anchor";
  if (results.includes("missing")) return "missing";
  return "already";
}

// Run when invoked directly (postinstall / prestart). When required as a module,
// callers use ensurePatched() and decide their own logging.
if (require.main === module) {
  let result;
  try {
    result = ensurePatched();
  } catch (err) {
    log("WARN could not patch otterly: " + err.message + " (server will still run, just slower)");
    process.exit(0);
  }
  switch (result) {
    case "patched":
      log("patched otterly for fast startup (MCP disabled, ~6s/request).");
      break;
    case "already":
      // Quiet on the common path.
      break;
    case "missing":
      log("WARN otterly not found yet; skipping speed patch (retried on start).");
      break;
    case "no-anchor":
      log("WARN otterly's command format changed; speed patch skipped. Requests will be slower; please report.");
      break;
  }
  process.exit(0);
}

module.exports = { ensurePatched, findEngine };
