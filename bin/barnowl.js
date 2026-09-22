#!/usr/bin/env node
/**
 * barnowl — a fast OpenAI-compatible local Claude server.
 *
 * Thin CLI around the `otterly` dependency. Bakes in the `--strict-mcp-config`
 * speed patch (see lib/patch-otterly.js) so each request returns in ~6s instead
 * of ~37s, at the cost of MCP tools (browser automation, etc.).
 *
 * Commands: start | stop | restart | status | verify | models | login | help
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const { ensurePatched } = require("../lib/patch-otterly.js");
const { checkForUpdate } = require("../lib/self-update.js");
const {
  PROVIDERS, HIDDEN, stateDir, refreshCatalog, readCatalog, summarize, claudeBin, codexBin,
} = require("../lib/model-catalog.cjs");
const { NAMES } = require("../lib/auth-errors.cjs");
const { PATH_KEYS, applyPaths, detectPaths, expandHome } = require("../lib/paths.cjs");

const PKG = require("../package.json");

// ── Config ──────────────────────────────────────────────────────────────────
// Resolution order (weakest → strongest):
//   built-in defaults < config file < env vars < CLI flags
// Config file lookup: --config <path> > ./barnowl.config.json > ~/.barnowl/config.json
const BUILTIN = {
  port: "11435",
  dir: process.cwd(),
  mcp: undefined, // MCP profile name/path; undefined = fast chat (no MCP)
  queueTimeout: "300",
  maxConcurrent: "5",
  maxQueue: "50",
  rateLimit: "60",
  apiKey: undefined, // forwarded to otterly's OTTERLY_API_KEY (Bearer auth) when present
  autoUpdate: "true", // git-clone installs fast-forward to origin/main on start
};

// The config file is always looked up in ~/.barnowl; paths.stateDir only moves
// barnowl's runtime files (pid, log, catalog, images).
const CONFIG_HOME = path.join(os.homedir(), ".barnowl");
const GLOBAL_CONFIG = path.join(CONFIG_HOME, "config.json");
// Set by initPaths() once the config file's `paths` are applied.
let STATE_DIR;
let PID_FILE;
let LOG_FILE;
let PATHS;

// ── Small helpers ─────────────────────────────────────────────────────────
// initPaths() and parseFlags() both load the config; parse (and warn) once.
const configCache = new Map();

/** Find and parse the config file (memoized). Returns { path, data } or null. */
function loadConfigFile(explicitPath) {
  const cacheKey = explicitPath || "";
  if (configCache.has(cacheKey)) return configCache.get(cacheKey);
  const found = findConfigFile(explicitPath);
  configCache.set(cacheKey, found);
  return found;
}

function findConfigFile(explicitPath) {
  const candidates = explicitPath
    ? [path.resolve(explicitPath)]
    : [path.join(process.cwd(), "barnowl.config.json"), GLOBAL_CONFIG];
  for (const p of candidates) {
    if (!fs.existsSync(p)) continue;
    try {
      return { path: p, data: JSON.parse(fs.readFileSync(p, "utf8")) };
    } catch (e) {
      console.error(`WARN: config file ${p} is not valid JSON (${e.message}) — ignored.`);
      return null;
    }
  }
  return null;
}

