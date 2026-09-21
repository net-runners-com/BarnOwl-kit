"use strict";
/**
 * Live model catalog: which models the current Claude / Codex logins can use,
 * and whether each login still works. `barnowl start` and `barnowl login`
 * refresh it into <state dir>/catalog.json; the server reads that file through
 * lib/auth-state.cjs.
 *
 * Provider status: ok · revoked · logged_out · unknown (network error or
 * unreadable credential — the previous model list is kept).
 *
 * Sources (verified 2026-09-21):
 *   Claude  GET https://api.anthropic.com/v1/models with the claude CLI's OAuth
 *           token: CLAUDE_CODE_OAUTH_TOKEN, else the macOS keychain item
 *           "Claude Code-credentials" for acct=<OS user>, else
 *           ~/.claude/.credentials.json. The keychain can also hold a stale
 *           acct="unknown" item whose token is revoked — never read that one.
 *   Codex   GET https://chatgpt.com/backend-api/codex/models with
 *           ~/.codex/auth.json (ChatGPT login).
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const { isAuthError } = require("./auth-errors.cjs");

const PROVIDERS = ["claude", "codex"];
const HIDDEN = new Set(["revoked", "logged_out"]);

// ── Catalog file ────────────────────────────────────────────────────────────
function stateDir(env = process.env) {
  return env.BARNOWL_STATE_DIR ? path.resolve(env.BARNOWL_STATE_DIR) : path.join(os.homedir(), ".barnowl");
}

function catalogPath(env = process.env) {
  return path.join(stateDir(env), "catalog.json");
}

function readCatalog(file = catalogPath()) {
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    return data && typeof data === "object" && data.providers && typeof data.providers === "object" ? data : null;
  } catch (_) {
    return null;
  }
}

/** Atomic write (tmp + rename) so a watching server never reads half a file. */
function writeCatalog(catalog, file = catalogPath()) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(catalog, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

/** Set one provider's status. Returns true when something changed. Never throws. */
function markStatus(provider, status, message = "", file = catalogPath(), now = Date.now()) {
  try {
    const catalog = readCatalog(file) || { version: 1, refreshedAt: null, providers: {} };
    const old = catalog.providers[provider] || {};
    if (old.status === status && (old.message || "") === message) return false;
    catalog.providers[provider] = { ...old, status, checkedAt: new Date(now).toISOString(), message };
    writeCatalog(catalog, file);
    return true;
  } catch (_) {
    return false;
  }
}

// ── Building the advertised lists ───────────────────────────────────────────
const CLAUDE_ALIASES = [
  { id: "sonnet", family: "sonnet", label: "Claude Sonnet (latest, default)" },
  { id: "opus", family: "opus", label: "Claude Opus (latest)" },
  { id: "haiku", family: "haiku", label: "Claude Haiku (latest, fastest)" },
  { id: "fable", family: "fable", label: "Claude Fable (latest)" },
];

/** Aliases first, then every API model (newest first) plus `[1m]` for 1M-capable ones. */
function buildClaudeModels(apiModels, deprecatedIds = []) {
  const live = (Array.isArray(apiModels) ? apiModels : [])
    .filter((m) => m && typeof m.id === "string" && !deprecatedIds.includes(m.id));
  if (!live.length) return [];
  const out = CLAUDE_ALIASES
    .filter((a) => live.some((m) => m.id.includes(a.family)))
    .map((a) => ({ id: a.id, label: a.label, contextWindow: 200000 }));
  out.push({ id: "default", label: "Claude Code default", contextWindow: 200000 });
  for (const m of live) {
    const max = Number(m.max_input_tokens) || 200000;
    const label = m.display_name || m.id;
    out.push({ id: m.id, label, contextWindow: Math.min(max, 200000) });
    if (max >= 1000000) out.push({ id: `${m.id}[1m]`, label: `${label} (1M context)`, contextWindow: 1000000 });
  }
  return out;
}

/** The `codex` alias, then the models the account lists (visibility "list"), by priority. */
function buildCodexModels(apiModels) {
  const listed = (Array.isArray(apiModels) ? apiModels : [])
    .filter((m) => m && typeof m.slug === "string" && m.visibility === "list")
    .sort((a, b) => (a.priority ?? 1e9) - (b.priority ?? 1e9));
  if (!listed.length) return [];
  const ctx = (m) => Number(m.context_window) || 272000;
  return [
    { id: "codex", label: "OpenAI Codex (Codex CLI default)", contextWindow: ctx(listed[0]) },
    ...listed.map((m) => ({ id: m.slug, label: `Codex ${m.display_name || m.slug}`, contextWindow: ctx(m) })),
  ];
}

/** Per-provider status line data; count null = the static list applies. */
function summarize(catalog) {
  const out = {};
  for (const p of PROVIDERS) {
    const e = catalog && catalog.providers && catalog.providers[p];
    if (!e) {
      out[p] = { status: "unknown", count: null, message: "", checkedAt: null };
      continue;
    }
    const models = Array.isArray(e.models) && e.models.length ? e.models : null;
    out[p] = {
      status: e.status,
      count: HIDDEN.has(e.status) ? 0 : models ? models.length : null,
      message: e.message || "",
      checkedAt: e.checkedAt || null,
    };
  }
  return out;
}

const CLAUDE_MODELS_URL = "https://api.anthropic.com/v1/models?limit=100";
const CODEX_MODELS_URL = "https://chatgpt.com/backend-api/codex/models";
const FETCH_TIMEOUT_MS = 5000;
const PROBE_TIMEOUT_MS = 30000;

// ── Credentials ─────────────────────────────────────────────────────────────
function safeUsername() {
  try {
    return os.userInfo().username;
  } catch (_) {
    return process.env.USER || null;
  }
}

function readKeychain(account) {
  const r = spawnSync("security", ["find-generic-password", "-s", "Claude Code-credentials", "-a", account, "-w"],
    { encoding: "utf8", timeout: 5000 });
  return r.status === 0 ? r.stdout.trim() : null;
}

function parseClaudeBlob(raw, source) {
  try {
    const o = JSON.parse(raw).claudeAiOauth;
    if (o && o.accessToken) return { token: o.accessToken, expiresAt: Number(o.expiresAt) || null, source };
  } catch (_) { /* unreadable */ }
  return null;
}

function readClaudeCredential({
  env = process.env, platform = process.platform,
  account = env.BARNOWL_CLAUDE_KEYCHAIN_ACCOUNT || safeUsername(), home = os.homedir(),
  keychain = readKeychain, readFile = (p) => fs.readFileSync(p, "utf8"),
} = {}) {
  if (env.CLAUDE_CODE_OAUTH_TOKEN) return { token: env.CLAUDE_CODE_OAUTH_TOKEN, expiresAt: null, source: "env" };
  if (platform === "darwin" && account) {
    const cred = parseClaudeBlob(keychain(account), "keychain");
    if (cred) return cred;
  }
  try {
    const file = env.BARNOWL_CLAUDE_CREDENTIALS_FILE
      || path.join(env.CLAUDE_CONFIG_DIR || path.join(home, ".claude"), ".credentials.json");
    return parseClaudeBlob(readFile(file), "file");
  } catch (_) {
    return null;
  }
}

function jwtExpiry(token) {
  try {
    const payload = JSON.parse(Buffer.from(String(token).split(".")[1], "base64url").toString("utf8"));
    return payload.exp ? payload.exp * 1000 : null;
  } catch (_) {
    return null;
  }
}

function codexHome(env = process.env) {
  return env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

function readCodexCredential({ home = codexHome(), readFile = (p) => fs.readFileSync(p, "utf8") } = {}) {
  try {
    const tokens = JSON.parse(readFile(path.join(home, "auth.json"))).tokens;
    if (!tokens || !tokens.access_token) return null;
    return { accessToken: tokens.access_token, accountId: tokens.account_id || null, expiresAt: jwtExpiry(tokens.access_token) };
  } catch (_) {
    return null;
  }
}

// ── Model-list APIs ─────────────────────────────────────────────────────────
async function fetchJson(url, headers, fetchImpl, timeoutMs) {
  const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  let body = null;
  try {
    body = await res.json();
  } catch (_) { /* non-JSON body */ }
  return { status: res.status, body };
}

function apiErrorMessage(body, status) {
  const e = body && body.error;
  return (e && (e.message || e.code)) || `HTTP ${status}`;
}

async function fetchClaudeModels(token, { fetchImpl = fetch, timeoutMs = FETCH_TIMEOUT_MS, deprecatedIds = [] } = {}) {
  try {
    const { status, body } = await fetchJson(CLAUDE_MODELS_URL, {
      Authorization: `Bearer ${token}`,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "oauth-2025-04-20",
    }, fetchImpl, timeoutMs);
    if (status === 200 && body && Array.isArray(body.data)) {
      return { status: "ok", message: "", models: buildClaudeModels(body.data, deprecatedIds) };
    }
    return { status: status === 401 ? "revoked" : "unknown", message: apiErrorMessage(body, status) };
  } catch (e) {
    return { status: "unknown", message: e.message };
  }
}

async function fetchCodexModels(cred, clientVersion, { fetchImpl = fetch, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  try {
    const headers = {
      Authorization: `Bearer ${cred.accessToken}`,
      originator: "codex_cli_rs",
      "User-Agent": `codex_cli_rs/${clientVersion}`,
    };
    if (cred.accountId) headers["chatgpt-account-id"] = cred.accountId;
    const url = `${CODEX_MODELS_URL}?client_version=${encodeURIComponent(clientVersion)}`;
    const { status, body } = await fetchJson(url, headers, fetchImpl, timeoutMs);
    if (status === 200 && body && Array.isArray(body.models)) {
      return { status: "ok", message: "", models: buildCodexModels(body.models) };
    }
    return { status: status === 401 ? "revoked" : "unknown", message: apiErrorMessage(body, status) };
  } catch (e) {
    return { status: "unknown", message: e.message };
  }
}

// ── CLI helpers ─────────────────────────────────────────────────────────────
/** Run a command without a shell (except on win32). Never rejects. */
function run(bin, args, { timeoutMs = 10000, cwd = os.tmpdir() } = {}) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer = null;
    const finish = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    let child;
    try {
      child = spawn(bin, args, { cwd, stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32" });
    } catch (e) {
      finish({ code: null, stdout, stderr, error: e });
      return;
    }
    timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch (_) {}
      finish({ code: null, stdout, stderr, error: new Error(`${bin} timed out after ${timeoutMs}ms`) });
    }, timeoutMs);
    child.stdout.on("data", (c) => { stdout += c; });
    child.stderr.on("data", (c) => { stderr += c; });
    child.on("error", (e) => finish({ code: null, stdout, stderr, error: e }));
    child.on("close", (code) => finish({ code, stdout, stderr, error: null }));
  });
}

