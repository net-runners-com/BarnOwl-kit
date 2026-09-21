# Live model catalog + auth-revoke handling — design

Date: 2026-09-21 · Status: approved in chat

## Goal

1. `GET /v1/models` (and Ollama `/api/tags`) should list the models the
   current Claude and Codex logins can actually use, refreshed on every
   `barnowl start`, instead of a hand-maintained static list.
2. When a login is revoked (or otherwise stops authenticating), barnowl should
   say so clearly: HTTP 401 with the fix, the dead provider's models hidden,
   `barnowl status` showing it, and `barnowl login <provider>` to recover
   without a restart.

Today a revoked Claude login comes back as **HTTP 200** whose assistant text is
`Failed to authenticate. API Error: 401 …`: the CLI reports it as
`subtype: "success", is_error: true` and otterly's `events.js` only looks at
`subtype`.

Out of scope: desktop notifications (declined), refreshing while the server
runs, deriving Codex effort limits from the API, short-circuiting requests to a
revoked provider, refreshing OAuth tokens ourselves, touching the stale
`acct=unknown` keychain entry.

## Data sources (verified 2026-09-21)

| provider | credential | endpoint | notes |
| --- | --- | --- | --- |
| Claude | `CLAUDE_CODE_OAUTH_TOKEN` env › macOS keychain `Claude Code-credentials` **acct = OS username** › `~/.claude/.credentials.json` | `GET https://api.anthropic.com/v1/models?limit=100` with `Authorization: Bearer`, `anthropic-version: 2023-06-01`, `anthropic-beta: oauth-2025-04-20` | returns `id`, `display_name`, `max_input_tokens`. Revoked → 401 `authentication_error`. The keychain also holds an old `acct=unknown` entry whose token is revoked — reading it would be a false alarm. Access tokens live ~8 h (`expiresAt`). |
| Codex | `~/.codex/auth.json` (`tokens.access_token`, `tokens.account_id`; expiry from the JWT `exp`) | `GET https://chatgpt.com/backend-api/codex/models?client_version=<v>` with `Authorization: Bearer`, `chatgpt-account-id` | returns `slug`, `display_name`, `visibility`, `priority`, `context_window`. `<v>` = `client_version` from `~/.codex/models_cache.json`, else parsed from `codex --version`. |

## Components

### Modules (new)

Split three ways to avoid require cycles with `codex-engine.cjs`:

- `lib/auth-errors.cjs`: pure helpers `isAuthError`, `authMessage`, `authError`.
- `lib/model-catalog.cjs`: discovery and catalog-file I/O. The CLI uses it.
- `lib/auth-state.cjs`: the "Runtime state" below, loaded inside the server.

The state dir is `$BARNOWL_STATE_DIR`, else `~/.barnowl`. It holds the
catalog, pid and log, so an isolated E2E server can run beside the real one.

### `lib/model-catalog.cjs`

Every I/O dependency (fetch, spawn, keychain
reader, file paths, clock) is injectable for tests. Never throws to callers.

**Catalog file** `~/.barnowl/catalog.json` (outside the repo so auto-update's
clean-tree check is unaffected; written atomically via tmp + rename):

```json
{
  "version": 1,
  "refreshedAt": "2026-09-21T05:00:00Z",
  "providers": {
    "claude": { "status": "ok", "checkedAt": "…", "message": "", "models": [{ "id": "sonnet", "label": "…", "contextWindow": 200000 }] },
    "codex":  { "status": "revoked", "checkedAt": "…", "message": "…", "models": [ … ] }
  }
}
```

`status`: `ok` · `revoked` (401 from API, probe, or a request) · `logged_out`
(no credential) · `unknown` (network error / timeout — previous `models` kept).
`models` absent ⇒ that provider falls back to the static entries.

**Refresh** `refreshCatalog()` — both providers in parallel:

