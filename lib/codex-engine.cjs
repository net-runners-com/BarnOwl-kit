"use strict";
/**
 * CodexEngine — a drop-in alternative to otterly's ClaudeEngine that fronts the
 * OpenAI **Codex CLI** (`codex exec`) instead of `claude`.
 *
 * Same shape as ClaudeEngine so routes-openai.js can use it interchangeably:
 *   - run(prompt, options) -> { text, cost, duration, sessionId, usage, tools }
 *   - async *stream(prompt, options) -> yields {type:"text"} then {type:"result"}
 *
 * Codex has no token-by-token stream on the CLI, so stream() runs to completion
 * and emits the whole answer as one `text` event — exactly how otterly's own CLI
 * path relays claude. barnowl's SSE handler already handles a single `text` event.
 *
 * Auth: whatever `codex login` set up (here: ChatGPT). We run codex clean:
 *   --ignore-user-config  → no MCP servers / hooks (fast, like claude's strict-mcp)
 *   --sandbox read-only    → model-generated commands can't write
 *   --ephemeral            → no session files on disk
 *   --skip-git-repo-check  → works from any cwd
 * The final agent message is captured via `-o <file>` (clean, just the text).
 *
 * Model routing: isCodexModel(model) decides Claude-vs-Codex in routes-openai.
 * A barnowl model id of "codex" uses codex's built-in default; any other id is
 * passed through as `codex -m <id>`.
 *
 * Env overrides:
 *   BARNOWL_CODEX_BIN   absolute path to the codex binary (else auto-resolved)
 *   BARNOWL_CODEX_SANDBOX  sandbox mode (default "read-only")
 *   BARNOWL_CODEX_TIMEOUT_MS  hard kill timeout (default 300000)
 */
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const EXTRA_PATHS = [
  path.join(os.homedir(), ".superset", "bin"),
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
];

/** Resolve an absolute path to the codex binary once, at load time. */
const CODEX_BIN = (() => {
  if (process.env.BARNOWL_CODEX_BIN) return process.env.BARNOWL_CODEX_BIN;
  const dirs = [...EXTRA_PATHS, ...String(process.env.PATH || "").split(":")];
  for (const d of dirs) {
    if (!d) continue;
    const p = path.join(d, "codex");
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch (_) { /* keep looking */ }
  }
  return "codex"; // last resort: rely on child PATH
})();

function childEnv() {
  const env = { ...process.env };
  const extra = EXTRA_PATHS.join(":");
  env.PATH = env.PATH ? env.PATH + ":" + extra : extra;
  return env;
}

/** True when a requested model should be served by Codex rather than Claude. */
function isCodexModel(model) {
  if (!model) return false;
  const m = String(model).toLowerCase();
  return (
    m === "codex" ||
    m.includes("codex") ||
    m.startsWith("gpt") ||
    /^o[1-9]/.test(m) // o1 / o3 / o4 reasoning models
  );
}

/** Map a barnowl model id to a codex `-m` value, or null to use codex's default. */
function mapModel(id) {
  if (!id) return null;
  const m = String(id).toLowerCase();
  if (m === "codex" || m === "codex-default" || m === "default") return null;
  return String(id);
}

/** Clamp an effort level to codex's set (minimal|low|medium|high). */
function mapCodexEffort(e) {
  const x = String(e || "").toLowerCase();
  if (x === "xhigh" || x === "max") return "high";
  if (["minimal", "low", "medium", "high"].includes(x)) return x;
  return "medium";
}

function parseTokens(stdout) {
  // codex prints "tokens used\n  1,234" near the end.
  const m = /tokens used[^0-9]*([\d,]+)/i.exec(stdout);
  return m ? parseInt(m[1].replace(/,/g, ""), 10) || 0 : 0;
}

/** Fallback text extraction if the -o file was empty: grab the last `codex` block. */
function extractFromStdout(stdout) {
  const idx = stdout.lastIndexOf("\ncodex\n");
  if (idx === -1) return "";
  let tail = stdout.slice(idx + "\ncodex\n".length);
  tail = tail.replace(/\n?tokens used[\s\S]*$/i, "");
  return tail.trim();
}

class CodexEngine {
  constructor(defaults) {
    this.defaults = defaults || {};
  }

  async run(prompt, options) {
    const opts = { ...this.defaults, ...(options || {}) };
    const promptStr = typeof prompt === "string" ? prompt : JSON.stringify(prompt);
    const fullPrompt = opts.systemPrompt
      ? `${opts.systemPrompt}\n\n${promptStr}`
      : promptStr;

    const lastFile = path.join(os.tmpdir(), `barnowl-codex-${crypto.randomUUID()}.txt`);
    const cwd = opts.cwd ? String(opts.cwd) : os.tmpdir();
    const sandbox = process.env.BARNOWL_CODEX_SANDBOX || "read-only";

    const args = [
      "exec",
      "--skip-git-repo-check",
      "--sandbox", sandbox,
      "--color", "never",
      "--ephemeral",
      "--ignore-user-config",
      "-C", cwd,
      "-o", lastFile,
    ];
    const model = mapModel(opts.model);
    if (model) args.push("-m", model);
    const effort = opts.effort || process.env.BARNOWL_CODEX_EFFORT;
    if (effort && String(effort).toLowerCase() !== "none") {
      args.push("-c", `model_reasoning_effort="${mapCodexEffort(effort)}"`);
    }
    args.push("-"); // prompt comes from stdin (avoids ARG_MAX on long transcripts)

    const timeoutMs = parseInt(process.env.BARNOWL_CODEX_TIMEOUT_MS || "", 10) || 300000;

    let stdout = "";
    let stderr = "";
    const child = spawn(CODEX_BIN, args, {
      env: childEnv(),
      stdio: ["pipe", "pipe", "pipe"],
    });

    let killTimer = null;
    let aborted = false;
    const kill = () => { try { child.kill("SIGTERM"); } catch (_) {} };
    const signal = opts.signal;
    const onAbort = () => { aborted = true; kill(); };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    killTimer = setTimeout(() => { aborted = true; kill(); }, timeoutMs);

    try {
      child.stdin.write(fullPrompt);
      child.stdin.end();
    } catch (_) { /* child may have died; handled below */ }
    child.stdout.on("data", (c) => { stdout += c; });
    child.stderr.on("data", (c) => { stderr += c; });

    const code = await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    });

    clearTimeout(killTimer);
    if (signal) signal.removeEventListener("abort", onAbort);

    let text = "";
    try { text = fs.readFileSync(lastFile, "utf8").trim(); } catch (_) {}
    try { fs.unlinkSync(lastFile); } catch (_) {}
    if (!text) text = extractFromStdout(stdout);

    if (aborted) throw new Error("Aborted");
    if (!text && code !== 0) {
      const detail = (stderr || stdout).trim().slice(-500);
      throw new Error(`codex exec failed (exit ${code})${detail ? ": " + detail : ""}`);
    }

    return {
      text,
      cost: 0,
      duration: 0,
      sessionId: "",
      usage: { input_tokens: 0, output_tokens: parseTokens(stdout) },
      tools: [],
    };
  }

  async *stream(prompt, options) {
    const result = await this.run(prompt, options);
    if (result.text) yield { type: "text", text: result.text };
    yield {
      type: "result",
      text: result.text,
      cost: result.cost,
      duration: result.duration,
      sessionId: result.sessionId,
      usage: result.usage,
    };
  }
}

module.exports = { CodexEngine, isCodexModel, mapModel, CODEX_BIN };