function claudeBin(env = process.env) {
  return env.BARNOWL_CLAUDE_BIN || "claude";
}

function codexBin() {
  // Lazy: codex-engine → auth-state → model-catalog would otherwise be a cycle.
  return require("./codex-engine.cjs").CODEX_BIN;
}

function lastResultEvent(stdout) {
  let result = null;
  for (const line of String(stdout || "").split("\n")) {
    try {
      const ev = JSON.parse(line);
      if (ev && ev.type === "result") result = ev;
    } catch (_) { /* not JSON */ }
  }
  return result;
}

/**
 * One tiny `claude -p` (haiku). Used only when the stored access token has
 * expired: the CLI refreshes it as a side effect, and a revoked refresh token
 * surfaces here as a 401.
 */
async function probeClaude({ runImpl = run, bin = claudeBin() } = {}) {
  const empty = process.platform === "win32" ? '""' : "";
  const r = await runImpl(bin, [
    "-p", "Reply with exactly: ok", "--model", "haiku",
    "--output-format", "stream-json", "--verbose",
    "--strict-mcp-config", "--setting-sources", empty,
  ], { timeoutMs: PROBE_TIMEOUT_MS });
  const result = lastResultEvent(r.stdout);
  if (!result) return { status: "unknown", message: r.error ? r.error.message : "claude probe returned no result" };
  if (!result.is_error) return { status: "ok", message: "" };
  const msg = String(result.result || "claude probe failed");
  return { status: result.api_error_status === 401 || isAuthError(msg) ? "revoked" : "unknown", message: msg };
}

