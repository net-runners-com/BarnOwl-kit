# Live Model Catalog + Auth-Revoke Handling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `barnowl start` refreshes `/v1/models` from the live Claude/Codex model APIs, and a revoked login yields HTTP 401 + hidden models + `barnowl login` recovery instead of a 200 whose content is the error text.

**Architecture:** Three new CommonJS modules. `lib/auth-errors.cjs` is pure classification. `lib/model-catalog.cjs` handles discovery and the catalog file; the CLI uses it. `lib/auth-state.cjs` is the server runtime: it binds otterly's `MODELS` array to the catalog and records auth failures/successes. `lib/paths.cjs` maps the config file's per-user `paths` block to env vars. New otterly text patches (same marker/anchor mechanism as today) load `auth-state` into `server/models.js` and `events.js`. The Codex engine, image gen and warm pool report through `auth-state`. The CLI gains the refresh on start, `login`, and the auth/status/model printouts.

**Tech Stack:** Node ≥ 18 (global `fetch`, `AbortSignal.timeout`), CommonJS, `node:test`, otterly 0.8.0 (ESM dist patched in place).

**Spec:** `docs/superpowers/specs/2026-09-21-live-models-auth-revoke-design.md`

## Global Constraints

- No new npm dependencies. `package.json` `engines.node` stays `>=18`.
- New modules are `.cjs` in `lib/`, loaded from otterly's ESM via `createRequire(import.meta.url)`. The path is `../../../../lib/…` from `dist/server/*.js` and `../../../lib/…` from `dist/*.js`.
- The catalog lives at `<state dir>/catalog.json`. State dir is `$BARNOWL_STATE_DIR`, else `~/.barnowl`. Never write inside the repo: a dirty tree blocks auto-update.
- Writes are atomic: tmp file + `rename`.
- Provider ids: `"claude"`, `"codex"`. Statuses: `"ok"`, `"revoked"`, `"logged_out"`, `"unknown"`. `revoked` / `logged_out` hide a provider's models.
- Auth message (exact): `` `${Name} authentication failed — the login was revoked or has expired. Run \`barnowl login ${provider}\` (no restart needed).` `` with Name `Claude` / `Codex`.
- Only HTTP 401 from a model-list API counts as `revoked`. Every other non-200 response is `unknown`.
- Patches must be idempotent (marker check) and must never edit a global otterly install.
- No desktop notifications.
- Per-user paths: env var > config `paths` > auto-detection. Never set `CLAUDE_CONFIG_DIR` (Claude Code derives its keychain item from it).
- Commit messages: imperative, as in `git log`. Every commit ends with `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.
- Run tests with `npm test` (`node --test test/*.test.js`).

## File Structure

| File | Responsibility |
| --- | --- |
| `lib/auth-errors.cjs` (new) | `isAuthError(text)`, `authMessage(p)`, `authError(p)`, `NAMES` |
| `lib/model-catalog.cjs` (new) | state dir / catalog file I/O, `markStatus`, list builders, credential readers, model-list fetchers, Claude probe, `refreshCatalog`, `summarize` |
| `lib/paths.cjs` (new) | per-user `paths` config → env vars, `~` expansion, auto-detection |
| `lib/auth-state.cjs` (new) | `bind(MODELS)`, `onAuthFailure`, `onAuthSuccess`, `statusOf`, `_reset` |
| `lib/patch-otterly.js` | new patches: engine.js (`BARNOWL_CLAUDE_BIN`), models.js (static list, DEFAULT_MODEL, live catalog), events.js (is_error, synthetic text), routes-openai.js (model fallback, breaker code, stream error type) |
| `lib/codex-engine.cjs`, `lib/image-gen.cjs`, `lib/warm-sessions.cjs` | report auth failure / success |
| `bin/barnowl.js` | state dir from `model-catalog`, refresh + summary on start, `login`, auth block in `status`, live `models`, help |
| `test/auth-errors.test.js`, `test/model-catalog.test.js`, `test/auth-state.test.js`, `test/patch-otterly.test.js`, `test/codex-auth.test.js`, `test/paths.test.js` (new) | tests |
| `README.md`, `README.ja.md` | usage, live list / revoked login docs, "Setup with an AI agent" |

---

### Task 1: Auth-error classification (`lib/auth-errors.cjs`)

**Files:**
- Create: `lib/auth-errors.cjs`
- Test: `test/auth-errors.test.js`

**Interfaces:**
- Produces: `isAuthError(text: string): boolean`, `authMessage(provider: "claude"|"codex"): string`, `authError(provider): Error & { barnowlCode: "NOT_AUTHENTICATED" }`, `NAMES: { claude: "Claude", codex: "Codex" }`

- [ ] **Step 1: Write the failing test** — `test/auth-errors.test.js`

```js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { isAuthError, authMessage, authError } = require("../lib/auth-errors.cjs");

// Real CLI output captured 2026-09-21 (claude with a bogus token, codex with a bogus auth.json).
const AUTH = [
  "Failed to authenticate. API Error: 401 OAuth access token is invalid.",
  "OAuth access token has been revoked.",
  "ERROR: Your access token could not be refreshed. Please log out and sign in again.",
  "failed to connect to websocket: HTTP error: 401 Unauthorized, url: wss://chatgpt.com/backend-api/codex/responses",
  "Could not validate your refresh token. Please try signing in again.",
  "Invalid API key · Please run /login",
  "Not logged in",
];
const NOT_AUTH = [
  "API Error: 429 rate_limit_error: Number of requests has exceeded your rate limit",
  "Credit balance is too low",
  "API Error: 529 overloaded_error",
  "Prompt is too long",
  "request id req_401abc failed",
];

test("isAuthError: recognises real Claude / Codex auth failures", () => {
  for (const s of AUTH) assert.equal(isAuthError(s), true, s);
});

test("isAuthError: other failures are not auth errors", () => {
  for (const s of NOT_AUTH) assert.equal(isAuthError(s), false, s);
  assert.equal(isAuthError(""), false);
  assert.equal(isAuthError(undefined), false);
});

test("authMessage names the provider and the fix", () => {
  assert.equal(
    authMessage("claude"),
    "Claude authentication failed — the login was revoked or has expired. Run `barnowl login claude` (no restart needed).",
  );
  assert.match(authMessage("codex"), /^Codex authentication failed .* `barnowl login codex`/);
});

test("authError carries the message and barnowlCode", () => {
  const e = authError("codex");
  assert.ok(e instanceof Error);
  assert.equal(e.message, authMessage("codex"));
  assert.equal(e.barnowlCode, "NOT_AUTHENTICATED");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/auth-errors.test.js`
Expected: FAIL — `Cannot find module '../lib/auth-errors.cjs'`

- [ ] **Step 3: Write the implementation** — `lib/auth-errors.cjs`

```js
"use strict";
/**
 * Recognise "the login is dead" in claude / codex CLI error output, and build
 * the single error barnowl answers with (HTTP 401 via otterly's
 * errorToHttpStatus, which keys on the word "authentication").
 *
 * Real strings this must catch (captured 2026-09-21):
 *   claude  "Failed to authenticate. API Error: 401 OAuth access token is invalid."
 *   claude  "OAuth access token has been revoked."
 *   codex   "ERROR: Your access token could not be refreshed. Please log out and sign in again."
 *   codex   "failed to connect to websocket: HTTP error: 401 Unauthorized"
 */
const AUTH_PATTERNS = [
  /\b401\b/,
  /authenticat/i,
  /\boauth\b[^\n]*\b(revoked|invalid|expired)\b/i,
  /unauthori[sz]ed/i,
  /refresh token/i,
  /\b(sign|log)(g?ing)? ?in again\b/i,
  /please run \/login/i,
  /not logged in/i,
];

const NAMES = { claude: "Claude", codex: "Codex" };

function isAuthError(text) {
  const s = String(text || "");
  return AUTH_PATTERNS.some((re) => re.test(s));
}

function authMessage(provider) {
  const name = NAMES[provider] || provider;
  return `${name} authentication failed — the login was revoked or has expired. ` +
    `Run \`barnowl login ${provider}\` (no restart needed).`;
}

/** Error for non-otterly engines; routes read barnowlCode for the circuit breaker. */
function authError(provider) {
  const err = new Error(authMessage(provider));
  err.barnowlCode = "NOT_AUTHENTICATED";
  return err;
}

module.exports = { isAuthError, authMessage, authError, NAMES };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/auth-errors.test.js`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add lib/auth-errors.cjs test/auth-errors.test.js
git commit -m "Add auth-error classification for claude / codex CLI output

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Catalog file + list builders (`lib/model-catalog.cjs`, part 1)

**Files:**
- Create: `lib/model-catalog.cjs`
- Test: `test/model-catalog.test.js`

**Interfaces:**
- Consumes: nothing yet (Task 3 adds the `auth-errors` import)
- Produces:
  - `PROVIDERS = ["claude", "codex"]`, `HIDDEN: Set<"revoked"|"logged_out">`
  - `stateDir(env?) → string`, `catalogPath(env?) → string`
  - `readCatalog(file?) → Catalog | null`, `writeCatalog(catalog, file?) → void` (throws on I/O error)
  - `markStatus(provider, status, message = "", file?, now = Date.now()) → boolean` (true when status/message changed; never throws)
  - `buildClaudeModels(apiModels, deprecatedIds = []) → Model[]`, `buildCodexModels(apiModels) → Model[]`
  - `summarize(catalog) → { claude: Summary, codex: Summary }`, where `Summary = { status, count: number|null, message, checkedAt }`. `count` is `null` when the static list applies
  - Types: `Model = { id, label, contextWindow }`. `Catalog = { version: 1, refreshedAt, providers: { [p]: { status, checkedAt, message, models? } } }`

- [ ] **Step 1: Write the failing test** — `test/model-catalog.test.js`

```js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const mc = require("../lib/model-catalog.cjs");

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "barnowl-catalog-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const ids = (models) => models.map((m) => m.id);

// Trimmed from the live model-list answers on 2026-09-21.
const CLAUDE_API = [
  { id: "claude-fable-5-1", display_name: "Claude Fable 5.1", max_input_tokens: 200000 },
  { id: "claude-opus-5", display_name: "Claude Opus 5", max_input_tokens: 1000000 },
  { id: "claude-sonnet-5", display_name: "Claude Sonnet 5", max_input_tokens: 1000000 },
  { id: "claude-fable-5", display_name: "Claude Fable 5", max_input_tokens: 200000 },
  { id: "claude-haiku-4-5-20251001", display_name: "Claude Haiku 4.5", max_input_tokens: 200000 },
];
const CODEX_API = [
  { slug: "gpt-reserve", display_name: "GPT-Reserve", visibility: "hide", priority: 3, context_window: 272000 },
  { slug: "gpt-5.5", display_name: "GPT-5.5", visibility: "list", priority: 12, context_window: 272000 },
  { slug: "gpt-5.6-terra", display_name: "GPT-5.6-Terra", visibility: "list", priority: 7, context_window: 272000 },
  { slug: "gpt-5.6-luna", display_name: "GPT-5.6-Luna", visibility: "list", priority: 8, context_window: 272000 },
];

test("buildClaudeModels: aliases, API order, deprecated removed, [1m] variants", () => {
  const models = mc.buildClaudeModels(CLAUDE_API, ["claude-fable-5"]);
  assert.deepEqual(ids(models), [
    "sonnet", "opus", "haiku", "fable", "default",
    "claude-fable-5-1",
    "claude-opus-5", "claude-opus-5[1m]",
    "claude-sonnet-5", "claude-sonnet-5[1m]",
    "claude-haiku-4-5-20251001",
  ]);
  const byId = Object.fromEntries(models.map((m) => [m.id, m]));
  assert.equal(byId["claude-opus-5"].contextWindow, 200000);
  assert.equal(byId["claude-opus-5[1m]"].contextWindow, 1000000);
  assert.equal(byId["claude-opus-5[1m]"].label, "Claude Opus 5 (1M context)");
  assert.equal(byId["claude-fable-5-1"].label, "Claude Fable 5.1");
});

test("buildClaudeModels: an alias needs its family in the list; empty input → []", () => {
  const models = mc.buildClaudeModels([{ id: "claude-sonnet-5", display_name: "Claude Sonnet 5", max_input_tokens: 1000000 }]);
  assert.deepEqual(ids(models), ["sonnet", "default", "claude-sonnet-5", "claude-sonnet-5[1m]"]);
  assert.deepEqual(mc.buildClaudeModels([]), []);
  assert.deepEqual(mc.buildClaudeModels(undefined), []);
});