- Claude
  - no credential → `logged_out` if `claude auth status --json` says
    `loggedIn: false`, else `unknown`
  - token expired → probe first: `claude -p ok --model haiku` with
    `--output-format stream-json --verbose --strict-mcp-config
    --setting-sources ""` (30 s cap). The CLI refreshes the token as a side
    effect; a result with `is_error` and a 401 → `revoked`. On success re-read
    the credential and continue.
  - fetch (5 s) → 200 `ok` · 401 `revoked` · anything else `unknown`.
- Codex
  - no `auth.json` / no tokens → `logged_out` if `codex login status` exits
    non-zero, else `unknown`
  - token expired → `unknown`, keep previous models (the first real request
    refreshes it; the token lives ~10 days)
  - fetch (5 s) → 200 `ok` · 401 `revoked` · else `unknown`.

**Building the lists**

- Claude: aliases `sonnet`, `opus`, `haiku`, `fable`, `default` first; then
  every API model in API order (newest first) except `deprecatedIds` from
  `config/models.json`, labelled with `display_name`, `contextWindow =
  min(max_input_tokens, 200000)`; a model with `max_input_tokens ≥ 1000000`
  is followed by `<id>[1m]` with `contextWindow 1000000`.
- Codex: `codex` alias (label "OpenAI Codex (Codex CLI default)") then models
  with `visibility === "list"` sorted by `priority`, labelled
  `Codex <display_name>`, `contextWindow = context_window`.

**Runtime state** (server process)

- `bind(MODELS)` — snapshots the static entries (split by provider with
  `isCodexModel`), applies the catalog to the array **in place** (ok/unknown →
  catalog models or static fallback; revoked/logged_out → none), and
  re-applies on `fs.watchFile` changes. Array identity is preserved, so
  `buildModelsList()` / `buildOllamaTags()` pick it up with no other patch.
  No catalog file → the array is left untouched.
- `onAuthFailure(provider, message)` — if the in-memory status is not already
  `revoked`, write `revoked` + message to the file and re-apply.
- `onAuthSuccess(provider)` — if the in-memory status is `revoked` /
  `logged_out`, write `ok` and re-apply (restores the last known models). Pure
  in-memory check on the hot path; the file is only written on a transition.
- `isAuthError(text)` — `401`, `authentication`, `oauth … (revoked|invalid|
  expired)`, `unauthorized`, `refresh token`, `log in again` / `sign in again`,
  `please run /login` (case-insensitive). Rate-limit / billing text is not an
  auth error.

### otterly patches (`lib/patch-otterly.js`)

Same marker/anchor mechanism as today.

1. **`server/models.js` — live catalog.** Import `lib/auth-state.cjs` via
   `createRequire` (as the warm pool does) and call `bind(MODELS)` before
   `findModel`. Anchor chosen to survive the hand-edited copy on this machine.
2. **`events.js` — `is_error` results are errors.** `result` with
   `is_error: true` → `error` event. Auth (`api_error_status === 401` or
   `isAuthError(result)`) → `AgentError("NOT_AUTHENTICATED", <auth message>)`
   plus `onAuthFailure("claude")`; otherwise `Error(result)`. A successful
   result calls `onAuthSuccess("claude")`. Assistant events carrying an
   `error` field (the CLI's synthetic "Failed to authenticate…" message) are
   dropped so that text is never relayed as content.
3. **`routes-openai.js` — breaker code for non-otterly errors.** The
   `err instanceof AgentError ? err.code : undefined` sites also honour
   `err.barnowlCode`, so Codex auth errors do not trip the circuit breaker.
4. **`routes-openai.js` — typed stream errors.** Upstream already sends a
   `data: {"error": …}` chunk + `[DONE]` when a stream fails, but always as
   `server_error`; use `openaiErrorBody(errorToHttpStatus(e), …)` so a dead
   login streams `authentication_error` (code 401).
5. **PR #1 folded in** (re-implemented on the current patch layout — the
   branch predates the Codex migration and does not cherry-pick; PR closed as
   superseded):
   `DEFAULT_MODEL = "sonnet"`, the `body.model ||` fallback → `sonnet`
   (including a migration for the already-patched effort line), and the
   refreshed static list used when no catalog exists yet.

