"use strict";
/**
 * claude-oauth.cjs — keeps the local Claude Code login usable for the
 * /v1/messages passthrough (config "messages": { "oauth": true }).
 *
 * The store (keychain item "Claude Code-credentials", or
 * ~/.claude/.credentials.json) holds a short-lived access token — hours, not
 * days — next to a long-lived refresh token. Claude Code refreshes on its own
 * schedule; barnowl, which only reads the store, would answer 401 in between.
 * So this module performs the same refresh the CLI does. The endpoint, client
 * id and grant shape below are the CLI's own, read out of the installed
 * binary (claude 2.1.289):
 *
 *   POST https://platform.claude.com/v1/oauth/token   (application/json)
 *   { grant_type: "refresh_token", refresh_token, client_id, scope }
 *   → { access_token, refresh_token?, expires_in, refresh_token_expires_in? }
 *
 * The result is written back into the same store, merged into the existing
 * blob so unrelated fields (subscriptionType, rateLimitTier, …) survive. That
 * write-back is deliberate: the server may rotate the refresh token, and a
 * rotated token kept only in barnowl's memory would leave the store holding a
 * dead one — breaking Claude Code's own next refresh. The flip side is a race
 * with Claude Code writing the same item; last writer wins, and the loser's
 * token is simply re-refreshed on its next use.
 */
const fs = require("fs");
const path = require("path");
const catalog = require("./model-catalog.cjs");

const TOKEN_URL = process.env.BARNOWL_CLAUDE_TOKEN_URL || "https://platform.claude.com/v1/oauth/token";
const CLIENT_ID = process.env.BARNOWL_CLAUDE_CLIENT_ID || "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
// Refresh this far ahead of the deadline so an in-flight request cannot land
// on an expired token.
const SKEW_MS = 120_000;
const REFRESH_TIMEOUT_MS = Number(process.env.BARNOWL_CLAUDE_REFRESH_TIMEOUT_MS || 30_000);

// Snapshots of the credential store, kept under <state dir>/credentials-backup.
// Every write-back snapshots what it is about to overwrite: the refresh token
// rotates, so a botched write would otherwise leave no way back to a working
// login. Only the newest BACKUP_KEEP are kept — an older refresh token is dead
// weight once the server has rotated past it.
const BACKUP_KEEP = 5;

function backupDir(env = process.env) {
  return path.join(catalog.stateDir(env), "credentials-backup");
}

/** Write `raw` (the store's current contents) to a timestamped file, 0600,
 *  then prune to the newest `keep`. Returns the path, or null if nothing was
 *  written. Never throws: a failed snapshot must not fail the refresh. */
function snapshot(raw, { dir = backupDir(), keep = BACKUP_KEEP, stamp = new Date().toISOString() } = {}) {
  if (typeof raw !== "string" || !raw) return null;
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, `claude-${stamp.replace(/[:.]/g, "-")}.json`);
    fs.writeFileSync(file, raw, { mode: 0o600 });
    const kept = fs.readdirSync(dir).filter((f) => f.startsWith("claude-") && f.endsWith(".json")).sort();
    for (const stale of kept.slice(0, Math.max(0, kept.length - keep))) {
      try { fs.unlinkSync(path.join(dir, stale)); } catch (_) { /* already gone */ }
    }
    return file;
  } catch (_) {
    return null;
  }
}

/** Newest-last list of snapshots, with what each one holds (no secrets). */
function listBackups({ dir = backupDir() } = {}) {
  let names;
  try { names = fs.readdirSync(dir).filter((f) => f.startsWith("claude-") && f.endsWith(".json")).sort(); }
  catch (_) { return []; }
  return names.map((name) => {
    const file = path.join(dir, name);
    const out = { file, expiresAt: null, refreshTokenExpiresAt: null, hasRefreshToken: false };
    try {
      const o = JSON.parse(fs.readFileSync(file, "utf8")).claudeAiOauth || {};
      out.expiresAt = Number(o.expiresAt) || null;
      out.refreshTokenExpiresAt = Number(o.refreshTokenExpiresAt) || null;
      out.hasRefreshToken = !!o.refreshToken;
    } catch (_) { /* unreadable snapshot: still listed */ }
    return out;
  });
}

/** Snapshot the live store on demand (`barnowl creds backup`). */
function backupNow({ read = () => catalog.readClaudeCredential(), deps = {} } = {}) {
  // deps.backupDir (tests) overrides <state dir>/credentials-backup.
  const cred = read();
  if (!cred || !cred.store) {
    throw new OauthError("no Claude Code login in a file or the keychain to back up", "no_store");
  }
  const raw = catalog.readClaudeStore(cred.store, deps);
  const file = snapshot(raw, deps.backupDir ? { dir: deps.backupDir } : {});
  if (!file) throw new OauthError("could not write the snapshot", "backup_failed");
  return { file, store: cred.store };
}

/** Put a snapshot back into the store, snapshotting the live one first. */
function restore(file, { read = () => catalog.readClaudeCredential(), deps = {} } = {}) {
  const raw = fs.readFileSync(file, "utf8");
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (e) { throw new OauthError(`${file} is not JSON: ${e.message}`, "bad_snapshot"); }
  if (!parsed || !parsed.claudeAiOauth || !parsed.claudeAiOauth.accessToken) {
    throw new OauthError(`${file} holds no claudeAiOauth.accessToken`, "bad_snapshot");
  }
  const cred = read();
  const store = cred && cred.store
    ? cred.store
    : { kind: "keychain", account: process.env.BARNOWL_CLAUDE_KEYCHAIN_ACCOUNT || process.env.USER };
  const previous = snapshot(catalog.readClaudeStore(store, deps), deps.backupDir ? { dir: deps.backupDir } : {});
  if (!catalog.writeClaudeStore(store, raw, deps)) {
    throw new OauthError("could not write the credential store", "write_failed");
  }
  _reset();
  return { store, previous };
}