test("buildCodexModels: listed models by priority behind a codex alias", () => {
  const models = mc.buildCodexModels(CODEX_API);
  assert.deepEqual(ids(models), ["codex", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5"]);
  assert.equal(models[1].label, "Codex GPT-5.6-Terra");
  assert.equal(models[0].contextWindow, 272000);
  assert.deepEqual(mc.buildCodexModels([]), []);
});

test("catalog path follows BARNOWL_STATE_DIR", () => {
  assert.equal(mc.catalogPath({ BARNOWL_STATE_DIR: "/tmp/x" }), path.resolve("/tmp/x/catalog.json"));
  assert.equal(mc.catalogPath({}), path.join(os.homedir(), ".barnowl", "catalog.json"));
});

test("writeCatalog/readCatalog round-trip atomically", (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, "nested", "catalog.json");
  const cat = { version: 1, refreshedAt: "x", providers: { claude: { status: "ok", checkedAt: "x", message: "" } } };
  mc.writeCatalog(cat, file);
  assert.deepEqual(mc.readCatalog(file), cat);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ["catalog.json"]); // no tmp file left behind
});

test("readCatalog: missing or invalid file → null", (t) => {
  const dir = tmpDir(t);
  assert.equal(mc.readCatalog(path.join(dir, "none.json")), null);
  fs.writeFileSync(path.join(dir, "bad.json"), "{nope");
  assert.equal(mc.readCatalog(path.join(dir, "bad.json")), null);
});

test("markStatus creates the file, reports changes only, keeps models", (t) => {
  const file = path.join(tmpDir(t), "catalog.json");
  assert.equal(mc.markStatus("claude", "revoked", "401", file, 0), true);
  assert.equal(mc.readCatalog(file).providers.claude.status, "revoked");
  assert.equal(mc.markStatus("claude", "revoked", "401", file, 1), false);
  const cat = mc.readCatalog(file);
  cat.providers.claude.models = [{ id: "sonnet", label: "S", contextWindow: 200000 }];
  mc.writeCatalog(cat, file);
  assert.equal(mc.markStatus("claude", "ok", "", file, 2), true);
  const after = mc.readCatalog(file).providers.claude;
  assert.equal(after.status, "ok");
  assert.deepEqual(ids(after.models), ["sonnet"]);
  assert.equal(after.checkedAt, new Date(2).toISOString());
});