async function claudeLoggedIn({ runImpl = run, bin = claudeBin() } = {}) {
  const r = await runImpl(bin, ["auth", "status", "--json"], { timeoutMs: 10000 });
  try {
    return JSON.parse(r.stdout).loggedIn === true;
  } catch (_) {
    return null;
  }
}

async function codexLoggedIn({ runImpl = run, bin = codexBin() } = {}) {
  const r = await runImpl(bin, ["login", "status"], { timeoutMs: 10000 });
  if (r.error || r.code === null) return null;
  return r.code === 0;
}

async function codexClientVersion({ home = codexHome(), runImpl = run, bin = codexBin() } = {}) {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(home, "models_cache.json"), "utf8")).client_version;
    if (v) return String(v);
  } catch (_) { /* fall through to --version */ }
  const r = await runImpl(bin, ["--version"], { timeoutMs: 10000 });
  const m = /(\d+\.\d+\.\d+)/.exec(r.stdout || "");
  return m ? m[1] : "0.0.0";
}

// ── Refresh ─────────────────────────────────────────────────────────────────
async function refreshClaude(d) {
  let cred = d.readClaudeCredential();
  if (!cred) {
    return (await d.claudeLoggedIn()) === false
      ? { status: "logged_out", message: "not logged in to Claude" }
      : { status: "unknown", message: "Claude credential not readable" };
  }
  if (cred.expiresAt && cred.expiresAt <= d.now() + 60000) {
    const probe = await d.probeClaude();
    if (probe.status !== "ok") return probe;
    cred = d.readClaudeCredential();
    if (!cred) return { status: "unknown", message: "Claude credential not readable after refresh" };
  }
  return d.fetchClaudeModels(cred.token);
}