Auth message (used for both providers):
`<Provider> authentication failed — the login was revoked or has expired. Run
\`barnowl login <provider>\` (no restart needed).` It contains
"authentication", so `errorToHttpStatus` maps it to **401**.

### `lib/warm-sessions.cjs`, `lib/codex-engine.cjs`, `lib/image-gen.cjs`

- Warm pool: a failed turn already falls back to the one-shot `--resume`
  path, where the `events.js` patch produces the 401; the pool only reports
  `onAuthSuccess("claude")` on a good turn.
- Codex engine + image gen: on non-zero exit with `isAuthError(stderr)` →
  throw the auth message with `barnowlCode = "NOT_AUTHENTICATED"` and call
  `onAuthFailure("codex")`; on exit 0 call `onAuthSuccess("codex")`.

### `bin/barnowl.js`

- `start`: after `ensurePatched()`, when no server is running, run
  `refreshCatalog()` and print
  `Models   : Claude 16 · Codex 4` and `Auth     : claude ok · codex ok`.
  A `revoked` / `logged_out` provider prints
  `WARN: Claude login revoked — run: barnowl login claude`; the server still
  starts (the other provider may work).
- `login [claude|codex]` (new): runs `claude auth login` / `codex login` with
  inherited stdio, then `refreshCatalog()` and prints the result. The running
  server picks the new catalog up through `watchFile`. No argument → every
  provider not `ok`; if all are ok, say so and exit 0.
- `status`: adds an `Auth` block (status, checkedAt, message per provider) read
  from the catalog, shown even when the server is unreachable.
- `models`: prints the catalog's lists per provider with status; falls back to
  `config/models.json` when there is no catalog.
- Help text updated.

Revoked providers are still routed to their CLI, so a login fixed outside
barnowl (e.g. in Claude Code itself) is noticed by the next successful request.
The cost is a few seconds per failing request.

## Testing

`test/model-catalog.test.js` (`node:test`, fixtures + injected I/O):

- Claude list: aliases first, API order, `deprecatedIds` removed, `[1m]` after
  1M-capable models only, context windows.
- Codex list: only `visibility: list`, priority order, `codex` alias.
- Credential selection: env wins; keychain read with acct = username; file
  fallback off macOS; missing → `logged_out`.
- Refresh: 200 → ok, 401 → revoked, network error → unknown with previous
  models kept; expired Claude token triggers the probe; probe 401 → revoked.
- `bind`: in-place mutation, revoked hides a provider, absent provider keeps
  static entries, no file → untouched, `onAuthFailure` / `onAuthSuccess`
  transitions write only on change.
- `isAuthError`: the real Claude CLI strings, Codex 401 / refresh-token
  strings; rate-limit text is negative.

Manual E2E on a spare port:

- `barnowl start` prints the model/auth lines; `/v1/models` matches the live
  API lists; one `[1m]` id and one Codex id answer.
- `CLAUDE_CODE_OAUTH_TOKEN=<bogus> barnowl start -p <port>`: startup shows
  revoked; a Claude request → 401 with the login hint (non-stream and stream);
  Claude ids gone from `/v1/models`; Codex still works; breaker stays closed
  after 6 failures.
- Codex: the same with a temp `CODEX_HOME` holding a bogus `auth.json` →
  Codex request 401, Codex ids hidden, Claude unaffected.
- Auto-recovery: on a normally started server, set `claude.status` to
  `revoked` in the catalog (ids disappear via `watchFile`), send one Claude
  request → status back to `ok`, ids back.
- `rm -rf node_modules && npm install` → all patches re-apply on a fresh
  otterly.
