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
  const routesResult = applyPatch(findRoutes(), ROUTES_MARKER, ROUTES_ANCHOR, ROUTES_REPLACEMENT);

  const results = [engineResult, quoteResult, sysPromptResult, routesResult];
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