/** Layer built-ins < file < env < flags into the effective config. */
function parseFlags(argv) {
  // flags first (so --config is known before file lookup)
  const flags = {};
  let configPath;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-p" || a === "--port") flags.port = argv[++i];
    else if (a === "-d" || a === "--dir") flags.dir = argv[++i];
    else if (a === "--mcp") flags.mcp = argv[++i];
    else if (a === "--config") configPath = argv[++i];
    else if (a === "--no-update") flags.autoUpdate = "false";
  }

  const file = loadConfigFile(configPath);
  const f = file ? file.data : {};
  const env = {
    port: process.env.BARNOWL_PORT,
    dir: process.env.BARNOWL_WORK_DIR,
    mcp: process.env.BARNOWL_MCP,
    queueTimeout: process.env.BARNOWL_QUEUE_TIMEOUT,
    maxConcurrent: process.env.BARNOWL_MAX_CONCURRENT,
    maxQueue: process.env.BARNOWL_MAX_QUEUE,
    rateLimit: process.env.BARNOWL_RATE_LIMIT,
    apiKey: process.env.BARNOWL_API_KEY,
    autoUpdate: process.env.BARNOWL_AUTO_UPDATE,
  };

  const pick = (key) => {
    for (const layer of [flags, env, f]) {
      if (layer[key] !== undefined && layer[key] !== null && layer[key] !== "") {
        return String(layer[key]);
      }
    }
    return BUILTIN[key] === undefined ? undefined : String(BUILTIN[key]);
  };

  const out = {
    port: pick("port"),
    dir: pick("dir"),
    mcp: pick("mcp"),
    queueTimeout: pick("queueTimeout"),
    maxConcurrent: pick("maxConcurrent"),
    maxQueue: pick("maxQueue"),
    rateLimit: pick("rateLimit"),
    apiKey: pick("apiKey"),
    autoUpdate: !["0", "false", "no", "off"].includes(String(pick("autoUpdate")).toLowerCase()),
    configFile: file ? file.path : null,
  };
  // "mcp": false / "none" in the file explicitly disables MCP even if env sets it
  if (out.mcp === "false" || out.mcp === "none") out.mcp = undefined;
  // "guard" block (nested object, not a flat key): outbound PII guard for
  // everything leaving the machine. env > file; enabled accepts true/"1"/"on".
  const g = f.guard && typeof f.guard === "object" ? f.guard : {};
  const truthy = (v) => ["1", "true", "yes", "on"].includes(String(v).toLowerCase());
  const gl = g.llm && typeof g.llm === "object" ? g.llm : {};
  out.guard = {
    enabled: process.env.BARNOWL_GUARD !== undefined ? truthy(process.env.BARNOWL_GUARD) : truthy(g.enabled),
    policy: process.env.BARNOWL_GUARD_POLICY || g.policy || null,
    maskCmd: process.env.BARNOWL_GUARD_MASK_CMD || g.maskCmd || null,
    upstream: process.env.BARNOWL_GUARD_UPSTREAM || g.upstream || null,
    // optional second stage: any OpenAI-compatible LLM judges the masked text
    llm: {
      url: process.env.BARNOWL_GUARD_LLM_URL || gl.url || null,
      model: process.env.BARNOWL_GUARD_LLM_MODEL || gl.model || null,
      apiKey: process.env.BARNOWL_GUARD_LLM_KEY || gl.apiKey || null,
      timeoutMs: process.env.BARNOWL_GUARD_LLM_TIMEOUT_MS || gl.timeoutMs || null,
      maxChars: process.env.BARNOWL_GUARD_LLM_MAXCHARS || gl.maxChars || null,
      prompt: process.env.BARNOWL_GUARD_LLM_PROMPT || gl.prompt || null,
    },
  };
  return out;
}

/** Apply the config file's `paths` (env wins) and derive the runtime file locations. */
function initPaths(argv) {
  const i = argv.indexOf("--config");
  const file = loadConfigFile(i >= 0 ? argv[i + 1] : undefined);
  PATHS = applyPaths(file && file.data ? file.data.paths : null);
  STATE_DIR = stateDir();
  PID_FILE = path.join(STATE_DIR, "barnowl.pid");
  LOG_FILE = path.join(STATE_DIR, "barnowl.log");
}

function baseUrl(port) {
  return `http://localhost:${port}`;
}

function resolveOtterlyCli() {
  // Resolve otterly's main entry (respects package `exports` + npm hoisting);
  // cli.js sits beside it in dist/.
  try {
    return path.join(path.dirname(require.resolve("otterly")), "cli.js");
  } catch (_) {
    /* fall through */
  }
  const local = path.join(__dirname, "..", "node_modules", "otterly", "dist", "cli.js");
  if (fs.existsSync(local)) return local;
  throw new Error("otterly dependency not found. Run `npm install` in the barnowl directory.");
}

function readPid() {
  try {
    const pid = parseInt(fs.readFileSync(PID_FILE, "utf8").trim(), 10);
    return Number.isFinite(pid) ? pid : null;
  } catch (_) {
    return null;
  }
}