async function refreshCodex(d) {
  const cred = d.readCodexCredential();
  if (!cred) {
    return (await d.codexLoggedIn()) === false
      ? { status: "logged_out", message: "not logged in to Codex" }
      : { status: "unknown", message: "Codex credential not readable" };
  }
  if (cred.expiresAt && cred.expiresAt <= d.now()) {
    return { status: "unknown", message: "Codex token expired; the next Codex request refreshes it" };
  }
  return d.fetchCodexModels(cred, await d.codexClientVersion());
}

function loadDeprecatedIds() {
  try {
    return require("../config/models.json").deprecatedIds || [];
  } catch (_) {
    return [];
  }
}

function defaultDeps() {
  const deprecatedIds = loadDeprecatedIds();
  return {
    now: () => Date.now(),
    readClaudeCredential: () => readClaudeCredential(),
    readCodexCredential: () => readCodexCredential(),
    fetchClaudeModels: (token) => fetchClaudeModels(token, { deprecatedIds }),
    fetchCodexModels: (cred, version) => fetchCodexModels(cred, version),
    probeClaude: () => probeClaude(),
    claudeLoggedIn: () => claudeLoggedIn(),
    codexLoggedIn: () => codexLoggedIn(),
    codexClientVersion: () => codexClientVersion(),
  };
}

/** Refresh both providers in parallel and write the catalog. Never rejects. */
async function refreshCatalog({ file = catalogPath(), deps = {} } = {}) {
  const d = { ...defaultDeps(), ...deps };
  const prev = readCatalog(file);
  const safe = (fn) => fn(d).catch((e) => ({ status: "unknown", message: e.message }));
  const [claude, codex] = await Promise.all([safe(refreshClaude), safe(refreshCodex)]);
  const at = new Date(d.now()).toISOString();
  const entry = (provider, r) => {
    const old = (prev && prev.providers[provider]) || {};
    const out = { status: r.status, checkedAt: at, message: r.message || "" };
    const models = r.models || old.models;
    if (models) out.models = models;
    return out;
  };
  const catalog = { version: 1, refreshedAt: at, providers: { claude: entry("claude", claude), codex: entry("codex", codex) } };
  try {
    writeCatalog(catalog, file);
  } catch (e) {
    catalog.writeError = e.message;
  }
  return catalog;
}

module.exports = {
  PROVIDERS, HIDDEN,
  stateDir, catalogPath, readCatalog, writeCatalog, markStatus,
  buildClaudeModels, buildCodexModels, summarize,
  readClaudeCredential, readCodexCredential, jwtExpiry,
  fetchClaudeModels, fetchCodexModels,
  run, claudeBin, codexBin, probeClaude, claudeLoggedIn, codexLoggedIn, codexClientVersion,
  refreshCatalog,
};