// Memory cache: the refreshed token (the store read is cheap but spawns
// `security`, and a single refresh must be shared by concurrent requests).
const state = { cred: null, inflight: null };

function _reset() {
  state.cred = null;
  state.inflight = null;
}

class OauthError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

function live(cred, now, skew = SKEW_MS) {
  return !!(cred && cred.token && (!cred.expiresAt || cred.expiresAt - skew > now));
}

/** One refresh round trip. Returns a credential shaped like the reader's. */
async function refresh(cred, { fetchImpl = fetch, now = () => Date.now() } = {}) {
  if (!cred || !cred.refreshToken) {
    throw new OauthError(
      cred && cred.source === "env"
        ? "CLAUDE_CODE_OAUTH_TOKEN has expired and carries no refresh token — set a fresh one"
        : "the Claude Code login has expired and holds no refresh token — run `claude` and log in again",
      "no_refresh_token");
  }
  if (cred.refreshTokenExpiresAt && cred.refreshTokenExpiresAt <= now()) {
    throw new OauthError("the Claude Code refresh token has expired — run `claude` and log in again", "refresh_expired");
  }
  let res;
  try {
    res = await fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: cred.refreshToken,
        client_id: CLIENT_ID,
        ...(cred.scopes && cred.scopes.length ? { scope: cred.scopes.join(" ") } : {}),
      }),
      signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
    });
  } catch (e) {
    throw new OauthError(`token refresh unreachable: ${e.message}`, "unreachable");
  }
  if (res.status !== 200) {
    let detail = "";
    try { detail = JSON.stringify(await res.json()).slice(0, 300); } catch (_) { /* no body */ }
    throw new OauthError(`token refresh failed (${res.status})${detail ? " " + detail : ""}`, "refused");
  }
  let data;
  try { data = await res.json(); }
  catch (e) { throw new OauthError(`token refresh returned non-JSON: ${e.message}`, "malformed"); }
  if (!data || !data.access_token || !data.expires_in) {
    throw new OauthError("token refresh response missing access_token or expires_in", "malformed");
  }
  return {
    token: data.access_token,
    expiresAt: now() + Number(data.expires_in) * 1000,
    refreshToken: data.refresh_token || cred.refreshToken,
    refreshTokenExpiresAt: data.refresh_token_expires_in
      ? now() + Number(data.refresh_token_expires_in) * 1000
      : cred.refreshTokenExpiresAt,
    scopes: cred.scopes,
    source: cred.source,
    store: cred.store,
    rotated: !!(data.refresh_token && data.refresh_token !== cred.refreshToken),
  };
}

/** Merge a refreshed credential back into the store it came from. Returns
 *  "written" | "skipped" (nothing to write to) | "failed". */
function persist(next, deps = {}) {
  if (!next.store) return "skipped";
  const raw = catalog.readClaudeStore(next.store, deps);
  snapshot(raw, deps.backupDir ? { dir: deps.backupDir } : {});
  let blob = null;
  try { blob = typeof raw === "string" ? JSON.parse(raw) : null; }
  catch (_) { /* unreadable store: write a fresh blob rather than give up */ }
  if (!blob || typeof blob !== "object" || Array.isArray(blob)) blob = {};
  const o = blob.claudeAiOauth && typeof blob.claudeAiOauth === "object" ? blob.claudeAiOauth : {};
  blob.claudeAiOauth = {
    ...o,
    accessToken: next.token,
    expiresAt: next.expiresAt,
    refreshToken: next.refreshToken,
    ...(next.refreshTokenExpiresAt ? { refreshTokenExpiresAt: next.refreshTokenExpiresAt } : {}),
  };
  return catalog.writeClaudeStore(next.store, JSON.stringify(blob), deps) ? "written" : "failed";
}

/**
 * The access token to send upstream, refreshed if the stored one is spent.
 * Throws OauthError when no usable login exists. Concurrent callers share one
 * refresh. Order: the store (Claude Code may have refreshed it already) → the
 * token this process refreshed earlier → a new refresh.
 */
async function accessToken({
  read = () => catalog.readClaudeCredential(),
  now = () => Date.now(),
  fetchImpl = fetch,
  log = () => {},
  persistImpl = persist,
  deps = {},
} = {}) {
  const stored = read();
  if (live(stored, now())) {
    state.cred = stored;
    return { token: stored.token, expiresAt: stored.expiresAt, refreshed: false };
  }
  if (live(state.cred, now())) {
    return { token: state.cred.token, expiresAt: state.cred.expiresAt, refreshed: false };
  }
  if (!stored && !state.cred) {
    throw new OauthError(
      "no Claude Code login found — run `claude` and log in, or set CLAUDE_CODE_OAUTH_TOKEN",
      "no_login");
  }
  if (!state.inflight) {
    const base = stored || state.cred;
    state.inflight = (async () => {
      const next = await refresh(base, { fetchImpl, now });
      state.cred = next;
      const wrote = persistImpl(next, deps);
      log(`refreshed the Claude Code token (store: ${wrote}${next.rotated ? ", refresh token rotated" : ""})`);
      return next;
    })().finally(() => { state.inflight = null; });
  }
  const next = await state.inflight;
  return { token: next.token, expiresAt: next.expiresAt, refreshed: true };
}

module.exports = {
  accessToken, refresh, persist, live, OauthError,
  snapshot, listBackups, backupNow, restore, backupDir,
  TOKEN_URL, CLIENT_ID, SKEW_MS, _reset,
};
