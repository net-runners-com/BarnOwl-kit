"use strict";
/**
 * Live model catalog: which models the current Claude / Codex logins can use,
 * and whether each login still works. `barnowl start` and `barnowl login`
 * refresh it into <state dir>/catalog.json; the server reads that file through
 * lib/auth-state.cjs.
 *
 * Provider status: ok · revoked · logged_out · unknown (network error or
 * unreadable credential — the previous model list is kept).
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

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

module.exports = {
  PROVIDERS, HIDDEN,
  stateDir, catalogPath, readCatalog, writeCatalog, markStatus,
  buildClaudeModels, buildCodexModels, summarize,
};
