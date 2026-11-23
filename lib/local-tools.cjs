"use strict";
/**
 * local-tools.cjs — the server-side native tools the HTTP engine can run.
 *
 * The CLI engine got these from Claude Code itself (`--disallowed-tools` minus
 * BARNOWL_ALLOW_TOOLS). Only Bash is reimplemented — the one tool barnowl
 * features rely on (seal relay decrypts via Bash + python3). Any other name in
 * BARNOWL_ALLOW_TOOLS is ignored with a one-time warning.
 */
const { spawn } = require("child_process");

const SUPPORTED = new Set(["Bash"]);
const TIMEOUT_MS = 120_000;
const MAX_OUTPUT = 30_000;
let warned = false;

function allowedLocalTools(env = process.env) {
  const names = String(env.BARNOWL_ALLOW_TOOLS || "").split(/[,\s]+/).filter(Boolean);
  const unsupported = names.filter((n) => !SUPPORTED.has(n));
  if (unsupported.length && !warned) {
    warned = true;
    console.warn(`[barnowl] http engine: ignoring unsupported native tools in BARNOWL_ALLOW_TOOLS: ${unsupported.join(", ")} (only Bash is implemented)`);
  }
  return names.filter((n) => SUPPORTED.has(n));
}

function bashDefinition() {
  return {
    name: "Bash",
    description: "Run a shell command with /bin/bash -c and return its combined stdout/stderr. Times out after 120 seconds.",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string", description: "The command to run" },
        description: { type: "string", description: "What the command does, in a few words" },
      },
      required: ["command"],
    },
  };
}

function truncate(s) {
  return s.length > MAX_OUTPUT ? s.slice(0, MAX_OUTPUT) + `\n… [truncated ${s.length - MAX_OUTPUT} chars]` : s;
}

function runBash(command, { cwd, signal, timeoutMs = TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    if (signal && signal.aborted) return resolve({ output: "Aborted", isError: true });
    const child = spawn("/bin/bash", ["-c", String(command)], {
      cwd: cwd || process.cwd(),
      env: process.env,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks = [];
    child.stdout.on("data", (c) => chunks.push(c));
    child.stderr.on("data", (c) => chunks.push(c));
    let reason = null;
    const kill = (why) => {
      reason = why;
      try { process.kill(-child.pid, "SIGKILL"); } catch (_) { try { child.kill("SIGKILL"); } catch (_) {} }
    };
    const timer = setTimeout(() => kill("timeout"), timeoutMs);
    const onAbort = () => kill("aborted");
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    const done = (code, err) => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      const out = truncate(Buffer.concat(chunks).toString("utf8"));
      if (err) return resolve({ output: String(err.message || err), isError: true });
      if (reason === "timeout") return resolve({ output: `${out}\nCommand timed out after ${timeoutMs}ms`, isError: true });
      if (reason === "aborted") return resolve({ output: "Aborted", isError: true });
      resolve({ output: code === 0 ? out : `${out}\nExit code ${code}`, isError: code !== 0 });
    };
    child.on("error", (e) => done(null, e));
    child.on("close", (code) => done(code));
  });
}

module.exports = { allowedLocalTools, bashDefinition, runBash, SUPPORTED };
