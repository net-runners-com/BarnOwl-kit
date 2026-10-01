# Plugins + `usage` plugin (user identification, per-user usage log) — design

Date: 2026-10-01 · Status: draft, awaiting review

## Goal

An organization running barnowl wants to know who used it, when, with which
model and tools, and how many tokens each person consumed.

1. Add an opt-in plugin mechanism to barnowl. With no `plugins` config the
   server behaves exactly as today.
2. Ship one plugin, `usage`, in this repo. It identifies the caller by an
   admin-issued key, records one metadata line per request, and aggregates
   per user from the CLI.
3. Cover both ways into barnowl, tagged in every record:
   - `native`: `POST /v1/messages`, the anthropic passthrough that Claude Code
     uses through `ANTHROPIC_BASE_URL`.
   - `api`: the engine routes (`/v1/chat/completions`, `/api/chat`,
     `/api/generate`, `/api/run`, `/api/stream`) where barnowl spawns the CLI.
4. Document the passthrough as a first-class way to use barnowl: "use Claude
   Code's own chat screen through barnowl".

Naming note: the `native` tag means "Claude Code's native protocol". It is not
otterly's "Native API" (`/api/run`), which is tagged `api`.

Out of scope: a web dashboard or any HTTP endpoint exposing usage (the live
server sits behind a public tunnel; needs an auth decision first), per-user
quotas and kill switch, storing prompt or response text, `/ws`, masking of the
log itself, central collection across machines.

`/v1/images/generations` goes through the same engine-route hook, so it gets
the key check and an `api` record (no token counts).

## Data sources (verified 2026-10-01, Claude Code 2.1.286)

Captured from a real Claude Code request pointed at a local dump server:

| what | where | notes |
| --- | --- | --- |
| admin key | request header `x-barnowl-key` | Claude Code sends extra headers from `ANTHROPIC_CUSTOM_HEADERS="X-Barnowl-Key: <key>"`; verified to arrive |
| device, account, session | body `metadata.user_id`, a JSON string `{"device_id","account_uuid","session_id"}` | `native` only. `account_uuid` is the logged-in Claude account, so a shared account looks like one user; hence the key |
| tokens, `native` streaming | upstream SSE: `message_start.message.usage` (`input_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`), last `message_delta.usage.output_tokens` | |
| tokens, `native` non-streaming | upstream JSON `usage` | |
| tools, `native` | `content_block_start` events / `content[]` blocks with `type: "tool_use"`, field `name` | names only |
| tokens, `api` | the object every engine route passes to `metrics.record(...)` (`inputTokens`, `outputTokens`, `toolCalls`) | cache tokens are not available there; recorded as `null` |

## Components

### `lib/plugins.cjs` (new)

Loads plugins once per process and runs their hooks.

- Config: `"plugins": { "<name-or-path>": { ...options } }`. A bare name
  resolves to `plugins/<name>/index.cjs` in this repo; anything containing a
  path separator is resolved as a file path (`~` expanded). An option of
  `false` skips that plugin. Env `BARNOWL_PLUGINS` carries the JSON of the
  block from the CLI to the server process, like the guard config does.
- A plugin is a CommonJS module exporting `{ name, init(options, ctx), onRequest?, onComplete?, cli? }`.
  `ctx` is `{ stateDir, log }`.
- `enabled()` is true when at least one plugin loaded.
- `begin({ route, path, headers, body })` runs every `onRequest` in config
  order. A hook returns nothing, or `{ identity }` to attach fields to the
  record, or `{ reject: { status, type, message } }`. The first reject wins.
  A hook that throws rejects the request with `500 plugin_error`
  (fail-closed). `begin` returns `{ ok, reject?, call }`.
- `call.stripHeaders` lists request headers plugins asked to remove before
  forwarding (the usage plugin lists `x-barnowl-key`).
- `call.finish(fields)` builds the final record and runs every `onComplete`.
  It runs at most once per call. A throwing `onComplete` is logged and
  swallowed: the response has already been sent.
- A plugin that fails to load makes `barnowl start` exit non-zero with the
  reason. A configured plugin is never silently skipped.

### `lib/guard.cjs` — `handleMessages` (changed)

Order becomes: read body → parse JSON when the guard or plugins are enabled →
`plugins.begin` → guard → forward → `call.finish`.

- Identification runs before the guard so a blocked request is still
  attributed to a user (`outcome: "blocked"`).
- `stripHeaders` are removed from the forwarded headers. The barnowl key never
  reaches the upstream.
- The response is still streamed through untouched. A tap parses a copy of the
  chunks: SSE when `content-type` is `text/event-stream`, otherwise JSON once
  the body ends. Tap failures never affect the response; the record then
  carries `null` token fields.
- `finish` fields: `status`, `outcome` (`ok` | `blocked` | `rejected` |
  `upstream_error` for a non-2xx upstream or an unreachable upstream),
  `durationMs`, token counts, `tools`, `stream`.

### otterly patches (`lib/patch-otterly.js`)

Two additions, both no-ops when no plugin is loaded:

1. `server/index.js`, engine routes, before the guard block: call
   `plugins.begin({ route: "api", ... })`; on reject answer in the route's
   error shape and return. Otherwise run the rest of the request inside an
   `AsyncLocalStorage` scope holding `call`, and call `call.finish` when the
   response closes (`res.on("close")`) with the status code and duration.
2. `server/metrics.js`, `Metrics.record(run)`: forward `run` to the current
   scope's `call` so `finish` has `inputTokens`, `outputTokens`, `toolCalls`.
   Concurrent requests stay separated because the scope is per request.