function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (_) {
    return false;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function httpJson(url, opts) {
  const res = await fetch(url, opts);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch (_) {
    /* leave json null */
  }
  return { status: res.status, json, text };
}

/** Model / auth lines for start and login, plus a hint per unhealthy login. */
function printCatalogSummary(catalog) {
  const s = summarize(catalog);
  const count = (p) => (s[p].count === null ? "static list" : String(s[p].count));
  console.log(`  Models   : Claude ${count("claude")} · Codex ${count("codex")}`);
  console.log(`  Auth     : claude ${s.claude.status} · codex ${s.codex.status}`);
  for (const p of PROVIDERS) {
    const { status, message } = s[p];
    if (status === "revoked") console.log(`  WARN: ${NAMES[p]} login revoked — run: barnowl login ${p}`);
    else if (status === "logged_out") console.log(`  WARN: not logged in to ${NAMES[p]} — run: barnowl login ${p}`);
    else if (status === "unknown" && message) console.log(`  Note: ${NAMES[p]} model list not refreshed (${message})`);
  }
  if (catalog && catalog.writeError) console.error(`  WARN: could not save the model catalog: ${catalog.writeError}`);
}

/** Auth block for `barnowl status` (works while the server is down). */
function printAuthStatus(catalog) {
  if (!catalog) {
    console.log("\nAuth: no catalog yet — run `barnowl start` or `barnowl login`");
    return;
  }
  const s = summarize(catalog);
  console.log(`\nAuth (catalog refreshed ${catalog.refreshedAt || "never"}):`);
  for (const p of PROVIDERS) {
    const { status, checkedAt, message } = s[p];
    console.log(`  ${p.padEnd(7)} ${status.padEnd(11)} checked ${checkedAt || "-"}${message ? `  — ${message}` : ""}`);
  }
}

// ── Commands ────────────────────────────────────────────────────────────────
async function cmdStart(argv) {
  const cfg = parseFlags(argv);
  fs.mkdirSync(STATE_DIR, { recursive: true });

  // Follow GitHub: fast-forward this clone before launching. After an update
  // the code loaded in this process is stale, so the start re-runs in a child.
  const root = path.join(__dirname, "..");
  if (cfg.autoUpdate && fs.existsSync(path.join(root, ".git")) && !isAlive(readPid())) {
    const up = checkForUpdate(root);
    if (up.status === "updated") {
      console.log(`  Updated ${up.from} → ${up.to} (${up.commits} commit${up.commits === 1 ? "" : "s"})`);
      if (up.installFailed) console.error("  WARN: npm install failed after the update; run it in " + root);
      const r = spawnSync(process.execPath, [__filename, "start", ...argv], {
        stdio: "inherit",
        env: { ...process.env, BARNOWL_AUTO_UPDATE: "0" },
      });
      return r.status ?? 1;
    }
    if (up.status !== "current") console.log(`  Auto-update skipped: ${up.reason}`);
  }

  if (cfg.configFile) console.log(`  Config   : ${cfg.configFile}`);
  // otterly reads OTTERLY_API_KEY for Bearer auth; forward barnowl's key to it.
  if (cfg.apiKey) process.env.OTTERLY_API_KEY = cfg.apiKey;

  // Outbound PII guard → env for the server process (read by lib/guard.cjs
  // inside the patched otterly). The /v1/messages passthrough route exists
  // either way; masking / image rejection only happens when enabled.
  if (cfg.guard.enabled) {
    process.env.BARNOWL_GUARD = "1";
    if (cfg.guard.policy) process.env.BARNOWL_GUARD_POLICY = expandHome(cfg.guard.policy, os.homedir());
    if (cfg.guard.maskCmd) process.env.BARNOWL_GUARD_MASK_CMD = cfg.guard.maskCmd;
    if (cfg.guard.upstream) process.env.BARNOWL_GUARD_UPSTREAM = cfg.guard.upstream;
    const llm = cfg.guard.llm;
    if (llm.url) {
      process.env.BARNOWL_GUARD_LLM_URL = llm.url;
      if (llm.model) process.env.BARNOWL_GUARD_LLM_MODEL = String(llm.model);
      if (llm.apiKey) process.env.BARNOWL_GUARD_LLM_KEY = String(llm.apiKey);
      if (llm.timeoutMs) process.env.BARNOWL_GUARD_LLM_TIMEOUT_MS = String(llm.timeoutMs);
      if (llm.maxChars) process.env.BARNOWL_GUARD_LLM_MAXCHARS = String(llm.maxChars);
      if (llm.prompt) process.env.BARNOWL_GUARD_LLM_PROMPT = String(llm.prompt);
    }
    console.log(`  Guard    : ON — text masked, images rejected, fail-closed (policy: ${cfg.guard.policy || "secret-guard defaults"})`);
    if (llm.url) console.log(`  Guard LLM: ${llm.model || "qwen2.5:3b"} @ ${llm.url} (verdict on masked text)`);
    console.log(`  Anthropic: ${baseUrl(cfg.port)} (point ANTHROPIC_BASE_URL here for a guarded passthrough)`);
  }

  // Make sure the speed patch is applied to our otterly copy.
  try {
    if (ensurePatched() === "patched") {
      console.log("  Applied speed patch to otterly (MCP disabled).");
    }
  } catch (_) {
    console.error("  WARN: speed patch failed; server will run but slower.");
  }

  // Optional MCP profile: --mcp <name|path>. claude then loads ONLY that
  // profile's servers (server-side tool execution). Unset → no MCP (fast chat).
  if (cfg.mcp) {
    const direct = path.resolve(cfg.mcp);
    const named = path.join(__dirname, "..", "config", "mcp", `${cfg.mcp}.json`);
    const mcpPath = fs.existsSync(direct) ? direct : fs.existsSync(named) ? named : null;
    if (mcpPath) {
      process.env.BARNOWL_MCP_CONFIG = mcpPath;
      console.log(`  MCP profile: ${mcpPath} (server-side tools ON)`);
    } else {
      console.error(`  WARN: mcp profile not found: ${cfg.mcp} (looked at ${direct}, ${named})`);
    }
  }

  const existing = readPid();
  if (isAlive(existing)) {
    console.log(`Already running (PID ${existing})`);
    console.log(`  Base URL: ${baseUrl(cfg.port)}/v1`);
    return 0;
  }

  // Ask the Claude / Codex backends which models these logins can use. The
  // server reads the result from the catalog file (lib/auth-state.cjs).
  printCatalogSummary(await refreshCatalog());

  const cli = resolveOtterlyCli();
  const args = [
    cli, "serve",
    "-p", cfg.port,
    "-d", cfg.dir,
    "--queue-timeout", cfg.queueTimeout,
    "--max-concurrent", cfg.maxConcurrent,
    "--max-queue", cfg.maxQueue,
    "--rate-limit", cfg.rateLimit,
  ];

  const logFd = fs.openSync(LOG_FILE, "a");
  const child = spawn(process.execPath, args, {
    detached: true,
    windowsHide: true,
    stdio: ["ignore", logFd, logFd],
    env: process.env,
  });
  child.unref();
  fs.writeFileSync(PID_FILE, String(child.pid));

  console.log("Starting barnowl...");
  console.log(`  Base URL : ${baseUrl(cfg.port)}/v1`);
  console.log(`  Work dir : ${cfg.dir}`);
  console.log(`  Log      : ${LOG_FILE}`);

  await sleep(1500);
  if (isAlive(child.pid)) {
    console.log(`Started (PID ${child.pid})`);
    console.log(`  Model names: sonnet | opus | haiku | fable`);
    return 0;
  }
  console.error(`Failed to start. Check the log: ${LOG_FILE}`);
  try {
    const tail = fs.readFileSync(LOG_FILE, "utf8").split("\n").slice(-15).join("\n");
    console.error(tail);
  } catch (_) {}
  return 1;
}

function killByPort(port) {
  // Best-effort fallback: kill any `otterly serve` bound to the port.
  if (process.platform === "win32") {
    const r = spawnSync("powershell", [
      "-NoProfile", "-Command",
      `Get-NetTCPConnection -LocalPort ${Number(port)} -State Listen -ErrorAction SilentlyContinue | ForEach-Object { $_.OwningProcess }`,
    ], { encoding: "utf8" });
    const pids = [...new Set((r.stdout || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean))];
    let killed = 0;
    for (const pidStr of pids) {
      const pid = parseInt(pidStr, 10);
      if (!Number.isFinite(pid)) continue;
      const cmd = spawnSync("powershell", [
        "-NoProfile", "-Command",
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`,
      ], { encoding: "utf8" }).stdout || "";
      if (cmd.includes("otterly")) {
        try { process.kill(pid); killed++; } catch (_) {}
      }
    }
    return killed;
  }
  const r = spawnSync("lsof", ["-ti", `:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" });
  const pids = (r.stdout || "").split("\n").map((s) => s.trim()).filter(Boolean);
  let killed = 0;
  for (const pidStr of pids) {
    const pid = parseInt(pidStr, 10);
    const cmd = spawnSync("ps", ["-p", pidStr, "-o", "command="], { encoding: "utf8" }).stdout || "";
    if (cmd.includes("otterly")) {
      try { process.kill(pid); killed++; } catch (_) {}
    }
  }
  return killed;
}

async function cmdStop(argv) {
  const cfg = parseFlags(argv);
  let stopped = false;
  const pid = readPid();
  if (isAlive(pid)) {
    try { process.kill(pid); } catch (_) {}
    await sleep(1000);
    if (isAlive(pid)) {
      try { process.kill(pid, "SIGKILL"); } catch (_) {}
    }
    console.log(`Stopped barnowl (PID ${pid})`);
    stopped = true;
  }
  try { fs.unlinkSync(PID_FILE); } catch (_) {}

  if (!stopped) {
    const n = killByPort(cfg.port);
    if (n > 0) {
      console.log(`Stopped ${n} stray otterly process(es) on port ${cfg.port}`);
      stopped = true;
    }
  }
  if (!stopped) console.log(`Not running (port ${cfg.port})`);
  return 0;
}

async function cmdRestart(argv) {
  await cmdStop(argv);
  await sleep(500);
  return cmdStart(argv);
}

async function cmdStatus(argv) {
  const cfg = parseFlags(argv);
  let code = 1;
  try {
    const { status, json } = await httpJson(`${baseUrl(cfg.port)}/api/status`);
    console.log(`HTTP ${status}`);
    if (json) console.log(JSON.stringify(json, null, 2));
    code = status === 200 ? 0 : 1;
  } catch (err) {
    console.error(`Not reachable on ${baseUrl(cfg.port)} (${err.message})`);
  }
  printAuthStatus(readCatalog());
  return code;
}

async function cmdVerify(argv) {
  const cfg = parseFlags(argv);
  const base = baseUrl(cfg.port);
  console.log(`=== barnowl verify (${base}/v1) ===\n`);

  // 1. status
  process.stdout.write("[1/3] GET /api/status ... ");
  try {
    const { status } = await httpJson(`${base}/api/status`);
    console.log(status === 200 ? "ok" : `HTTP ${status}`);
  } catch (e) {
    console.log("FAIL " + e.message);
    return 1;
  }

  // 2. models
  process.stdout.write("[2/3] GET /v1/models  ... ");
  try {
    const { json } = await httpJson(`${base}/v1/models`);
    const ids = (json && json.data ? json.data : []).map((m) => m.id).join(", ");
    console.log("ok  (" + ids + ")");
  } catch (e) {
    console.log("FAIL " + e.message);
    return 1;
  }

  // 3. chat completion + timing
  process.stdout.write("[3/3] POST /v1/chat/completions (sonnet) ... ");
  const t0 = Date.now();
  try {
    const { status, json } = await httpJson(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "sonnet",
        messages: [{ role: "user", content: "Reply with exactly: ok" }],
        max_tokens: 10,
      }),
    });
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    const reply = json && json.choices && json.choices[0] && json.choices[0].message
      ? json.choices[0].message.content : "(no content)";
    if (status === 200) {
      console.log(`ok  "${String(reply).slice(0, 40)}"  (${secs}s)`);
      console.log("\nOK");
      return 0;
    }
    console.log(`HTTP ${status}`);
    return 1;
  } catch (e) {
    console.log("FAIL " + e.message);
    return 1;
  }
}

function cmdModels() {
  const catalog = readCatalog();
  if (catalog) {
    console.log("Models from the live catalog (refreshed on every `barnowl start`):");
    for (const p of PROVIDERS) {
      const e = catalog.providers[p];
      if (!e) continue;
      const hidden = HIDDEN.has(e.status) ? ` — hidden from /v1/models; run: barnowl login ${p}` : "";
      console.log(`\n${NAMES[p]} (${e.status}${hidden}):`);
      const models = Array.isArray(e.models) ? e.models : [];
      if (!models.length) console.log("  (static list)");
      for (const m of models) console.log(`  ${m.id}  — ${m.label}`);
    }
    return 0;
  }
  let models = [];
  try {
    models = require("../config/models.json").models || [];
  } catch (_) {}
  console.log("Recommended model names (aliases):");
  console.log("  sonnet   — everyday / coding (default)");
  console.log("  opus     — hardest reasoning");
  console.log("  haiku    — fastest / lightweight");
  console.log("  fable    — most capable (currently Fable 5.1)");
  if (models.length) {
    console.log("\nAll ids in config/models.json:");
    for (const m of models) console.log("  " + m.id + (m.label ? "  — " + m.label : ""));
  }
  return 0;
}

async function cmdLogin(argv) {
  const which = argv[0];
  if (which && !PROVIDERS.includes(which)) {
    console.error("Usage: barnowl login [claude|codex]");
    return 1;
  }
  let targets = which ? [which] : null;
  if (!targets) {
    const s = summarize(await refreshCatalog());
    targets = PROVIDERS.filter((p) => HIDDEN.has(s[p].status));
    if (!targets.length) {
      console.log("Claude and Codex logins are OK — nothing to do. (barnowl login claude|codex forces one)");
      return 0;
    }
  }
  for (const p of targets) {
    const [bin, args] = p === "claude" ? [claudeBin(), ["auth", "login"]] : [codexBin(), ["login"]];
    console.log(`→ ${bin} ${args.join(" ")}`);
    const r = spawnSync(bin, args, { stdio: "inherit", shell: process.platform === "win32" });
    if (r.status !== 0) {
      console.error(`${NAMES[p]} login did not complete (${r.error ? r.error.message : `exit ${r.status}`}).`);
      return 1;
    }
  }
  printCatalogSummary(await refreshCatalog());
  console.log("A running server picks this up within a few seconds — no restart needed.");
  return 0;
}

function cmdHelp() {
  console.log(`
  barnowl v${PKG.version} — fast OpenAI-compatible local Claude server

  Usage:
    barnowl start [-p <port>] [-d <dir>] [--mcp <profile>] [--config <file>] [--no-update]
    barnowl stop  [-p <port>]              Stop the server
    barnowl restart                        Restart
    barnowl status                         Health check (JSON)
    barnowl verify                         End-to-end check + latency
    barnowl models                         Live model list (per login)
    barnowl login [claude|codex]           Re-login (revoked / expired), no restart
    barnowl config                         Show effective config + source
    barnowl config init [path]             Create a starter config file
    barnowl help | version

  Config file (flags > env > file > defaults):
    ./barnowl.config.json, or ~/.barnowl/config.json
    { "port": 11435, "dir": "...", "mcp": "sheet", ... }  ("mcp": "none" disables)

  Per-user paths (config "paths" block; env vars win; see README "Setup with an AI agent"):
    claudeBin, codexBin, python, codexHome, claudeKeychainAccount, claudeCredentialsFile, stateDir

  Auto-update:
    git-clone installs fast-forward to origin/main on start
    (--no-update, BARNOWL_AUTO_UPDATE=0, or "autoUpdate": false to skip)

  Models & logins:
    start asks Claude / Codex which models your logins can use (<state dir>/catalog.json);
    a revoked login answers 401 and its models leave /v1/models until \`barnowl login\`

  Client setup:
    Base URL : http://localhost:11435/v1
    API key  : any string (auth disabled unless BARNOWL_API_KEY is set)
    Models   : sonnet | opus | haiku | fable

  Outbound PII guard (config "guard" block):
    { "guard": { "enabled": true, "policy": "~/path/to/policy-dir",
                 "llm": { "url": "http://127.0.0.1:11434/v1/chat/completions", "model": "qwen2.5:3b" } } }
    Masks every outbound text via secret-guard, rejects images, fails closed.
    Also adds POST /v1/messages — a guarded anthropic passthrough for Claude
    Code (ANTHROPIC_BASE_URL=http://localhost:11435). The policy dir's
    secret-guard.json is used when present. "llm" adds a second stage: any
    OpenAI-compatible LLM judges the masked text; leak verdict → 403.

  Env: BARNOWL_PORT, BARNOWL_WORK_DIR, BARNOWL_API_KEY, BARNOWL_AUTO_UPDATE, BARNOWL_STATE_DIR,
       BARNOWL_QUEUE_TIMEOUT, BARNOWL_MAX_CONCURRENT, BARNOWL_MAX_QUEUE, BARNOWL_RATE_LIMIT,
       BARNOWL_GUARD, BARNOWL_GUARD_POLICY, BARNOWL_GUARD_MASK_CMD, BARNOWL_GUARD_UPSTREAM,
       BARNOWL_GUARD_LLM_URL, BARNOWL_GUARD_LLM_MODEL, BARNOWL_GUARD_LLM_KEY,
       BARNOWL_GUARD_LLM_TIMEOUT_MS, BARNOWL_GUARD_LLM_MAXCHARS, BARNOWL_GUARD_LLM_PROMPT
`);
  return 0;
}

// ── Dispatch ─────────────────────────────────────────────────────────────────
async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  initPaths(rest);
  switch (cmd) {
    case "start": return cmdStart(rest);
    case "stop": return cmdStop(rest);
    case "restart": return cmdRestart(rest);
    case "status": return cmdStatus(rest);
    case "verify": return cmdVerify(rest);
    case "models": return cmdModels();
    case "login": return cmdLogin(rest);
    case "config": {
      if (rest[0] === "init") {
        fs.mkdirSync(CONFIG_HOME, { recursive: true });
        const target = rest[1] ? path.resolve(rest[1]) : GLOBAL_CONFIG;
        if (fs.existsSync(target)) {
          console.error(`already exists: ${target}`);
          return 1;
        }
        const starter = {
          port: 11435,
          dir: os.homedir(),
          mcp: "none",
          queueTimeout: 300,
          maxConcurrent: 5,
          maxQueue: 50,
          rateLimit: 60,
          autoUpdate: true,
          paths: Object.fromEntries(Object.entries(detectPaths()).filter(([, v]) => v)),
        };
        fs.writeFileSync(target, JSON.stringify(starter, null, 2) + "\n");
        console.log(`created: ${target}`);
        console.log("paths were pre-filled by auto-detection — check them (README: Setup with an AI agent)");
        console.log("edit it, then just run: barnowl start");
        return 0;
      }
      const cfg = parseFlags(rest);
      console.log("Effective config (flags > env > file > defaults):");
      console.log(JSON.stringify(
        {
          port: cfg.port, dir: cfg.dir, mcp: cfg.mcp ?? null,
          queueTimeout: cfg.queueTimeout, maxConcurrent: cfg.maxConcurrent,
          maxQueue: cfg.maxQueue, rateLimit: cfg.rateLimit,
          apiKey: cfg.apiKey ? "(set)" : null,
          autoUpdate: cfg.autoUpdate,
          guard: cfg.guard.enabled
            ? {
                enabled: true, policy: cfg.guard.policy,
                maskCmd: cfg.guard.maskCmd || "(secret-guard default)",
                upstream: cfg.guard.upstream || "https://api.anthropic.com",
                llm: cfg.guard.llm.url ? { url: cfg.guard.llm.url, model: cfg.guard.llm.model || "qwen2.5:3b" } : null,
              }
            : { enabled: false },
          configFile: cfg.configFile,
          paths: (() => {
            const detected = detectPaths();
            return Object.fromEntries(PATH_KEYS.map(({ key }) => {
              const r = PATHS[key];
              const value = r.source === "auto" ? detected[key] : r.value;
              return [key, `${value ?? "(none)"}  [${r.source}]`];
            }));
          })(),
        }, null, 2));
      return 0;
    }
    case "version":
    case "--version":
    case "-v": console.log(PKG.version); return 0;
    case undefined:
    case "help":
    case "--help":
    case "-h": return cmdHelp();
    default:
      console.error(`Unknown command: ${cmd}. Run 'barnowl help'.`);
      return 1;
  }
}

main().then((code) => process.exit(code)).catch((err) => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
});