test("summarize: counts visible models; hidden → 0; no models → null", () => {
  const s = mc.summarize({
    version: 1,
    providers: {
      claude: { status: "revoked", message: "401", checkedAt: "t", models: [{ id: "a" }] },
      codex: { status: "ok", message: "", checkedAt: "t" },
    },
  });
  assert.deepEqual(s.claude, { status: "revoked", count: 0, message: "401", checkedAt: "t" });
  assert.deepEqual(s.codex, { status: "ok", count: null, message: "", checkedAt: "t" });
  assert.equal(mc.summarize(null).claude.status, "unknown");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/model-catalog.test.js`
Expected: FAIL — `Cannot find module '../lib/model-catalog.cjs'`

- [ ] **Step 3: Write the implementation** — `lib/model-catalog.cjs`

```js
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/model-catalog.test.js`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add lib/model-catalog.cjs test/model-catalog.test.js
git commit -m "Add model catalog file and live list builders

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Discovery — credentials, fetchers, probe, refresh (`lib/model-catalog.cjs`, part 2)

**Files:**
- Modify: `lib/model-catalog.cjs` (append; extend `module.exports`)
- Test: `test/model-catalog.test.js` (append)

**Interfaces:**
- Consumes: `isAuthError` from `lib/auth-errors.cjs` (Task 1). Catalog helpers from Task 2.
- Produces:
  - `readClaudeCredential(opts?) → { token, expiresAt: number|null, source: "env"|"keychain"|"file" } | null`. `opts`: `{ env, platform, account, home, keychain(account) → string|null, readFile(p) → string }`. `account` defaults to `$BARNOWL_CLAUDE_KEYCHAIN_ACCOUNT` or the OS user; the file to `$BARNOWL_CLAUDE_CREDENTIALS_FILE` or `~/.claude/.credentials.json`
  - `readCodexCredential(opts?) → { accessToken, accountId, expiresAt: number|null } | null`. `opts`: `{ home, readFile }`
  - `jwtExpiry(token) → number|null` (ms)
  - `fetchClaudeModels(token, { fetchImpl, timeoutMs, deprecatedIds }?) → Promise<Result>`
  - `fetchCodexModels(cred, clientVersion, { fetchImpl, timeoutMs }?) → Promise<Result>`
  - `probeClaude({ runImpl, bin }?) → Promise<{ status, message }>`
  - `claudeLoggedIn({ runImpl, bin }?) → Promise<boolean|null>`, `codexLoggedIn({ runImpl, bin }?) → Promise<boolean|null>`
  - `codexClientVersion({ home, runImpl, bin }?) → Promise<string>`
  - `refreshCatalog({ file, deps }?) → Promise<Catalog>`. On a failed write the returned catalog carries `writeError`
  - `run(bin, args, { timeoutMs, cwd }?) → Promise<{ code: number|null, stdout, stderr, error: Error|null }>`
  - `claudeBin(env?) → string` (`$BARNOWL_CLAUDE_BIN` or `"claude"`), `codexBin() → string` (codex-engine's `CODEX_BIN`, required lazily)
  - `Result = { status: "ok"|"revoked"|"unknown", message: string, models?: Model[] }`
  - `deps` keys for `refreshCatalog`: `now()`, `readClaudeCredential()`, `readCodexCredential()`, `fetchClaudeModels(token)`, `fetchCodexModels(cred, version)`, `probeClaude()`, `claudeLoggedIn()`, `codexLoggedIn()`, `codexClientVersion()`

- [ ] **Step 1: Append the failing tests** to `test/model-catalog.test.js`

```js
// ── Discovery ────────────────────────────────────────────────────────────────
const jwt = (exp) => `h.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.s`;
const fakeFetch = (status, body, seen = []) => async (url, opts) => {
  seen.push({ url, headers: opts.headers });
  return { status, json: async () => body };
};

test("readClaudeCredential: env token wins without touching the keychain", () => {
  let asked = false;
  const cred = mc.readClaudeCredential({
    env: { CLAUDE_CODE_OAUTH_TOKEN: "sk-env" }, platform: "darwin", account: "alice",
    keychain: () => { asked = true; return null; },
  });
  assert.deepEqual(cred, { token: "sk-env", expiresAt: null, source: "env" });
  assert.equal(asked, false);
});

test("readClaudeCredential: keychain entry for the OS user, then the file fallback", () => {
  const blob = (token) => JSON.stringify({ claudeAiOauth: { accessToken: token, expiresAt: 123 } });
  let account;
  const fromKeychain = mc.readClaudeCredential({
    env: {}, platform: "darwin", account: "alice", home: "/h",
    keychain: (a) => { account = a; return blob("kc"); },
    readFile: () => { throw new Error("not used"); },
  });
  assert.equal(account, "alice");
  assert.deepEqual(fromKeychain, { token: "kc", expiresAt: 123, source: "keychain" });

  let read;
  const fromFile = mc.readClaudeCredential({
    env: {}, platform: "linux", account: "alice", home: "/h",
    keychain: () => { throw new Error("keychain is macOS-only"); },
    readFile: (p) => { read = p; return blob("file"); },
  });
  assert.equal(read, path.join("/h", ".claude", ".credentials.json"));
  assert.equal(fromFile.source, "file");

  assert.equal(mc.readClaudeCredential({
    env: {}, platform: "darwin", account: "alice", home: "/h",
    keychain: () => null, readFile: () => { throw new Error("ENOENT"); },
  }), null);
});

test("readClaudeCredential: keychain account / credentials file overridable (config paths)", () => {
  const blob = JSON.stringify({ claudeAiOauth: { accessToken: "x", expiresAt: 1 } });
  let account;
  let read;
  mc.readClaudeCredential({ env: { BARNOWL_CLAUDE_KEYCHAIN_ACCOUNT: "bob" }, platform: "darwin", home: "/h",
    keychain: (a) => { account = a; return blob; } });
  assert.equal(account, "bob");
  mc.readClaudeCredential({ env: { BARNOWL_CLAUDE_CREDENTIALS_FILE: "/etc/creds.json" }, platform: "linux", home: "/h",
    readFile: (p) => { read = p; return blob; } });
  assert.equal(read, "/etc/creds.json");
});

test("readCodexCredential: tokens + JWT expiry; missing → null", () => {
  const auth = JSON.stringify({ tokens: { access_token: jwt(2000), account_id: "acc" } });
  assert.deepEqual(mc.readCodexCredential({ home: "/c", readFile: () => auth }),
    { accessToken: jwt(2000), accountId: "acc", expiresAt: 2000 * 1000 });
  assert.equal(mc.readCodexCredential({ home: "/c", readFile: () => "{}" }), null);
  assert.equal(mc.readCodexCredential({ home: "/c", readFile: () => { throw new Error("ENOENT"); } }), null);
});

test("fetchClaudeModels: 200 ok (OAuth headers), 401 revoked, 500 / throw unknown", async () => {
  const seen = [];
  const ok = await mc.fetchClaudeModels("tok", { fetchImpl: fakeFetch(200, { data: CLAUDE_API }, seen), deprecatedIds: ["claude-fable-5"] });
  assert.equal(ok.status, "ok");
  assert.ok(ids(ok.models).includes("claude-opus-5[1m]"));
  assert.equal(seen[0].headers.Authorization, "Bearer tok");
  assert.equal(seen[0].headers["anthropic-beta"], "oauth-2025-04-20");

  const revoked = await mc.fetchClaudeModels("tok", {
    fetchImpl: fakeFetch(401, { error: { type: "authentication_error", message: "OAuth access token has been revoked." } }),
  });
  assert.deepEqual(revoked, { status: "revoked", message: "OAuth access token has been revoked." });

  assert.equal((await mc.fetchClaudeModels("tok", { fetchImpl: fakeFetch(500, null) })).status, "unknown");
  const offline = await mc.fetchClaudeModels("tok", { fetchImpl: async () => { throw new Error("fetch failed"); } });
  assert.deepEqual(offline, { status: "unknown", message: "fetch failed" });
});

test("fetchCodexModels: account header + client_version; 401 revoked", async () => {
  const seen = [];
  const ok = await mc.fetchCodexModels({ accessToken: "a", accountId: "acc" }, "0.155.0",
    { fetchImpl: fakeFetch(200, { models: CODEX_API }, seen) });
  assert.equal(ok.status, "ok");
  assert.deepEqual(ids(ok.models), ["codex", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5"]);
  assert.match(seen[0].url, /client_version=0\.155\.0$/);
  assert.equal(seen[0].headers["chatgpt-account-id"], "acc");
  const revoked = await mc.fetchCodexModels({ accessToken: "a", accountId: "acc" }, "0.155.0",
    { fetchImpl: fakeFetch(401, { error: { message: "Could not parse your authentication token." } }) });
  assert.equal(revoked.status, "revoked");
});

test("probeClaude: classifies the CLI's final result event", async () => {
  const runWith = (lines) => async () => ({ code: 0, stdout: lines.map((l) => JSON.stringify(l)).join("\n"), stderr: "", error: null });
  assert.equal((await mc.probeClaude({ runImpl: runWith([{ type: "result", subtype: "success", is_error: false, result: "ok" }]) })).status, "ok");
  const revoked = await mc.probeClaude({ runImpl: runWith([
    { type: "system", subtype: "api_retry", error_status: 401 },
    { type: "result", subtype: "success", is_error: true, api_error_status: 401, result: "Failed to authenticate. API Error: 401 OAuth access token is invalid." },
  ]) });
  assert.equal(revoked.status, "revoked");
  const none = await mc.probeClaude({ runImpl: async () => ({ code: null, stdout: "", stderr: "", error: new Error("spawn claude ENOENT") }) });
  assert.deepEqual(none, { status: "unknown", message: "spawn claude ENOENT" });
});

function deps(over = {}) {
  const calls = { probe: 0, claudeFetch: [], codexFetch: 0 };
  const d = {
    now: () => 1_000_000,
    readClaudeCredential: () => ({ token: "tok", expiresAt: null, source: "env" }),
    readCodexCredential: () => ({ accessToken: "a", accountId: "acc", expiresAt: null }),
    fetchClaudeModels: async (token) => {
      calls.claudeFetch.push(token);
      return { status: "ok", message: "", models: [{ id: "sonnet", label: "S", contextWindow: 200000 }] };
    },
    fetchCodexModels: async () => {
      calls.codexFetch++;
      return { status: "ok", message: "", models: [{ id: "codex", label: "C", contextWindow: 272000 }] };
    },
    probeClaude: async () => { calls.probe++; return { status: "ok", message: "" }; },
    claudeLoggedIn: async () => true,
    codexLoggedIn: async () => true,
    codexClientVersion: async () => "0.155.0",
    ...over,
  };
  return { d, calls };
}
const PREV = {
  version: 1, refreshedAt: "old",
  providers: {
    claude: { status: "ok", checkedAt: "old", message: "", models: [{ id: "old-claude", label: "O", contextWindow: 200000 }] },
    codex: { status: "ok", checkedAt: "old", message: "", models: [{ id: "old-codex", label: "O", contextWindow: 272000 }] },
  },
};

test("refreshCatalog: both ok → written with fresh models", async (t) => {
  const file = path.join(tmpDir(t), "catalog.json");
  const { d } = deps();
  const cat = await mc.refreshCatalog({ file, deps: d });
  assert.equal(cat.providers.claude.status, "ok");
  assert.deepEqual(ids(cat.providers.codex.models), ["codex"]);
  assert.equal(cat.refreshedAt, new Date(1_000_000).toISOString());
  assert.deepEqual(mc.readCatalog(file), cat);
});

test("refreshCatalog: expired Claude token → probe, re-read, fetch with the new token", async (t) => {
  const file = path.join(tmpDir(t), "catalog.json");
  let reads = 0;
  const { d, calls } = deps({
    readClaudeCredential: () => (++reads === 1
      ? { token: "stale", expiresAt: 1_000_000, source: "keychain" }
      : { token: "fresh", expiresAt: 9_000_000, source: "keychain" }),
  });
  const cat = await mc.refreshCatalog({ file, deps: d });
  assert.equal(calls.probe, 1);
  assert.deepEqual(calls.claudeFetch, ["fresh"]);
  assert.equal(cat.providers.claude.status, "ok");
});

test("refreshCatalog: probe says revoked → revoked, no fetch, last models kept", async (t) => {
  const file = path.join(tmpDir(t), "catalog.json");
  mc.writeCatalog(PREV, file);
  const { d, calls } = deps({
    readClaudeCredential: () => ({ token: "stale", expiresAt: 1, source: "keychain" }),
    probeClaude: async () => ({ status: "revoked", message: "401" }),
  });
  const cat = await mc.refreshCatalog({ file, deps: d });
  assert.equal(cat.providers.claude.status, "revoked");
  assert.deepEqual(calls.claudeFetch, []);
  assert.deepEqual(ids(cat.providers.claude.models), ["old-claude"]);
});

test("refreshCatalog: network failure keeps the previous models as unknown", async (t) => {
  const file = path.join(tmpDir(t), "catalog.json");
  mc.writeCatalog(PREV, file);
  const { d } = deps({ fetchCodexModels: async () => ({ status: "unknown", message: "fetch failed" }) });
  const cat = await mc.refreshCatalog({ file, deps: d });
  assert.equal(cat.providers.codex.status, "unknown");
  assert.equal(cat.providers.codex.message, "fetch failed");
  assert.deepEqual(ids(cat.providers.codex.models), ["old-codex"]);
});

test("refreshCatalog: no credential → logged_out only when the CLI confirms it", async (t) => {
  const file = path.join(tmpDir(t), "catalog.json");
  const out = await mc.refreshCatalog({ file, deps: deps({
    readClaudeCredential: () => null, claudeLoggedIn: async () => false,
    readCodexCredential: () => null, codexLoggedIn: async () => null,
  }).d });
  assert.equal(out.providers.claude.status, "logged_out");
  assert.equal(out.providers.codex.status, "unknown");
});

test("refreshCatalog: expired Codex token → unknown without fetching", async (t) => {
  const file = path.join(tmpDir(t), "catalog.json");
  const { d, calls } = deps({ readCodexCredential: () => ({ accessToken: "a", accountId: "acc", expiresAt: 999_999 }) });
  const cat = await mc.refreshCatalog({ file, deps: d });
  assert.equal(cat.providers.codex.status, "unknown");
  assert.equal(calls.codexFetch, 0);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/model-catalog.test.js`
Expected: FAIL — `mc.readClaudeCredential is not a function` (and similar)

- [ ] **Step 3: Implement** — in `lib/model-catalog.cjs` add the requires at the top, below the existing ones:

```js
const { spawn, spawnSync } = require("child_process");
const { isAuthError } = require("./auth-errors.cjs");
```

Extend the header comment with the sources block:

```js
 * Sources (verified 2026-09-21):
 *   Claude  GET https://api.anthropic.com/v1/models with the claude CLI's OAuth
 *           token: CLAUDE_CODE_OAUTH_TOKEN, else the macOS keychain item
 *           "Claude Code-credentials" for acct=<OS user>, else
 *           ~/.claude/.credentials.json. The keychain can also hold a stale
 *           acct="unknown" item whose token is revoked — never read that one.
 *   Codex   GET https://chatgpt.com/backend-api/codex/models with
 *           ~/.codex/auth.json (ChatGPT login).
```

Append, above `module.exports`:

```js
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
```

Replace `module.exports` with:

```js
module.exports = {
  PROVIDERS, HIDDEN,
  stateDir, catalogPath, readCatalog, writeCatalog, markStatus,
  buildClaudeModels, buildCodexModels, summarize,
  readClaudeCredential, readCodexCredential, jwtExpiry,
  fetchClaudeModels, fetchCodexModels,
  run, claudeBin, codexBin, probeClaude, claudeLoggedIn, codexLoggedIn, codexClientVersion,
  refreshCatalog,
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/model-catalog.test.js`
Expected: PASS (21 tests)

- [ ] **Step 5: Smoke-test against the live APIs** (scratch state dir, real logins)

Run:
```bash
S=$(mktemp -d) && BARNOWL_STATE_DIR=$S node -e '
const mc = require("./lib/model-catalog.cjs");
mc.refreshCatalog().then((c) => { console.log(JSON.stringify(mc.summarize(c)));
  for (const p of mc.PROVIDERS) console.log(p, (c.providers[p].models || []).map((m) => m.id).join(" ")); });'
```
Expected: `claude` and `codex` both `"status":"ok"` with non-null counts. The Claude ids include `sonnet` and `claude-opus-5[1m]`, not `claude-fable-5`. The Codex ids are `codex gpt-5.6-terra gpt-5.6-luna gpt-5.5`. If Codex answers anything but 200, drop the `originator` / `User-Agent` headers one at a time and re-run. Record the outcome in the task report.

- [ ] **Step 6: Commit**

```bash
git add lib/model-catalog.cjs test/model-catalog.test.js
git commit -m "Model catalog: read CLI logins, fetch live model lists, refresh on demand

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Server runtime state (`lib/auth-state.cjs`)

**Files:**
- Create: `lib/auth-state.cjs`
- Test: `test/auth-state.test.js`

**Interfaces:**
- Consumes: `catalogPath`, `readCatalog`, `markStatus`, `PROVIDERS`, `HIDDEN` (Task 2). `isCodexModel` from `lib/codex-engine.cjs` (existing, required lazily).
- Produces:
  - `bind(models: Model[], { file = catalogPath(), watch = true }?) → Model[]`. Mutates `models` in place and re-applies on file change (`fs.watchFile`, 2 s, non-persistent)
  - `onAuthFailure(provider, message) → boolean`, `onAuthSuccess(provider) → boolean`. Both return true when they wrote a transition
  - `statusOf(provider) → string | null`
  - `_reset()` (tests)

- [ ] **Step 1: Write the failing test** — `test/auth-state.test.js`

```js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const STATE = fs.mkdtempSync(path.join(os.tmpdir(), "barnowl-authstate-"));
process.env.BARNOWL_STATE_DIR = STATE;
const auth = require("../lib/auth-state.cjs");
const { writeCatalog, readCatalog, catalogPath } = require("../lib/model-catalog.cjs");

const FILE = catalogPath();
const ids = (models) => models.map((m) => m.id);
const STATIC = () => [
  { id: "sonnet", label: "s", contextWindow: 200000 },
  { id: "claude-opus-5", label: "o", contextWindow: 200000 },
  { id: "codex", label: "c", contextWindow: 272000 },
  { id: "gpt-5.5", label: "g", contextWindow: 272000 },
];
const cat = (providers) => ({ version: 1, refreshedAt: "t", providers });
const m = (id) => ({ id, label: id, contextWindow: 1 });

test.beforeEach(() => {
  auth._reset();
  fs.rmSync(FILE, { force: true });
});
test.after(() => fs.rmSync(STATE, { recursive: true, force: true }));

test("no catalog file: MODELS untouched", () => {
  const models = STATIC();
  auth.bind(models, { watch: false });
  assert.deepEqual(ids(models), ["sonnet", "claude-opus-5", "codex", "gpt-5.5"]);
});

test("catalog lists replace MODELS in place (same array)", () => {
  writeCatalog(cat({
    claude: { status: "ok", models: [m("sonnet"), m("claude-fable-5-1")] },
    codex: { status: "ok", models: [m("codex"), m("gpt-5.6-terra")] },
  }), FILE);
  const models = STATIC();
  const same = models;
  auth.bind(models, { watch: false });
  assert.equal(models, same);
  assert.deepEqual(ids(models), ["sonnet", "claude-fable-5-1", "codex", "gpt-5.6-terra"]);
});

test("revoked / logged_out hide a provider; absent or model-less keeps static entries", () => {
  writeCatalog(cat({ claude: { status: "revoked", models: [m("sonnet")] } }), FILE);
  let models = STATIC();
  auth.bind(models, { watch: false });
  assert.deepEqual(ids(models), ["codex", "gpt-5.5"]);

  auth._reset();
  writeCatalog(cat({ claude: { status: "ok" }, codex: { status: "logged_out" } }), FILE);
  models = STATIC();
  auth.bind(models, { watch: false });
  assert.deepEqual(ids(models), ["sonnet", "claude-opus-5"]);
});

test("onAuthFailure hides the provider and writes only on the transition", () => {
  const models = STATIC();
  auth.bind(models, { watch: false });
  assert.equal(auth.onAuthFailure("claude", "401 revoked"), true);
  assert.deepEqual(ids(models), ["codex", "gpt-5.5"]);
  assert.equal(auth.statusOf("claude"), "revoked");
  assert.equal(auth.onAuthFailure("claude", "401 again"), false);
  assert.equal(readCatalog(FILE).providers.claude.message, "401 revoked");
});

test("onAuthSuccess restores the last known models", () => {
  writeCatalog(cat({ claude: { status: "revoked", models: [m("sonnet"), m("claude-fable-5-1")] } }), FILE);
  const models = STATIC();
  auth.bind(models, { watch: false });
  assert.deepEqual(ids(models), ["codex", "gpt-5.5"]);
  assert.equal(auth.onAuthSuccess("claude"), true);
  assert.deepEqual(ids(models), ["sonnet", "claude-fable-5-1", "codex", "gpt-5.5"]);
  assert.equal(auth.onAuthSuccess("claude"), false);
  assert.equal(auth.onAuthSuccess("codex"), false); // never revoked → no write
});

test("hooks work without bind (read the file each call)", () => {
  assert.equal(auth.onAuthFailure("codex", "Please log out and sign in again."), true);
  assert.equal(readCatalog(FILE).providers.codex.status, "revoked");
  assert.equal(auth.onAuthSuccess("codex"), true);
  assert.equal(readCatalog(FILE).providers.codex.status, "ok");
});

test("watch: an external write is applied", async () => {
  const models = STATIC();
  auth.bind(models, { watch: true });
  await new Promise((r) => setTimeout(r, 50));
  writeCatalog(cat({ codex: { status: "revoked" } }), FILE);
  const deadline = Date.now() + 6000;
  while (ids(models).includes("codex") && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(ids(models), ["sonnet", "claude-opus-5"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/auth-state.test.js`
Expected: FAIL — `Cannot find module '../lib/auth-state.cjs'`

- [ ] **Step 3: Write the implementation** — `lib/auth-state.cjs`

```js
"use strict";
/**
 * Server-side view of the model catalog, loaded into otterly by patch-otterly.
 *
 * bind(MODELS) keeps otterly's discovery array (served by /v1/models and
 * /api/tags) in step with <state dir>/catalog.json — mutating it in place, so
 * no other otterly code has to change. The engines report auth outcomes:
 * onAuthFailure hides a provider whose login died, onAuthSuccess brings it
 * back (also covers a login fixed outside barnowl, e.g. in Claude Code).
 */
const fs = require("fs");
const catalog = require("./model-catalog.cjs");

const state = { models: null, statics: null, current: null, file: null };

function providerOf(id) {
  // Lazy: codex-engine requires this module.
  return require("./codex-engine.cjs").isCodexModel(id) ? "codex" : "claude";
}

function fileOf() {
  return state.file || catalog.catalogPath();
}

function apply() {
  const out = [];
  for (const p of catalog.PROVIDERS) {
    const entry = state.current && state.current.providers[p];
    if (!entry) {
      out.push(...state.statics[p]);
      continue;
    }
    if (catalog.HIDDEN.has(entry.status)) continue;
    out.push(...(Array.isArray(entry.models) && entry.models.length ? entry.models : state.statics[p]));
  }
  state.models.splice(0, state.models.length, ...out);
}

function reload() {
  state.current = catalog.readCatalog(state.file);
  apply();
}

function bind(models, { file = catalog.catalogPath(), watch = true } = {}) {
  state.models = models;
  state.file = file;
  state.statics = { claude: [], codex: [] };
  for (const m of models) state.statics[providerOf(m.id)].push(m);
  reload();
  if (watch) fs.watchFile(file, { interval: 2000, persistent: false }, reload);
  return models;
}

function statusOf(provider) {
  const current = state.models ? state.current : catalog.readCatalog(fileOf());
  const entry = current && current.providers[provider];
  return entry ? entry.status : null;
}

function onAuthFailure(provider, message) {
  if (statusOf(provider) === "revoked") return false;
  const changed = catalog.markStatus(provider, "revoked", String(message || "").slice(0, 500), fileOf());
  if (state.models) reload();
  return changed;
}

function onAuthSuccess(provider) {
  const status = statusOf(provider);
  if (status !== "revoked" && status !== "logged_out") return false;
  const changed = catalog.markStatus(provider, "ok", "", fileOf());
  if (state.models) reload();
  return changed;
}

function _reset() {
  if (state.file) fs.unwatchFile(state.file);
  state.models = state.statics = state.current = state.file = null;
}

module.exports = { bind, onAuthFailure, onAuthSuccess, statusOf, _reset };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/auth-state.test.js`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add lib/auth-state.cjs test/auth-state.test.js
git commit -m "Add auth-state: bind otterly's model list to the catalog, track login health

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: otterly patches

**Files:**
- Modify: `lib/patch-otterly.js` — constants next to the related existing sections, `ensurePatched()` wiring, results list
- Test: `test/patch-otterly.test.js`

**Interfaces:**
- Consumes: `bind`, `onAuthFailure`, `onAuthSuccess` (Task 4). `isAuthError`, `authMessage` (Task 1).
- Produces:
  - Patched otterly: `engine.js` `findClaudeCLI()` returns `$BARNOWL_CLAUDE_BIN` when set. `server/models.js` binds `MODELS`. `events.js` turns `is_error` results into `error` events (auth → `AgentError("NOT_AUTHENTICATED", authMessage("claude"))`) and drops assistant events carrying `error`. `routes-openai.js` falls back to `sonnet`, honours `err.barnowlCode` for the breaker, and gives stream error chunks their real type.
  - `ensurePatched()` keeps its return contract.

Background the implementer needs: `applyPatch(file, marker, anchor, replacement)` inserts once, keyed on `marker`. `applyPatchAll` replaces every occurrence. `migrateBlock(file, from, to)` upgrades a block an older barnowl already wrote. The live `server/models.js` on the dev machine was hand-edited, which is why the anchors below also match it. Upstream's first catalog lines are `    { id: "claude-opus-4-20250514", label: "Claude Opus 4", contextWindow: 200000 },` / `claude-sonnet-4-20250514` / `claude-3-5-haiku-20241022`, in that order, and the existing Codex patch appends after the haiku line.

- [ ] **Step 1: Write the failing test** — `test/patch-otterly.test.js`

```js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");

// The catalog must point at a temp dir BEFORE any patched otterly module loads.
const STATE = fs.mkdtempSync(path.join(os.tmpdir(), "barnowl-patch-"));
process.env.BARNOWL_STATE_DIR = STATE;
const CATALOG = path.join(STATE, "catalog.json");
const { ensurePatched } = require("../lib/patch-otterly.js");
const DIST = path.dirname(require.resolve("otterly"));
const load = (rel) => import(pathToFileURL(path.join(DIST, rel)).href);
const read = (rel) => fs.readFileSync(path.join(DIST, rel), "utf8");
const status = (p) => JSON.parse(fs.readFileSync(CATALOG, "utf8")).providers[p].status;

test.after(() => fs.rmSync(STATE, { recursive: true, force: true }));

test("ensurePatched applies everything and is idempotent", () => {
  assert.ok(["patched", "already"].includes(ensurePatched()));
  assert.equal(ensurePatched(), "already");
});

test("routes-openai: sonnet fallback, breaker code, typed stream errors", () => {
  const src = read("server/routes-openai.js");
  assert.ok(src.includes('let model = body.model || "sonnet";'));
  assert.ok(!src.includes("claude-sonnet-4-20250514"));
  assert.ok(src.includes("(err && err.barnowlCode) || undefined"));
  assert.ok(!src.includes('type: "server_error" } })'));
  assert.ok(src.includes("sseData(openaiErrorBody(errorToHttpStatus(e), e.message))"));
});

test("engine.js: BARNOWL_CLAUDE_BIN wins over the PATH lookup", () => {
  const src = read("engine.js");
  assert.ok(src.includes("barnowl: configured claude binary"));
  assert.ok(src.includes("if (process.env.BARNOWL_CLAUDE_BIN) {"));
});

test("models.js: sonnet default and the live-catalog hook", () => {
  const src = read("server/models.js");
  assert.ok(src.includes('export const DEFAULT_MODEL = "sonnet";'));
  assert.ok(src.includes("barnowl: live model catalog"));
  assert.ok(!src.includes('id: "claude-sonnet-4-20250514"'));
});

test("events: auth is_error result → NOT_AUTHENTICATED + claude marked revoked", async () => {
  const { normalizeEvents, createEventContext } = await load("events.js");
  const events = normalizeEvents({
    type: "result", subtype: "success", is_error: true, api_error_status: 401,
    result: "Failed to authenticate. API Error: 401 OAuth access token is invalid.",
  }, createEventContext());
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "error");
  assert.equal(events[0].error.code, "NOT_AUTHENTICATED");
  assert.match(events[0].error.message, /authentication failed .*barnowl login claude/);
  assert.equal(status("claude"), "revoked");
});

test("events: a successful result flips claude back to ok", async () => {
  const { normalizeEvents, createEventContext } = await load("events.js");
  const events = normalizeEvents({ type: "result", subtype: "success", is_error: false, result: "ok", usage: {} }, createEventContext());
  assert.equal(events[0].type, "result");
  assert.equal(status("claude"), "ok");
});

test("events: non-auth is_error result → plain error", async () => {
  const { normalizeEvents, createEventContext } = await load("events.js");
  const [ev] = normalizeEvents({
    type: "result", subtype: "success", is_error: true, api_error_status: 429,
    result: "API Error: 429 rate_limit_error",
  }, createEventContext());
  assert.equal(ev.type, "error");
  assert.equal(ev.error.code, undefined);
  assert.match(ev.error.message, /429/);
  assert.equal(status("claude"), "ok");
});

test("events: synthetic API-error assistant text is dropped, normal text kept", async () => {
  const { normalizeEvents, createEventContext } = await load("events.js");
  assert.deepEqual(normalizeEvents({
    type: "assistant", error: "authentication_failed",
    message: { model: "<synthetic>", content: [{ type: "text", text: "Failed to authenticate." }] },
  }, createEventContext()), []);
  assert.deepEqual(normalizeEvents({
    type: "assistant", message: { content: [{ type: "text", text: "hi" }] },
  }, createEventContext()), [{ type: "text", text: "hi" }]);
});

// Last: importing models.js binds the process-wide auth-state to CATALOG.
test("models.js serves the catalog in place", async () => {
  fs.writeFileSync(CATALOG, JSON.stringify({
    version: 1, refreshedAt: "t",
    providers: {
      claude: { status: "ok", models: [{ id: "sonnet", label: "S", contextWindow: 200000 }] },
      codex: { status: "revoked", models: [{ id: "codex", label: "C", contextWindow: 272000 }] },
    },
  }));
  const { MODELS } = await load("server/models.js");
  assert.deepEqual(MODELS.map((x) => x.id), ["sonnet"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/patch-otterly.test.js`
Expected: FAIL — the routes/models/events assertions fail (no new patches yet)

- [ ] **Step 3: Add the constants** to `lib/patch-otterly.js`

3a. Below `findModelsCatalog()`, add:

```js
/** Resolve events.js (raw CLI message → AgentEvent normalizer), or null. */
function findEvents() {
  const dir = otterlyDistDir();
  return dir ? path.join(dir, "events.js") : null;
}
```

3b. After the `CODEX_MODEL_LINES_V1` block, add:

```js
// ── server/models.js patches: live static fallback, sonnet default, catalog ──
// Upstream advertises claude-opus-4 / claude-sonnet-4 / claude-3-5-haiku; the
// last two are retired and the CLI rejects them. This static list only shows
// until the first `barnowl start` writes the live catalog (lib/model-catalog.cjs).
// Applied after the Codex patch, which appends below the haiku line.
const CLAUDE_STATIC_MARKER = 'id: "claude-opus-5"';
const CLAUDE_STATIC_ANCHOR = [
  '{ id: "claude-opus-4-20250514", label: "Claude Opus 4", contextWindow: 200000 },',
  '    { id: "claude-sonnet-4-20250514", label: "Claude Sonnet 4", contextWindow: 200000 },',
  '    { id: "claude-3-5-haiku-20241022", label: "Claude 3.5 Haiku", contextWindow: 200000 },',
].join("\n");
const CLAUDE_STATIC_REPLACEMENT = [
  '{ id: "sonnet", label: "Claude Sonnet (latest, default)", contextWindow: 200000 },',
  '    { id: "opus", label: "Claude Opus (latest)", contextWindow: 200000 },',
  '    { id: "haiku", label: "Claude Haiku (latest, fastest)", contextWindow: 200000 },',
  '    { id: "fable", label: "Claude Fable (latest)", contextWindow: 200000 },',
  '    { id: "claude-fable-5-1", label: "Claude Fable 5.1", contextWindow: 200000 },',
  '    { id: "claude-opus-5", label: "Claude Opus 5", contextWindow: 200000 },',
  '    { id: "claude-opus-5[1m]", label: "Claude Opus 5 (1M context)", contextWindow: 1000000 },',
  '    { id: "claude-sonnet-5", label: "Claude Sonnet 5", contextWindow: 200000 },',
  '    { id: "claude-sonnet-5[1m]", label: "Claude Sonnet 5 (1M context)", contextWindow: 1000000 },',
  '    { id: "claude-opus-4-8", label: "Claude Opus 4.8", contextWindow: 200000 },',
  '    { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", contextWindow: 200000 },',
].join("\n");

// findModel() falls back to DEFAULT_MODEL for unlisted ids, so it must be live.
const DEFAULT_MODEL_MARKER = 'DEFAULT_MODEL = "sonnet"';
const DEFAULT_MODEL_ANCHOR = 'export const DEFAULT_MODEL = "claude-sonnet-4-20250514";';
const DEFAULT_MODEL_REPLACEMENT = 'export const DEFAULT_MODEL = "sonnet";';

// Load lib/auth-state.cjs and bind MODELS to <state dir>/catalog.json.
const LIVE_CATALOG_MARKER = "barnowl: live model catalog";
const LIVE_CATALOG_ANCHOR = "export function findModel(id) {";
const LIVE_CATALOG_REPLACEMENT = [
  "// barnowl: live model catalog — <state dir>/catalog.json replaces MODELS in place",
  'import { createRequire as __catalogRequire } from "module";',
  "try {",
  '    __catalogRequire(import.meta.url)("../../../../lib/auth-state.cjs").bind(MODELS);',
  "}",
  "catch (_) {",
  "    // lib/auth-state.cjs unavailable: the static list stays",
  "}",
  "export function findModel(id) {",
].join("\n");

// ── events.js patches: API failures are errors, not content ────────────────
// The claude CLI reports API failures (401, 429, …) as
// `{type:"result", subtype:"success", is_error:true}` and first emits a
// synthetic assistant message carrying `error`. Upstream only checks subtype,
// so a revoked login came back as HTTP 200 whose content was
// "Failed to authenticate. API Error: 401 …".
const EVENTS_IMPORT_MARKER = "__barnowlAuth";
const EVENTS_IMPORT_ANCHOR = "export function createEventContext() {";
const EVENTS_IMPORT_REPLACEMENT = [
  "// barnowl: auth-aware results",
  'import { AgentError as __BarnowlAgentError } from "./errors.js";',
  'import { createRequire as __eventsRequire } from "module";',
  "const __barnowlAuth = (() => {",
  "    try {",
  "        const req = __eventsRequire(import.meta.url);",
  '        return { state: req("../../../lib/auth-state.cjs"), errors: req("../../../lib/auth-errors.cjs") };',
  "    }",
  "    catch (_) {",
  "        return null;",
  "    }",
  "})();",
  "export function createEventContext() {",
].join("\n");

const EVENTS_RESULT_MARKER = "barnowl: is_error results are errors";
const EVENTS_RESULT_ANCHOR = [
  '        case "result": {',
  '            if (raw.subtype === "success") {',
].join("\n");
const EVENTS_RESULT_REPLACEMENT = [
  '        case "result": {',
  "            // barnowl: is_error results are errors",
  "            if (raw.is_error) {",
  "                const __msg = String(raw.result || `Claude CLI error (${raw.subtype})`);",
  "                if (__barnowlAuth && (raw.api_error_status === 401 || __barnowlAuth.errors.isAuthError(__msg))) {",
  '                    __barnowlAuth.state.onAuthFailure("claude", __msg);',
  '                    events.push({ type: "error", error: new __BarnowlAgentError("NOT_AUTHENTICATED", __barnowlAuth.errors.authMessage("claude")) });',
  "                }",
  "                else {",
  '                    events.push({ type: "error", error: new Error(__msg) });',
  "                }",
  "                break;",
  "            }",
  "            if (__barnowlAuth)",
  '                __barnowlAuth.state.onAuthSuccess("claude");',
  '            if (raw.subtype === "success") {',
].join("\n");

const EVENTS_SYNTHETIC_MARKER = "barnowl: drop synthetic API-error text";
const EVENTS_SYNTHETIC_ANCHOR = [
  '        case "assistant": {',
  "            const message = raw.message;",
].join("\n");
const EVENTS_SYNTHETIC_REPLACEMENT = [
  '        case "assistant": {',
  "            // barnowl: drop synthetic API-error text — the result event carries the error",
  "            if (raw.error)",
  "                break;",
  "            const message = raw.message;",
].join("\n");
```

3c. Replace the `EFFORT_PARSE_REPLACEMENT` definition's first line and add the fallback migration right after the `EFFORT_PARSE_REPLACEMENT` block:

```js
const MODEL_FALLBACK = '    let model = body.model || "sonnet";';
// Installs patched before 2026-09-21 carry the retired upstream default.
const MODEL_FALLBACK_V1 = '    let model = body.model || "claude-sonnet-4-20250514";';
```

Define these two constants **above** `EFFORT_PARSE_REPLACEMENT`, then change its first element from `'    let model = body.model || "claude-sonnet-4-20250514";'` to `MODEL_FALLBACK`.

3d. After the `SAMPLING_ENGINE_*` block (end of the constants), add:

```js
// ── routes-openai.js patches: auth errors from barnowl's own engines ────────
// CodexEngine errors are not otterly AgentErrors; without their code the
// circuit breaker counts a dead login as an upstream outage.
const BREAKER_CODE_MARKER = "(err && err.barnowlCode) || undefined";
const BREAKER_CODE_FIND = "const code = err instanceof AgentError ? err.code : undefined;";
const BREAKER_CODE_REPLACE = "const code = err instanceof AgentError ? err.code : (err && err.barnowlCode) || undefined;";

// Stream error chunks were always "server_error"; give them the real type
// (authentication_error / rate_limit_error / …) like the non-stream path.
const STREAM_ERROR_MARKER = "sseData(openaiErrorBody(errorToHttpStatus(e), e.message))";
const STREAM_ERROR_FIND = 'sseData({ error: { message: e.message, type: "server_error" } })';
const STREAM_ERROR_REPLACE = "sseData(openaiErrorBody(errorToHttpStatus(e), e.message))";

// ── engine.js patch: honour BARNOWL_CLAUDE_BIN (config paths.claudeBin) ─────
// Upstream only looks up `claude` / `claude-code` on PATH. The value is
// embedded in a shell command string, so a path with spaces is double-quoted.
const CLAUDE_BIN_MARKER = "barnowl: configured claude binary";
const CLAUDE_BIN_ANCHOR = [
  "function findClaudeCLI() {",
  '    for (const bin of ["claude", "claude-code"]) {',
].join("\n");
const CLAUDE_BIN_REPLACEMENT = [
  "function findClaudeCLI() {",
  "    // barnowl: configured claude binary",
  "    if (process.env.BARNOWL_CLAUDE_BIN) {",
  "        const p = process.env.BARNOWL_CLAUDE_BIN;",
  "        return /\\s/.test(p) ? '\"' + p + '\"' : p;",
  "    }",
  '    for (const bin of ["claude", "claude-code"]) {',
].join("\n");
```

- [ ] **Step 4: Wire them into `ensurePatched()`**

Replace the models block:

```js
  // server/models.js: advertise codex models on /v1/models + /api/tags discovery.
  const modelsCatalog = findModelsCatalog();
  const codexModelsMigrateResult = migrateBlock(modelsCatalog, CODEX_MODEL_LINES_V1, CODEX_MODEL_LINES);
  const codexModelsResult = applyPatch(modelsCatalog, CODEX_MODELS_MARKER, CODEX_MODELS_ANCHOR, CODEX_MODELS_REPLACEMENT);
```

with:

```js
  // server/models.js: codex entries, live static fallback, sonnet default, live catalog.
  // The Claude static list replaces the lines the Codex patch anchors on, so it runs after it.
  const modelsCatalog = findModelsCatalog();
  const codexModelsMigrateResult = migrateBlock(modelsCatalog, CODEX_MODEL_LINES_V1, CODEX_MODEL_LINES);
  const codexModelsResult = applyPatch(modelsCatalog, CODEX_MODELS_MARKER, CODEX_MODELS_ANCHOR, CODEX_MODELS_REPLACEMENT);
  const claudeStaticResult = applyPatch(modelsCatalog, CLAUDE_STATIC_MARKER, CLAUDE_STATIC_ANCHOR, CLAUDE_STATIC_REPLACEMENT);
  const defaultModelResult = applyPatch(modelsCatalog, DEFAULT_MODEL_MARKER, DEFAULT_MODEL_ANCHOR, DEFAULT_MODEL_REPLACEMENT);
  const liveCatalogResult = applyPatch(modelsCatalog, LIVE_CATALOG_MARKER, LIVE_CATALOG_ANCHOR, LIVE_CATALOG_REPLACEMENT);

  // events.js: is_error results → errors (auth → NOT_AUTHENTICATED), synthetic error text dropped.
  const events = findEvents();
  const eventsImportResult = applyPatch(events, EVENTS_IMPORT_MARKER, EVENTS_IMPORT_ANCHOR, EVENTS_IMPORT_REPLACEMENT);
  const eventsResultResult = (eventsImportResult === "patched" || eventsImportResult === "already")
    ? applyPatch(events, EVENTS_RESULT_MARKER, EVENTS_RESULT_ANCHOR, EVENTS_RESULT_REPLACEMENT)
    : eventsImportResult;
  const eventsSyntheticResult = applyPatch(events, EVENTS_SYNTHETIC_MARKER, EVENTS_SYNTHETIC_ANCHOR, EVENTS_SYNTHETIC_REPLACEMENT);

  // routes-openai.js: breaker honours barnowlCode; typed stream error chunks.
  const breakerCodeResult = applyPatchAll(routes, BREAKER_CODE_MARKER, BREAKER_CODE_FIND, BREAKER_CODE_REPLACE);
  const streamErrorResult = applyPatchAll(routes, STREAM_ERROR_MARKER, STREAM_ERROR_FIND, STREAM_ERROR_REPLACE);

  // engine.js: configured claude binary (paths.claudeBin → BARNOWL_CLAUDE_BIN).
  const claudeBinResult = applyPatch(engine, CLAUDE_BIN_MARKER, CLAUDE_BIN_ANCHOR, CLAUDE_BIN_REPLACEMENT);
```

After the `effortSuffixMigrateResult` line, add:

```js
  const modelFallbackMigrateResult = migrateBlock(routes, MODEL_FALLBACK_V1, MODEL_FALLBACK);
```

Extend `results`:

```js
  const results = [
    engineResult, quoteResult, sysPromptResult,
    routesResult, warmImportResult, resumeResult, sessionRespResult, sessionStreamResult,
    codexImportResult, codexEngineResult, codexModelsMigrateResult, codexModelsResult,
    claudeStaticResult, defaultModelResult, liveCatalogResult,
    eventsImportResult, eventsResultResult, eventsSyntheticResult,
    breakerCodeResult, streamErrorResult, claudeBinResult,
    imagesImportResult, imagesFormatResult, imagesDispatchResult, imagesTimeoutResult,
    toolsResult, usageResult, usageDetailsResult,
    effortEngineResult, effortParseResult, effortSuffixMigrateResult, modelFallbackMigrateResult, effortSetResult,
    samplingParseResult, samplingEngineResult, samplingStreamResult, verbosityParseResult,
  ];
```

Update the `ensurePatched` JSDoc first line to: `Apply every otterly patch (idempotent).`

- [ ] **Step 5: Run the patch test, then the whole suite**

Run: `node --test test/patch-otterly.test.js && npm test`
Expected: PASS. If `ensurePatched()` returns `"no-anchor"`, print each result: temporarily `console.error` the `results` array, find the anchor that did not match, compare it with the file in `node_modules/otterly/dist`, and fix the anchor rather than the test.

- [ ] **Step 6: Commit**

```bash
git add lib/patch-otterly.js test/patch-otterly.test.js
git commit -m "patch-otterly: live catalog in models.js, is_error results as errors, sonnet fallback

Folds in PR #1 (sonnet default + live static list) and makes the claude
CLI's is_error results real errors: a revoked login now answers 401 with
the barnowl login hint instead of 200 with the error text as content.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Engine hooks (Codex engine, image gen, warm pool)

**Files:**
- Modify: `lib/codex-engine.cjs` (requires at top; `run()` failure/success path)
- Modify: `lib/image-gen.cjs` (requires, `errorBody`, `runGenerateScript` close handler, `handleImages` catch)
- Modify: `lib/warm-sessions.cjs` (require, success branch of `runTurn`)
- Test: `test/codex-auth.test.js`

**Interfaces:**
- Consumes: `onAuthFailure`, `onAuthSuccess` (Task 4). `isAuthError`, `authError` (Task 1).
- Produces: `CodexEngine#run` rejects with `authError("codex")` (`barnowlCode: "NOT_AUTHENTICATED"`) on a dead login. Image requests answer 401 with `type: "authentication_error"`.

- [ ] **Step 1: Check how `CODEX_BIN` is resolved**

Run: `grep -n "CODEX_BIN" lib/codex-engine.cjs | head -5`
Expected: `CODEX_BIN` honours `process.env.BARNOWL_CODEX_BIN` when set. If it does not, add that override at the top of its resolution, e.g. `const CODEX_BIN = process.env.BARNOWL_CODEX_BIN || <existing resolution>;`.

- [ ] **Step 2: Write the failing test** — `test/codex-auth.test.js`

```js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const STATE = fs.mkdtempSync(path.join(os.tmpdir(), "barnowl-codexauth-"));
process.env.BARNOWL_STATE_DIR = STATE;
const BIN = path.join(STATE, "fake-codex");
// Minimal `codex exec` stand-in. FAKE_CODEX_MODE=revoked replays the stderr a
// dead ChatGPT login produced on 2026-09-21; crash fails for another reason.
fs.writeFileSync(BIN, `#!/usr/bin/env node
const args = process.argv.slice(2);
process.stdin.resume();
process.stdin.on("data", () => {});
process.stdin.on("end", () => {
  const mode = process.env.FAKE_CODEX_MODE;
  if (mode === "revoked") {
    process.stderr.write("ERROR codex_login::auth::manager: Failed to refresh token: 401 Unauthorized\\n");
    process.stderr.write("ERROR: Your access token could not be refreshed. Please log out and sign in again.\\n");
    process.exit(1);
  }
  if (mode === "crash") {
    process.stderr.write("boom\\n");
    process.exit(2);
  }
  require("fs").writeFileSync(args[args.indexOf("-o") + 1], "ok");
  process.exit(0);
});
`, { mode: 0o755 });
process.env.BARNOWL_CODEX_BIN = BIN;

const { CodexEngine } = require("../lib/codex-engine.cjs");
const { readCatalog, catalogPath } = require("../lib/model-catalog.cjs");
const codexStatus = () => { const c = readCatalog(catalogPath()); return c && c.providers.codex ? c.providers.codex.status : null; };

test.after(() => fs.rmSync(STATE, { recursive: true, force: true }));

test("dead login → authError(codex) and codex marked revoked", async () => {
  process.env.FAKE_CODEX_MODE = "revoked";
  await assert.rejects(new CodexEngine().run("hi", { model: "gpt-5.5" }), (e) => {
    assert.equal(e.barnowlCode, "NOT_AUTHENTICATED");
    assert.match(e.message, /Codex authentication failed .*barnowl login codex/);
    return true;
  });
  assert.equal(codexStatus(), "revoked");
});

test("success flips codex back to ok", async () => {
  process.env.FAKE_CODEX_MODE = "";
  const result = await new CodexEngine().run("hi", { model: "gpt-5.5" });
  assert.equal(result.text, "ok");
  assert.equal(codexStatus(), "ok");
});

test("other failures stay plain errors and leave the status alone", async () => {
  process.env.FAKE_CODEX_MODE = "crash";
  await assert.rejects(new CodexEngine().run("hi", { model: "gpt-5.5" }), (e) => {
    assert.equal(e.barnowlCode, undefined);
    assert.match(e.message, /codex exec failed \(exit 2\): boom/);
    return true;
  });
  assert.equal(codexStatus(), "ok");
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test test/codex-auth.test.js`
Expected: FAIL — first test: `barnowlCode` is `undefined`, the message is `codex exec failed (exit 1): …`

- [ ] **Step 4: Implement the Codex engine hook** — `lib/codex-engine.cjs`

Below the existing `require` lines add:

```js
const authState = require("./auth-state.cjs");
const { isAuthError, authError } = require("./auth-errors.cjs");
```

In `run()`, replace:

```js
    if (aborted) throw new Error("Aborted");
    if (!text && code !== 0) {
      const detail = (stderr || stdout).trim().slice(-500);
      throw new Error(`codex exec failed (exit ${code})${detail ? ": " + detail : ""}`);
    }
```

with:

```js
    if (aborted) throw new Error("Aborted");
    if (!text && code !== 0) {
      const detail = (stderr || stdout).trim().slice(-500);
      if (isAuthError(stderr)) {
        authState.onAuthFailure("codex", detail);
        throw authError("codex");
      }
      throw new Error(`codex exec failed (exit ${code})${detail ? ": " + detail : ""}`);
    }
    authState.onAuthSuccess("codex");
```

Add a line to the header's `Auth:` paragraph: ` *   A dead login (401 / "sign in again" on stderr) → authError("codex") → HTTP 401.`

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test test/codex-auth.test.js`
Expected: PASS (3 tests)

- [ ] **Step 6: Image gen hook** — `lib/image-gen.cjs`

Below `const { CODEX_BIN, isCodexModel, mapModel } = require("./codex-engine.cjs");` add:

```js
const authState = require("./auth-state.cjs");
const { isAuthError, authError } = require("./auth-errors.cjs");
```

In `errorBody`, change the type line to:

```js
      type: status === 400 ? "invalid_request_error" : status === 401 ? "authentication_error" : "server_error",
```

In `runGenerateScript`'s `close` handler, replace:

```js
      if (code === 0 && ok && fs.existsSync(ok[1].trim())) {
        return resolve({ file: ok[1].trim() });
      }
      const detail = (stdout + "\n" + stderr).trim().slice(-500);
      reject(new Error(`codex-image generation failed (exit ${code})${detail ? ": " + detail : ""}`));
```

with:

```js
      if (code === 0 && ok && fs.existsSync(ok[1].trim())) {
        authState.onAuthSuccess("codex");
        return resolve({ file: ok[1].trim() });
      }
      const detail = (stdout + "\n" + stderr).trim().slice(-500);
      // stderr only: stdout echoes the user's prompt, which may contain "401".
      if (isAuthError(stderr)) {
        authState.onAuthFailure("codex", detail);
        return reject(authError("codex"));
      }
      reject(new Error(`codex-image generation failed (exit ${code})${detail ? ": " + detail : ""}`));
```

In `handleImages`' catch, replace:

```js
    const status = /Aborted/.test(String(err && err.message)) ? 499 : 500;
```

with:

```js
    const status = /Aborted/.test(String(err && err.message)) ? 499
      : err && err.barnowlCode === "NOT_AUTHENTICATED" ? 401 : 500;
```

Also in `lib/image-gen.cjs` (config paths): replace

```js
const IMAGES_DIR = path.join(os.homedir(), ".barnowl", "images");
```

with

```js
const IMAGES_DIR = path.join(require("./model-catalog.cjs").stateDir(), "images");
```

and in `runGenerateScript` replace `const child = spawn("python3", args, {` with `const child = spawn(process.env.BARNOWL_PYTHON || "python3", args, {`. Update the header's "Response" paragraph: `~/.barnowl/images/` → `<state dir>/images/`.

- [ ] **Step 7: Warm pool hook** — `lib/warm-sessions.cjs`

Below `const path = require("path");` add:

```js
const authState = require("./auth-state.cjs");
```

In `runTurn`, replace:

```js
        } else {
          finish(null, {
```

with:

```js
        } else {
          authState.onAuthSuccess("claude");
          finish(null, {
```

Leave the `is_error` branch alone. A failed warm turn falls back to the one-shot `--resume` path, and `events.js` (Task 5) turns that into the 401.

- [ ] **Step 8: Run the whole suite**

Run: `npm test`
Expected: PASS (all files)

- [ ] **Step 9: Commit**

```bash
git add lib/codex-engine.cjs lib/image-gen.cjs lib/warm-sessions.cjs test/codex-auth.test.js
git commit -m "Report login health from the Codex engine, image gen and warm pool

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Per-user paths (`lib/paths.cjs`, config `paths`)

**Files:**
- Create: `lib/paths.cjs`
- Modify: `bin/barnowl.js` (state dir + config wiring, `config` / `config init` output, help)
- Test: `test/paths.test.js`

**Interfaces:**
- Consumes: `stateDir()` (Task 2). `CODEX_BIN` from `lib/codex-engine.cjs` (lazily).
- Produces:
  - `PATH_KEYS: { key, env }[]` — `claudeBin/BARNOWL_CLAUDE_BIN`, `codexBin/BARNOWL_CODEX_BIN`, `python/BARNOWL_PYTHON`, `codexHome/CODEX_HOME`, `claudeKeychainAccount/BARNOWL_CLAUDE_KEYCHAIN_ACCOUNT`, `claudeCredentialsFile/BARNOWL_CLAUDE_CREDENTIALS_FILE`, `stateDir/BARNOWL_STATE_DIR`
  - `expandHome(p, home?) → string`
  - `applyPaths(filePaths, env = process.env, home?) → { [key]: { value: string|null, source: "env"|"file"|"auto" } }`. Exports each file value to its env var unless the env var is already set.
  - `detectPaths({ home, platform }?) → { [key]: string|null }`
  - `bin/barnowl.js`: `initPaths(argv)` runs first in `main()`. It sets the module-level `STATE_DIR`, `PID_FILE`, `LOG_FILE`, `PATHS`.

- [ ] **Step 1: Write the failing test** — `test/paths.test.js`

```js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { PATH_KEYS, expandHome, applyPaths, detectPaths } = require("../lib/paths.cjs");

test("expandHome: leading ~ only", () => {
  assert.equal(expandHome("~/x/y", "/home/u"), "/home/u/x/y");
  assert.equal(expandHome("~", "/home/u"), "/home/u");
  assert.equal(expandHome("/a/~b", "/home/u"), "/a/~b");
  assert.equal(expandHome("~other/x", "/home/u"), "~other/x");
});

test("applyPaths: env wins, file values exported (~ expanded), the rest auto", () => {
  const env = { BARNOWL_CODEX_BIN: "/env/codex" };
  const out = applyPaths({
    codexBin: "/file/codex",
    claudeBin: "~/bin/claude",
    claudeKeychainAccount: "~literal",
    stateDir: "",
  }, env, "/home/u");
  assert.deepEqual(out.codexBin, { value: "/env/codex", source: "env" });
  assert.equal(env.BARNOWL_CODEX_BIN, "/env/codex");
  assert.deepEqual(out.claudeBin, { value: "/home/u/bin/claude", source: "file" });
  assert.equal(env.BARNOWL_CLAUDE_BIN, "/home/u/bin/claude");
  assert.deepEqual(out.claudeKeychainAccount, { value: "~literal", source: "file" }); // not a path
  assert.deepEqual(out.stateDir, { value: null, source: "auto" });
  assert.equal(env.BARNOWL_STATE_DIR, undefined);
  assert.deepEqual(Object.keys(out), PATH_KEYS.map((k) => k.key));
});

test("applyPaths: missing or non-object paths block → all auto, env untouched", () => {
  const env = {};
  const out = applyPaths(undefined, env, "/home/u");
  assert.ok(Object.values(out).every((r) => r.source === "auto" && r.value === null));
  assert.deepEqual(env, {});
});

test("detectPaths: fixed defaults per platform", () => {
  const mac = detectPaths({ home: "/Users/u", platform: "darwin" });
  assert.equal(mac.codexHome, path.join("/Users/u", ".codex"));
  assert.equal(mac.stateDir, path.join("/Users/u", ".barnowl"));
  assert.equal(mac.claudeCredentialsFile, null);
  assert.equal(typeof mac.claudeKeychainAccount, "string");
  const linux = detectPaths({ home: "/home/u", platform: "linux" });
  assert.equal(linux.claudeKeychainAccount, null);
  assert.equal(linux.claudeCredentialsFile, path.join("/home/u", ".claude", ".credentials.json"));
  for (const k of ["claudeBin", "codexBin", "python"]) {
    assert.ok(mac[k] === null || path.isAbsolute(mac[k]), `${k}: ${mac[k]}`);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/paths.test.js`
Expected: FAIL — `Cannot find module '../lib/paths.cjs'`

- [ ] **Step 3: Write the implementation** — `lib/paths.cjs`

```js
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/paths.test.js`
Expected: PASS (4 tests)

- [ ] **Step 5: Wire it into `bin/barnowl.js`**

5a. Below `const { checkForUpdate } = require("../lib/self-update.js");` add:

```js
const { stateDir } = require("../lib/model-catalog.cjs");
const { PATH_KEYS, applyPaths, detectPaths } = require("../lib/paths.cjs");
```

5b. Replace the four constants

```js
const STATE_DIR = path.join(os.homedir(), ".barnowl");
const PID_FILE = path.join(STATE_DIR, "barnowl.pid");
const LOG_FILE = path.join(STATE_DIR, "barnowl.log");
const GLOBAL_CONFIG = path.join(STATE_DIR, "config.json");
```

with:

```js
// The config file is always looked up in ~/.barnowl; paths.stateDir only moves
// barnowl's runtime files (pid, log, catalog, images).
const CONFIG_HOME = path.join(os.homedir(), ".barnowl");
const GLOBAL_CONFIG = path.join(CONFIG_HOME, "config.json");
// Set by initPaths() once the config file's `paths` are applied.
let STATE_DIR;
let PID_FILE;
let LOG_FILE;
let PATHS;
```

5c. Memoize `loadConfigFile`, because `initPaths` and `parseFlags` both call it and an invalid file would otherwise warn twice. Add above the function:

```js
const configCache = new Map();
```

and wrap its body so it starts with:

```js
function loadConfigFile(explicitPath) {
  const cacheKey = explicitPath || "";
  if (configCache.has(cacheKey)) return configCache.get(cacheKey);
  const found = findConfigFile(explicitPath);
  configCache.set(cacheKey, found);
  return found;
}
```

Rename the existing function to `findConfigFile(explicitPath)`, with its body unchanged.

5d. Add after `parseFlags`:

```js
/** Apply the config file's `paths` (env wins) and derive the runtime file locations. */
function initPaths(argv) {
  const i = argv.indexOf("--config");
  const file = loadConfigFile(i >= 0 ? argv[i + 1] : undefined);
  PATHS = applyPaths(file && file.data ? file.data.paths : null);
  STATE_DIR = stateDir();
  PID_FILE = path.join(STATE_DIR, "barnowl.pid");
  LOG_FILE = path.join(STATE_DIR, "barnowl.log");
}
```

5e. In `main()`, first line after `const [cmd, ...rest] = process.argv.slice(2);`:

```js
  initPaths(rest);
```

5f. In `config init`, change `fs.mkdirSync(STATE_DIR, { recursive: true });` to `fs.mkdirSync(CONFIG_HOME, { recursive: true });`. Add `paths` to `starter`, with detected values and nulls dropped:

```js
          paths: Object.fromEntries(Object.entries(detectPaths()).filter(([, v]) => v)),
```

After the line that prints `created: <target>`, add:

```js
        console.log("paths were pre-filled by auto-detection — check them (README: Setup with an AI agent)");
```

5g. In `config` (show), add `paths` to the printed object, after `configFile: cfg.configFile,`:

```js
          paths: (() => {
            const detected = detectPaths();
            return Object.fromEntries(PATH_KEYS.map(({ key }) => {
              const r = PATHS[key];
              const value = r.source === "auto" ? detected[key] : r.value;
              return [key, `${value ?? "(none)"}  [${r.source}]`];
            }));
          })(),
```

5h. In `cmdHelp()`, after the `Config file (…)` paragraph add:

```
  Per-user paths (config "paths" block; env vars win; see README "Setup with an AI agent"):
    claudeBin, codexBin, python, codexHome, claudeKeychainAccount, claudeCredentialsFile, stateDir
```

- [ ] **Step 6: Verify**

Run:
```bash
S=$(mktemp -d); CFG=$S/cfg.json
printf '{"paths":{"stateDir":"%s/state","python":"/usr/bin/python3"}}\n' "$S" > "$CFG"
node bin/barnowl.js config --config "$CFG"
BARNOWL_PYTHON=/env/python node bin/barnowl.js config --config "$CFG" | grep python
node bin/barnowl.js config init "$S/new.json" && node -e 'console.log(Object.keys(require(process.argv[1]).paths))' "$S/new.json"
npm test
```
Expected:
- the first `config` prints `stateDir` as `<S>/state  [file]` and `python` as `/usr/bin/python3  [file]`; the rest are `[auto]` with detected values
- the second prints `/env/python  [env]`
- `config init` creates the file, and its `paths` keys include `claudeBin`, `codexHome`, `stateDir`
- tests PASS

- [ ] **Step 7: Commit**

```bash
git add lib/paths.cjs test/paths.test.js bin/barnowl.js
git commit -m "Per-user paths in the config file (claude/codex/python bins, codex home, keychain account, state dir)

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: CLI — refresh on start, `login`, `status`, `models`, help (`bin/barnowl.js`)

**Files:**
- Modify: `bin/barnowl.js`

**Interfaces:**
- Consumes: `refreshCatalog`, `readCatalog`, `summarize`, `PROVIDERS`, `HIDDEN`, `claudeBin`, `codexBin` (Tasks 2–3). `NAMES` (Task 1). `STATE_DIR` / `PID_FILE` / `LOG_FILE` set by `initPaths()` (Task 7).
- Produces: `barnowl login [claude|codex]`. Start output lines `  Models   : …` / `  Auth     : …`. An auth block in `status`. A live `models` listing.

- [ ] **Step 1: Imports**

Replace `const { stateDir } = require("../lib/model-catalog.cjs");` (added in Task 7) with:

```js
const {
  PROVIDERS, HIDDEN, stateDir, refreshCatalog, readCatalog, summarize, claudeBin, codexBin,
} = require("../lib/model-catalog.cjs");
const { NAMES } = require("../lib/auth-errors.cjs");
```

- [ ] **Step 2: Summary helpers** — add after `httpJson()`:

```js
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
```

- [ ] **Step 3: Refresh in `cmdStart`**

Directly after the block that returns `Already running` (after its closing `}`), insert:

```js
  // Ask the Claude / Codex backends which models these logins can use. The
  // server reads the result from the catalog file (lib/auth-state.cjs).
  printCatalogSummary(await refreshCatalog());
```

- [ ] **Step 4: `cmdStatus` prints auth even when unreachable** — replace the whole function:

```js
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
```

- [ ] **Step 5: `cmdModels` prefers the live catalog** — insert at the top of `cmdModels()`:

```js
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
```

- [ ] **Step 6: `cmdLogin`** — add after `cmdModels`:

```js
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
```

- [ ] **Step 7: Dispatch + help**

In `main()`'s switch, after `case "models": return cmdModels();` add:

```js
    case "login": return cmdLogin(rest);
```

In `cmdHelp()`:
- After the `barnowl models` line add `    barnowl login [claude|codex]           Re-login (revoked / expired), no restart`
- Change `barnowl models                         List usable model names` to `barnowl models                         Live model list (per login)`
- Add a paragraph before `Client setup:`:

```
  Models & logins:
    start asks Claude / Codex which models your logins can use (~/.barnowl/catalog.json);
    a revoked login answers 401 and its models leave /v1/models until \`barnowl login\`
```

- Change the Env lines to include `BARNOWL_STATE_DIR`:

```
  Env: BARNOWL_PORT, BARNOWL_WORK_DIR, BARNOWL_API_KEY, BARNOWL_AUTO_UPDATE, BARNOWL_STATE_DIR,
       BARNOWL_QUEUE_TIMEOUT, BARNOWL_MAX_CONCURRENT, BARNOWL_MAX_QUEUE, BARNOWL_RATE_LIMIT
```

Update the file header's `Commands:` line to `start | stop | restart | status | verify | models | login | help`.

- [ ] **Step 8: Verify the CLI offline-safe paths**

Run:
```bash
S=$(mktemp -d) && BARNOWL_STATE_DIR=$S node bin/barnowl.js status -p 11499; echo "exit=$?"
BARNOWL_STATE_DIR=$S node bin/barnowl.js login nope; echo "exit=$?"
BARNOWL_STATE_DIR=$S node bin/barnowl.js models | head -3
node bin/barnowl.js help | grep -n "login\|STATE_DIR"
npm test
```
Expected:
- `status`: `Not reachable on http://localhost:11499 …`, then `Auth: no catalog yet …`, `exit=1`
- `login nope`: `Usage: barnowl login [claude|codex]`, `exit=1`
- `models`: the old `Recommended model names (aliases):` output (no catalog yet)
- `help`: shows the login line and `BARNOWL_STATE_DIR`
- `npm test`: PASS

- [ ] **Step 9: Commit**

```bash
git add bin/barnowl.js
git commit -m "barnowl: refresh the live model catalog on start; add login, auth status

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Docs (`README.md`, `README.ja.md`)

**Files:**
- Modify: `README.md` (usage block, paragraph at the "`barnowl models` lists every id…" line)
- Modify: `README.ja.md` (same places)

- [ ] **Step 1: README.md usage block** — after `barnowl models                # list usable model names` add:

```
barnowl login [claude|codex]  # re-login after a revoked / expired login (no restart)
```

and change the models comment to `# live model list per login`.

- [ ] **Step 2: README.md model paragraph** — replace the paragraph starting ``barnowl models` lists every id in `config/models.json`.`` (3 lines) with:

```markdown
**Live model list.** Every `barnowl start` asks the Claude and Codex backends
which models your logins can use (with the tokens the `claude` / `codex` CLIs
already hold) and saves the answer to `~/.barnowl/catalog.json`. `GET
/v1/models`, `/api/tags` and `barnowl models` serve that list: the Claude
aliases (`sonnet`, `opus`, `haiku`, `fable`, `default`), every Claude model the
API returns (plus a `[1m]` variant for 1M-context models, minus the retired ids
above), and the Codex models your ChatGPT account lists. If the Claude token
has expired, `start` first runs one tiny `claude -p` (haiku) so the CLI
refreshes it. Offline or unreadable credentials keep the previous list. Ids
that are not advertised still work — the id is passed through to the CLI
verbatim.

**Revoked logins.** When a login stops working (revoked, expired, signed out),
requests for that provider answer HTTP 401 with the fix, its models leave
`/v1/models`, and `barnowl status` shows it. Run `barnowl login claude` or
`barnowl login codex`; the running server picks the new login up without a
restart. A login fixed elsewhere (e.g. in Claude Code itself) is noticed by
the next successful request.
```

- [ ] **Step 3: README.ja.md usage block** — after `barnowl models                # 使えるモデル名の一覧` add:

```
barnowl login [claude|codex]  # revoke / 期限切れ後の再ログイン（再起動不要）
```

and change the models comment to `# ログインごとの実モデル一覧`.

- [ ] **Step 4: README.ja.md model paragraph** — replace the paragraph starting ``barnowl models` は `config/models.json` の全 ID を表示します。`` (3 lines) with:

```markdown
**モデル一覧の自動更新** — `barnowl start` のたびに、`claude` / `codex` CLI が
持っているトークンで Claude と Codex のモデル一覧 API を叩き、結果を
`~/.barnowl/catalog.json` に保存します。`GET /v1/models`・`/api/tags`・
`barnowl models` はこの一覧を返します。中身は Claude のエイリアス（`sonnet`
`opus` `haiku` `fable` `default`）、API が返す全 Claude モデル（1M 対応モデルは
`[1m]` 版も追加、上記の廃止 ID は除外）、ChatGPT アカウントで使える Codex
モデルです。Claude のトークンが期限切れのときは、先に `claude -p`（haiku）を
1 回だけ流して CLI に更新させます。オフラインや認証情報が読めない場合は前回の
一覧を使います。一覧にない ID もそのまま CLI に渡るので利用できます。

**ログインが revoke されたとき** — ログインが無効になると（revoke・期限切れ・
ログアウト）、そのプロバイダへのリクエストは HTTP 401 と対処法を返し、モデルは
`/v1/models` から消え、`barnowl status` に表示されます。`barnowl login claude`
または `barnowl login codex` を実行すれば、動いているサーバーが再起動なしで
新しいログインを拾います。Claude Code など barnowl の外で直した場合も、次に
成功したリクエストで自動的に元に戻ります。
```

- [ ] **Step 5: "Setup with an AI agent" section (README.md)** — insert as a new `##` section immediately before `## Usage`:

```markdown
## Setup with an AI agent

Install paths differ per machine (where `claude` / `codex` / `python3` live,
which keychain item holds the Claude login, …). They go in the `paths` block
of `~/.barnowl/config.json`. The steps below are written for an AI coding
agent (Claude Code, Codex, …): point it at this section and let it configure
the machine.

> **Agent instructions — configure barnowl's per-user paths**
>
> 1. Run `barnowl config init`. It creates `~/.barnowl/config.json` with
>    `paths` pre-filled by auto-detection. If the file already exists, keep
>    it and add or merge a `paths` object instead.
> 2. Check every key in the table below with its command and correct the
>    value in `paths`. Use absolute paths (`~` is allowed). Remove keys whose
>    default is right.
> 3. macOS only: the keychain can hold several `Claude Code-credentials`
>    items. List them with
>    `security dump-keychain | grep -B12 '"svce"<blob>="Claude Code-credentials"' | grep -E '"acct"|"mdat"'`
>    and set `claudeKeychainAccount` to the account whose item was modified
>    most recently. That is normally the OS username — never `unknown`.
> 4. Verify:
>    - `barnowl config` shows each path with `[file]` or `[auto]` and a real value
>    - `barnowl start` prints `Auth     : claude ok · codex ok`
>    - `barnowl verify` ends in `OK`
>
>    If a login shows `revoked` or `logged_out`, ask the user to run
>    `barnowl login <provider>` (it opens a browser). Do not log in on their
>    behalf.
> 5. Never set `CLAUDE_CONFIG_DIR` for barnowl: Claude Code derives its
>    keychain item from it, and the CLI would look logged out.

| key | what | find it with | default |
| --- | --- | --- | --- |
| `claudeBin` | Claude Code CLI | `which claude` | `claude` on PATH |
| `codexBin` | Codex CLI | `which codex` | common install dirs, then PATH |
| `python` | Python 3 for image generation | `which python3` | `python3` |
| `codexHome` | Codex data dir (login, model cache) | `echo ${CODEX_HOME:-$HOME/.codex}` | `~/.codex` |
| `claudeKeychainAccount` | keychain account of the Claude login (macOS) | step 3 | OS username |
| `claudeCredentialsFile` | Claude credentials file (Linux / Windows) | `ls ~/.claude/.credentials.json` | `~/.claude/.credentials.json` |
| `stateDir` | barnowl's catalog, pid, log, images | — | `~/.barnowl` |

Each key can also be set by an env var, which wins over the file:
`BARNOWL_CLAUDE_BIN`, `BARNOWL_CODEX_BIN`, `BARNOWL_PYTHON`, `CODEX_HOME`,
`BARNOWL_CLAUDE_KEYCHAIN_ACCOUNT`, `BARNOWL_CLAUDE_CREDENTIALS_FILE`,
`BARNOWL_STATE_DIR`.
```

- [ ] **Step 6: Same section in README.ja.md** — find the usage heading with `grep -n '^## ' README.ja.md` and insert immediately before it:

```markdown
## AI エージェントでのセットアップ

`claude` / `codex` / `python3` の場所や、Claude のログインが入っている
キーチェーン項目は環境ごとに違います。これらは `~/.barnowl/config.json` の
`paths` に書きます。以下は AI コーディングエージェント（Claude Code、Codex
など）向けの手順です。エージェントにこの節を読ませて設定させてください。

> **エージェントへの指示 — barnowl のパス設定**
>
> 1. `barnowl config init` を実行する。自動検出で `paths` を埋めた
>    `~/.barnowl/config.json` ができる。既にファイルがある場合はそれを残し、
>    `paths` オブジェクトを追加・マージする。
> 2. 下の表の各キーを確認コマンドで調べ、`paths` の値を直す。絶対パスで書く
>    （`~` は可）。既定値で正しいキーは消してよい。
> 3. macOS のみ: キーチェーンに `Claude Code-credentials` が複数あることがある。
>    `security dump-keychain | grep -B12 '"svce"<blob>="Claude Code-credentials"' | grep -E '"acct"|"mdat"'`
>    で一覧し、更新日時（mdat）が最も新しい項目の acct を
>    `claudeKeychainAccount` に設定する。通常は OS のユーザー名で、`unknown`
>    は選ばない。
> 4. 確認:
>    - `barnowl config` で各パスが `[file]` か `[auto]` で実在の値になっている
>    - `barnowl start` が `Auth     : claude ok · codex ok` を表示する
>    - `barnowl verify` が `OK` で終わる
>
>    ログインが `revoked` / `logged_out` なら、ユーザーに
>    `barnowl login <provider>` の実行を頼む（ブラウザが開く）。代わりに
>    ログインはしない。
> 5. barnowl のために `CLAUDE_CONFIG_DIR` を設定しない。Claude Code は
>    これからキーチェーン項目名を決めるので、CLI が未ログイン扱いになる。

| キー | 内容 | 調べ方 | 既定値 |
| --- | --- | --- | --- |
| `claudeBin` | Claude Code CLI | `which claude` | PATH 上の `claude` |
| `codexBin` | Codex CLI | `which codex` | よくあるインストール先 → PATH |
| `python` | 画像生成用 Python 3 | `which python3` | `python3` |
| `codexHome` | Codex のデータ（ログイン・モデルキャッシュ） | `echo ${CODEX_HOME:-$HOME/.codex}` | `~/.codex` |
| `claudeKeychainAccount` | Claude ログインのキーチェーン acct（macOS） | 手順 3 | OS ユーザー名 |
| `claudeCredentialsFile` | Claude 認証ファイル（Linux / Windows） | `ls ~/.claude/.credentials.json` | `~/.claude/.credentials.json` |
| `stateDir` | barnowl のカタログ・pid・ログ・画像 | — | `~/.barnowl` |

各キーは環境変数でも指定できます（ファイルより優先）:
`BARNOWL_CLAUDE_BIN`、`BARNOWL_CODEX_BIN`、`BARNOWL_PYTHON`、`CODEX_HOME`、
`BARNOWL_CLAUDE_KEYCHAIN_ACCOUNT`、`BARNOWL_CLAUDE_CREDENTIALS_FILE`、
`BARNOWL_STATE_DIR`。
```

- [ ] **Step 7: Commit**

```bash
git add README.md README.ja.md
git commit -m "Docs: live model list, revoked-login recovery, AI-agent path setup

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: End-to-end verification + fresh install

No new code. Every command runs from the repo root. Spare ports and isolated state dirs keep the user's running server (port 11435, `~/.barnowl`) untouched until Step 6. Report each expected/actual pair. If any step fails, stop and report instead of patching around it.

- [ ] **Step 1: Suite**

Run: `npm test`
Expected: PASS, 0 failures.

- [ ] **Step 2: Claude revoked (bogus token) on :11499**

```bash
S2=$(mktemp -d)
BARNOWL_STATE_DIR=$S2 CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-bogus node bin/barnowl.js start -p 11499 --no-update
curl -s localhost:11499/v1/models | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).data.map(m=>m.id).join(" ")))'
curl -s -w '\nHTTP %{http_code}\n' localhost:11499/v1/chat/completions -H 'Content-Type: application/json' -d '{"model":"sonnet","messages":[{"role":"user","content":"hi"}]}'
curl -sN localhost:11499/v1/chat/completions -H 'Content-Type: application/json' -d '{"model":"sonnet","stream":true,"messages":[{"role":"user","content":"hi"}]}' | tail -3
for i in 1 2 3 4 5 6; do curl -s -o /dev/null -w '%{http_code} ' localhost:11499/v1/chat/completions -H 'Content-Type: application/json' -d '{"model":"sonnet","messages":[{"role":"user","content":"hi"}]}'; done; echo
curl -s localhost:11499/api/status | grep -i -o '"circuit[^,}]*'
curl -s -w '\nHTTP %{http_code}\n' localhost:11499/v1/chat/completions -H 'Content-Type: application/json' -d '{"model":"gpt-5.6-luna","messages":[{"role":"user","content":"Reply with exactly: ok"}]}'
BARNOWL_STATE_DIR=$S2 node bin/barnowl.js stop -p 11499
```
Expected:
- start prints `Auth     : claude revoked · codex ok` and `WARN: Claude login revoked — run: barnowl login claude`
- `/v1/models` lists only Codex ids
- non-stream: `HTTP 401` with a body message containing `barnowl login claude`
- stream: a `data: {"error":{…"type":"authentication_error"…}}` chunk, then `data: [DONE]`
- six `401`s, and the circuit state is still closed. If the status JSON has no circuit field, note that.
- Codex request `HTTP 200` with content `ok`

- [ ] **Step 3: Codex revoked (bogus auth.json) on :11498**

```bash
S3=$(mktemp -d); CH=$(mktemp -d)
node -e '
const a = require(process.env.HOME + "/.codex/auth.json");
const bad = JSON.parse(JSON.stringify(a));
bad.tokens.access_token = a.tokens.access_token.split(".").slice(0, 2).join(".") + ".invalidsig";
bad.tokens.id_token = a.tokens.id_token.split(".").slice(0, 2).join(".") + ".invalidsig";
bad.tokens.refresh_token = "rt_invalid";
require("fs").writeFileSync(process.argv[1] + "/auth.json", JSON.stringify(bad), { mode: 0o600 });' "$CH"
BARNOWL_STATE_DIR=$S3 CODEX_HOME=$CH node bin/barnowl.js start -p 11498 --no-update
curl -s -w '\nHTTP %{http_code}\n' localhost:11498/v1/chat/completions -H 'Content-Type: application/json' -d '{"model":"gpt-5.6-luna","messages":[{"role":"user","content":"hi"}]}'
curl -s localhost:11498/v1/models | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).data.map(m=>m.id).join(" ")))'
curl -s -w '\nHTTP %{http_code}\n' localhost:11498/v1/chat/completions -H 'Content-Type: application/json' -d '{"model":"sonnet","messages":[{"role":"user","content":"Reply with exactly: ok"}]}'
BARNOWL_STATE_DIR=$S3 node bin/barnowl.js stop -p 11498
```
Expected: start shows `codex revoked`. The Codex request gives `HTTP 401` with `barnowl login codex`. `/v1/models` lists only Claude ids. The Claude request gives `HTTP 200`. The real `~/.codex/auth.json` is untouched: `CODEX_HOME` points at the temp copy.

- [ ] **Step 4: Auto-recovery on :11497**

```bash
S4=$(mktemp -d)
BARNOWL_STATE_DIR=$S4 node bin/barnowl.js start -p 11497 --no-update
node -e 'const f=process.argv[1]+"/catalog.json";const c=JSON.parse(require("fs").readFileSync(f));c.providers.claude.status="revoked";require("fs").writeFileSync(f,JSON.stringify(c))' "$S4"
sleep 4; curl -s localhost:11497/v1/models | grep -c '"sonnet"'
curl -s -o /dev/null -w 'HTTP %{http_code}\n' localhost:11497/v1/chat/completions -H 'Content-Type: application/json' -d '{"model":"sonnet","messages":[{"role":"user","content":"Reply with exactly: ok"}]}'
sleep 4; curl -s localhost:11497/v1/models | grep -c '"sonnet"'
BARNOWL_STATE_DIR=$S4 node bin/barnowl.js status -p 11497 | tail -3
BARNOWL_STATE_DIR=$S4 node bin/barnowl.js stop -p 11497
```
Expected: the first count is `0`, then `HTTP 200`, then the count is `1`. `status` shows `claude  ok`.

- [ ] **Step 5: Live list sanity on :11497 data** — from Step 4's start output, `Models   : Claude <n> · Codex 4` with n ≥ 10 and `Auth     : claude ok · codex ok`. One `[1m]` id and one Codex id answer:

```bash
S5=$(mktemp -d); BARNOWL_STATE_DIR=$S5 node bin/barnowl.js start -p 11496 --no-update
for m in 'claude-opus-5[1m]' gpt-5.6-terra; do curl -s -o /dev/null -w "$m %{http_code}\n" localhost:11496/v1/chat/completions -H 'Content-Type: application/json' -d "{\"model\":\"$m\",\"messages\":[{\"role\":\"user\",\"content\":\"Reply with exactly: ok\"}]}"; done
BARNOWL_STATE_DIR=$S5 node bin/barnowl.js stop -p 11496
```
Expected: both `200`.

- [ ] **Step 5b: Per-user paths through a config file on :11495**

```bash
S6=$(mktemp -d); CFG=$S6/cfg.json
printf '{"paths":{"stateDir":"%s/state","claudeBin":"%s","codexBin":"%s"}}\n' "$S6" "$(which claude)" "$(which codex)" > "$CFG"
node bin/barnowl.js start -p 11495 --no-update --config "$CFG"
ls "$S6/state"
curl -s -o /dev/null -w 'sonnet %{http_code}\n' localhost:11495/v1/chat/completions -H 'Content-Type: application/json' -d '{"model":"sonnet","messages":[{"role":"user","content":"Reply with exactly: ok"}]}'
node bin/barnowl.js stop -p 11495 --config "$CFG"
```
Expected: `ls` shows `barnowl.log`, `barnowl.pid` and `catalog.json` inside `$S6/state` (not `~/.barnowl`), and the request gives `sonnet 200`.

- [ ] **Step 6: Fresh otterly + the real server** (restarts the user's local server on :11435 — a few seconds of downtime. `rm -rf node_modules` discards the hand-edited `models.js`, which these patches supersede.)

```bash
rm -rf node_modules && npm install 2>&1 | grep -i barnowl
npm test
grep -c "barnowl: live model catalog\|DEFAULT_MODEL = \"sonnet\"" node_modules/otterly/dist/server/models.js
node bin/barnowl.js restart
node bin/barnowl.js verify
```
Expected:
- install logs `[barnowl] patched otterly …`
- tests PASS
- the grep count is `2`
- restart prints the Models/Auth lines with both `ok`. It also prints `Auto-update skipped: branch is not main`, which is expected on this branch.
- `verify` ends in `OK`, and `[2/3]` lists the live ids

- [ ] **Step 7: Report** — summarise each step's result (pass/fail with the observed output) in the final task report. Commit nothing unless a fix was needed and reviewed.