### `plugins/usage/` (new)

`index.cjs` wires three small modules.

**`keys.cjs` — key store.** File `<stateDir>/usage/keys.json`:
`{ "keys": [{ "user", "hash", "createdAt", "revokedAt" }] }`. A key is
`bo_` + 32 random bytes in base64url. Only its SHA-256 is stored; the key is
shown once on creation. Lookup compares hashes with `timingSafeEqual`. The
file is re-read when its mtime changes, so `key add` / `key revoke` take
effect without a restart. A user may hold several active keys.

**`onRequest`.** Reads `x-barnowl-key`.
- valid key → `identity.user`.
- missing, unknown or revoked → reject `401 authentication_error` with
  `"barnowl: missing or invalid X-Barnowl-Key (ask your administrator)"`.
  The rejected request is still recorded (`outcome: "rejected"`, `user: null`).
- option `requireKey: false` records such requests as `user: "unknown"` and
  lets them through. Default `true`.
- On `native`, parses `metadata.user_id` and adds `deviceId`, `accountUuid`,
  `sessionId` when present. Unparseable metadata is ignored.

**`records.cjs` — log.** `onComplete` appends one JSON line to
`<stateDir>/usage/YYYY-MM-DD.jsonl` (local date), creating the directory with
mode 0700 and files with 0600:

```json
{ "ts": "2026-10-01T12:39:52.451Z", "route": "native", "path": "/v1/messages",
  "user": "sato", "deviceId": "…", "accountUuid": "…", "sessionId": "…",
  "model": "claude-haiku-4-5-20251001", "stream": true,
  "status": 200, "outcome": "ok", "durationMs": 1646,
  "inputTokens": 12, "outputTokens": 40,
  "cacheCreationTokens": 0, "cacheReadTokens": 0,
  "tools": ["Read", "Bash"] }
```

No prompt text, no response text, no key. On `api`, the device/account/session
and cache fields are `null` and `tools` is `null` (`toolCalls` count is kept
as `toolCalls`).

**`report.cjs` — aggregation.** Reads the day files in a date range and groups
by `user`, then by `route`. Per group: requests, blocked, rejected, errors,
input / output / cache-creation / cache-read tokens, distinct devices,
distinct sessions, active minutes. Each record is the interval
`[ts, ts + durationMs]`; within one session, intervals separated by 5 minutes
or less are merged into one span, and active time is the total length of the
spans. On `api`, where there is no session id, records are grouped per user
per local day instead.

### `bin/barnowl.js`

- `barnowl usage [--days N | --from YYYY-MM-DD --to YYYY-MM-DD] [--json]`
  prints the per-user table (default: last 7 days).
- `barnowl usage key add <user>` · `key revoke <user>` (revokes all of that
  user's active keys) · `key list` (user, created, revoked; never the key).
- `barnowl config` shows the `plugins` block; `barnowl start` prints
  `Plugins : usage` when any are loaded.
- Subcommands come from the plugin's `cli` export, so `barnowl usage` exists
  only when the plugin is configured; otherwise it prints how to enable it.

### READMEs (`README.md`, `README.ja.md`)

New section "Use Claude Code's chat screen through barnowl" placed before the
guard section:

- what it is: Claude Code keeps running on the user's machine with their own
  login; barnowl forwards each request to the anthropic upstream and never
  spawns a CLI on this path. No API key is involved; a subscription login was
  verified.
- setup: `ANTHROPIC_BASE_URL=http://localhost:11435`, as an env var or in
  Claude Code's `settings.json` `env` block.
- what changes for the user: nothing unless the guard is on (then text is
  masked and images are refused; the refusal shows up in Claude Code as an
  API error).
- a two-route table (`native` vs `api`).

New section "Plugins" with the `usage` plugin: enabling it, issuing a key,
the client-side `ANTHROPIC_CUSTOM_HEADERS` line, `barnowl usage`, what is and
is not recorded, and that `requireKey` also locks the engine routes.

## Error handling

| situation | behaviour |
| --- | --- |
| plugin fails to load | `barnowl start` fails with the reason |
| `onRequest` throws | request rejected, `500 plugin_error` |
| key file missing or unreadable with `requireKey: true` | every request rejected `401` (no key can match); logged once per mtime |
| log append fails | logged to `barnowl.log`; the response is unaffected |
| response tap cannot parse | record written with `null` token fields |
| client disconnects mid-stream | record written with what was seen so far, `outcome` from the upstream status |

## Testing

`node --test`, same style as `test/guard.test.js`.

- `plugins.test.js`: load by name and by path, hook order, first reject wins,
  throwing `onRequest` rejects, throwing `onComplete` is swallowed, `finish`
  runs once, disabled when unconfigured.
- `usage-keys.test.js`: add / verify / revoke, only the hash on disk, reload
  on mtime change, several keys per user.
- `usage-records.test.js`: SSE tap (tokens and tool names across split
  chunks), JSON tap, record shape, file modes, no body text in the record.
- `usage-report.test.js`: grouping by user and route, date range, active
  minutes, blocked / rejected counts.
- `guard.test.js` additions against the existing mock upstream: no key → 401
  and the upstream is not called; valid key → forwarded without
  `x-barnowl-key`; guard-blocked request recorded with the user;
  `requireKey: false` passes as `unknown`.
- `patch-otterly.test.js` additions: both new patches apply and are
  idempotent.
- E2E on an isolated state dir and port: real Claude Code through
  `ANTHROPIC_BASE_URL` with a key, one prompt, then `barnowl usage --json`
  shows the user with non-zero tokens; one `/v1/chat/completions` request
  shows up under `api`.
