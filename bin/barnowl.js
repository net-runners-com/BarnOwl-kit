#!/usr/bin/env node
/**
 * barnowl — a fast OpenAI-compatible local Claude server.
 *
 * Thin CLI around the `otterly` dependency. Bakes in the `--strict-mcp-config`
 * speed patch (see lib/patch-otterly.js) so each request returns in ~6s instead
 * of ~37s, at the cost of MCP tools (browser automation, etc.).
 *
 * Commands: start | stop | restart | status | verify | models | help
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const { ensurePatched } = require("../lib/patch-otterly.js");

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
};

const STATE_DIR = path.join(os.homedir(), ".barnowl");
const PID_FILE = path.join(STATE_DIR, "barnowl.pid");
const LOG_FILE = path.join(STATE_DIR, "barnowl.log");
const GLOBAL_CONFIG = path.join(STATE_DIR, "config.json");

// ── Small helpers ─────────────────────────────────────────────────────────
/** Find and parse the config file. Returns { path, data } or null. */
function loadConfigFile(explicitPath) {
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
    configFile: file ? file.path : null,
  };
  // "mcp": false / "none" in the file explicitly disables MCP even if env sets it
  if (out.mcp === "false" || out.mcp === "none") out.mcp = undefined;
  return out;
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

// ── Commands ────────────────────────────────────────────────────────────────
async function cmdStart(argv) {
  const cfg = parseFlags(argv);
  fs.mkdirSync(STATE_DIR, { recursive: true });
  if (cfg.configFile) console.log(`  Config   : ${cfg.configFile}`);
  // otterly reads OTTERLY_API_KEY for Bearer auth; forward barnowl's key to it.
  if (cfg.apiKey) process.env.OTTERLY_API_KEY = cfg.apiKey;

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
  try {
    const { status, json } = await httpJson(`${baseUrl(cfg.port)}/api/status`);
    console.log(`HTTP ${status}`);
    if (json) console.log(JSON.stringify(json, null, 2));
    return status === 200 ? 0 : 1;
  } catch (err) {
    console.error(`Not reachable on ${baseUrl(cfg.port)} (${err.message})`);
    return 1;
  }
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
  let models = [];
  try {
    models = require("../config/models.json").models || [];
  } catch (_) {}
  console.log("Recommended model names (aliases):");
  console.log("  sonnet   — everyday / coding (default)");
  console.log("  opus     — hardest reasoning");
  console.log("  haiku    — fastest / lightweight");
  console.log("  fable    — most capable (Claude 5 family)");
  if (models.length) {
    console.log("\nAll ids in config/models.json:");
    for (const m of models) console.log("  " + m.id + (m.label ? "  — " + m.label : ""));
  }
  return 0;
}

function cmdHelp() {
  console.log(`
  barnowl v${PKG.version} — fast OpenAI-compatible local Claude server

  Usage:
    barnowl start [-p <port>] [-d <dir>] [--mcp <profile>] [--config <file>]
    barnowl stop  [-p <port>]              Stop the server
    barnowl restart                        Restart
    barnowl status                         Health check (JSON)
    barnowl verify                         End-to-end check + latency
    barnowl models                         List usable model names
    barnowl config                         Show effective config + source
    barnowl config init [path]             Create a starter config file
    barnowl help | version

  Config file (flags > env > file > defaults):
    ./barnowl.config.json, or ~/.barnowl/config.json
    { "port": 11435, "dir": "...", "mcp": "sheet", ... }  ("mcp": "none" disables)

  Client setup:
    Base URL : http://localhost:11435/v1
    API key  : any string (auth disabled unless BARNOWL_API_KEY is set)
    Models   : sonnet | opus | haiku | fable

  Env: BARNOWL_PORT, BARNOWL_WORK_DIR, BARNOWL_API_KEY,
       BARNOWL_QUEUE_TIMEOUT, BARNOWL_MAX_CONCURRENT, BARNOWL_MAX_QUEUE, BARNOWL_RATE_LIMIT
`);
  return 0;
}

// ── Dispatch ─────────────────────────────────────────────────────────────────
async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case "start": return cmdStart(rest);
    case "stop": return cmdStop(rest);
    case "restart": return cmdRestart(rest);
    case "status": return cmdStatus(rest);
    case "verify": return cmdVerify(rest);
    case "models": return cmdModels();
    case "config": {
      if (rest[0] === "init") {
        fs.mkdirSync(STATE_DIR, { recursive: true });
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
        };
        fs.writeFileSync(target, JSON.stringify(starter, null, 2) + "\n");
        console.log(`created: ${target}`);
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
          configFile: cfg.configFile,
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
