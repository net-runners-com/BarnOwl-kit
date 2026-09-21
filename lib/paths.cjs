"use strict";
/**
 * Per-user paths. Binary locations and data dirs differ per machine; they can
 * be set in the config file's `paths` block (README: "Setup with an AI agent").
 * Each key maps to the env var the rest of barnowl (and the spawned server)
 * reads. Precedence: env var > config file > auto-detection.
 *
 * CLAUDE_CONFIG_DIR is deliberately not among them: Claude Code derives its
 * keychain item name from it, so setting it — even to the default — would make
 * the CLI look logged out.
 */
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const PATH_KEYS = [
  { key: "claudeBin", env: "BARNOWL_CLAUDE_BIN" },
  { key: "codexBin", env: "BARNOWL_CODEX_BIN" },
  { key: "python", env: "BARNOWL_PYTHON" },
  { key: "codexHome", env: "CODEX_HOME" },
  { key: "claudeKeychainAccount", env: "BARNOWL_CLAUDE_KEYCHAIN_ACCOUNT" },
  { key: "claudeCredentialsFile", env: "BARNOWL_CLAUDE_CREDENTIALS_FILE" },
  { key: "stateDir", env: "BARNOWL_STATE_DIR" },
];
const NOT_A_PATH = new Set(["claudeKeychainAccount"]);

function expandHome(p, home = os.homedir()) {
  return String(p).replace(/^~(?=$|[\\/])/, home);
}

/** Export file-provided paths to their env vars (an already-set env var wins). */
function applyPaths(filePaths, env = process.env, home = os.homedir()) {
  const fromFile = filePaths && typeof filePaths === "object" ? filePaths : {};
  const out = {};
  for (const { key, env: name } of PATH_KEYS) {
    if (env[name]) {
      out[key] = { value: env[name], source: "env" };
      continue;
    }
    const v = fromFile[key];
    if (v === undefined || v === null || v === "") {
      out[key] = { value: null, source: "auto" };
      continue;
    }
    const value = NOT_A_PATH.has(key) ? String(v) : expandHome(v, home);
    env[name] = value;
    out[key] = { value, source: "file" };
  }
  return out;
}

function which(bin) {
  const r = spawnSync(process.platform === "win32" ? "where" : "which", [bin], { encoding: "utf8" });
  if (r.status !== 0) return null;
  return String(r.stdout).split(/\r?\n/)[0].trim() || null;
}

/** What barnowl would use with no configuration (for `config init` / `config`). */
function detectPaths({ home = os.homedir(), platform = process.platform } = {}) {
  let username = null;
  try {
    username = os.userInfo().username;
  } catch (_) { /* no passwd entry */ }
  const codex = require("./codex-engine.cjs").CODEX_BIN;
  return {
    claudeBin: which("claude"),
    codexBin: path.isAbsolute(codex) ? codex : which(codex),
    python: which("python3"),
    codexHome: path.join(home, ".codex"),
    claudeKeychainAccount: platform === "darwin" ? username : null,
    claudeCredentialsFile: platform === "darwin" ? null : path.join(home, ".claude", ".credentials.json"),
    stateDir: path.join(home, ".barnowl"),
  };
}

module.exports = { PATH_KEYS, expandHome, applyPaths, detectPaths };
