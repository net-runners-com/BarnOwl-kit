# barnowl

[日本語版 README はこちら → README.ja.md](README.ja.md)

Fast, OpenAI-compatible **local Claude + Codex server**.

Point Cursor, Aider, Continue, or any OpenAI SDK at it and use `sonnet` /
`opus` / `haiku` / `fable` — or `gpt-5.6-terra` and friends through your
ChatGPT login. Codex models can also **generate images**
(`/v1/images/generations`).

## Install

```bash
npm install -g barnowl      # or: npx barnowl <cmd>
```

Requires the `claude` CLI on your PATH (Claude Code) and a working login.
For `gpt-*` models and image generation, also install the `codex` CLI and
log in with your ChatGPT account (`codex login`).

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

## Usage

```bash
barnowl start                 # start on port 11435 (fast chat, no MCP)
barnowl start --mcp sheet     # load ONLY the "sheet" MCP profile (server-side tools)
barnowl start -p 8080 -d ~/x  # custom port / working dir
barnowl start --no-update     # skip the GitHub update check
barnowl verify                # end-to-end check + latency
barnowl status                # health JSON
barnowl stop
barnowl restart
barnowl models                # live model list per login
barnowl login [claude|codex]  # re-login after a revoked / expired login (no restart)
```

**Auto-update.** When barnowl runs from a git clone, every `start` (and
`restart`) fetches `origin/main` and fast-forwards before the server
launches, so model-lineup fixes merged on GitHub reach you without a manual
pull (`npm install` runs too when dependencies changed). It only touches a
clean `main` checkout; another branch, local edits or an offline fetch just
print `Auto-update skipped: …` and start as-is. npm-registry installs are
left alone.

## Client setup

| Setting  | Value                        |
| -------- | ---------------------------- |
| Base URL | `http://localhost:11435/v1`  |
| API key  | any string (auth off unless `BARNOWL_API_KEY` is set) |
| Models   | `sonnet` · `opus` · `haiku` · `fable` · `gpt-5.6-terra` · … |

```bash
curl http://localhost:11435/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"sonnet","messages":[{"role":"user","content":"hi"}]}'
```

## Models

Two engine families behind one endpoint — routing is automatic by model id
(`gpt*`/`codex` → Codex CLI, everything else → Claude CLI):

| Family | Model ids | Auth |
| --- | --- | --- |
| Claude | `sonnet` (default) · `opus` · `haiku` · `fable` · `claude-fable-5-1` · `claude-opus-5` · `claude-opus-5[1m]` (1M context) · `claude-sonnet-5` · `claude-sonnet-5[1m]` (1M context) · `claude-opus-4-8` · `claude-sonnet-4-6` | Claude Code login |
| Codex | `codex` (CLI default = `gpt-5.6-terra`) · `gpt-5.6-terra` · `gpt-5.6-luna` · `gpt-5.5` | ChatGPT login (`codex login`) |

The aliases track the CLI's current models: `fable` → Fable 5.1, `opus` →
Opus 5, `sonnet` → Sonnet 5, `haiku` → Haiku 4.5. The `[1m]` ids are the
1M-token context variants — same id you pass to the `claude` CLI, brackets
included.

Retired: `claude-fable-5` (now refuses even trivial prompts — use `fable` /
`claude-fable-5-1`) and `gpt-5.6-sol` / `gpt-5.4` / `gpt-5.4-mini` (the
ChatGPT backend answers 400 "not supported").

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

**Reasoning effort** — append `:<effort>` to any model id, or send the
OpenAI `reasoning_effort` field:

```bash
-d '{"model":"gpt-5.5:high", ...}'          # or "sonnet:xhigh"
-d '{"model":"gpt-5.6-terra","reasoning_effort":"low", ...}'
```

Accepted levels are clamped per model automatically (anything above a
model's ceiling becomes its highest level; `minimal`→`none`):

| Family | Levels |
| --- | --- |
| Claude | `low` `medium` `high` `xhigh` `max` |
| Codex gpt-5.6-terra | `none` `low` `medium` `high` `xhigh` `max` `ultra` |
| Codex gpt-5.6-luna | `none` `low` `medium` `high` `xhigh` `max` |
| Codex gpt-5.5 | `none` `low` `medium` `high` `xhigh` |

`ultra` is Codex's max reasoning plus automatic task delegation. The Claude
CLI ignores values outside its list (`none`, `ultra`, …) and runs at its
default effort.

## Request parameters — what actually works

The backends are agent CLIs, not raw APIs, so OpenAI sampling params are
**not** universally supported. Verified behaviour:

| Param | Claude models | Codex models |
| --- | --- | --- |
| `temperature` | ✅ real sampling control | ignored (backend rejects it) |
| `top_p` | ✅ | ignored |
| `stop` / `stop_sequences` | ✅ (server-side truncation) | ignored |
| `reasoning_effort` / `:suffix` | ✅ | ✅ |
| `verbosity` (`low`/`medium`/`high`) | ignored | ✅ response-length steering |
| `response_format: {"type":"json_object"}` | prompt-injected (output may still be ```-fenced — strip fences client-side) | prompt-injected (returns raw JSON) |
| `max_tokens`, `n`, `seed`, penalties, `logit_bias`, `logprobs`, `user` | ignored | ignored |

Notes:

- Claude sampling works by injecting `CLAUDE_CODE_EXTRA_BODY` into the CLI's
  API request. Extended thinking is auto-disabled on such requests (the API
  only allows `temperature: 1` while thinking) — expect slightly different
  behaviour from default requests. `temperature: 0` gives deterministic
  output.
- The ChatGPT-Codex backend rejects sampling controls outright
  (`Unsupported parameter: temperature`), so there is nothing to wire on
  that path. Use `reasoning_effort` and `verbosity` instead — measured
  `verbosity` swing on the same prompt: low ≈ 0.9 KB, medium ≈ 1.4 KB,
  high ≈ 2–5 KB.

```bash
# deterministic Claude output
curl http://localhost:11435/v1/chat/completions -H "Content-Type: application/json" \
  -d '{"model":"haiku","temperature":0,"messages":[{"role":"user","content":"..."}]}'

# short Codex answer
curl http://localhost:11435/v1/chat/completions -H "Content-Type: application/json" \
  -d '{"model":"gpt-5.6-terra","verbosity":"low","messages":[{"role":"user","content":"..."}]}'
```

## Image generation (Codex models)

`POST /v1/images/generations` — OpenAI Images API shape, served by Codex
CLI's built-in `image_generation` tool through your ChatGPT subscription
(no API billing). Claude models cannot generate images (400).

```bash
curl http://localhost:11435/v1/images/generations -H "Content-Type: application/json" -d '{
  "model": "gpt-5.6-terra",
  "prompt": "A watercolor barn owl in flight over a moonlit wheat field",
  "size": "1536x1024",
  "quality": "hd"
}'
```

| Field | Meaning |
| --- | --- |
| `prompt` | required — image description (Japanese text renders correctly) |
| `model` | any Codex model (default `codex`) |
| `size` | e.g. `1024x1024` · `1536x1024` · `1024x1536` (no hint → 1254×1254) |
| `quality` | `standard` (default) or `hd` |
| `n` | 1–4 images, generated sequentially |
| `image` | *(non-standard)* local path to a reference image to edit |

Response: `{ "created": ..., "data": [{ "b64_json": "...", "path": "..." }] }`
— `path` (non-standard) is a saved copy under `~/.barnowl/images/`.

The tool has no size/quality parameters of its own — barnowl steers them
via the prompt, which the model follows exactly (verified: `1536x1024`
request → 1536×1024 PNG). Generation takes ~2–3 min (standard square) to
~5–6 min (HD landscape); the route uses a 10-minute window
(`BARNOWL_IMAGE_TIMEOUT_MS` overrides the per-run kill).

Generation is routed through a vendored copy of
[codex-image](https://github.com/Leon-llb/codex-image) (`vendor/codex-image`,
MIT) with barnowl extensions: `--model`/`--quality` passthrough, a
general-purpose prompt template, and clean codex flags.

## Sessions (conversation continuity)

Requests are stateless by default — each one starts a fresh conversation.
Sessions add two things on top:

1. **Continuity** — pass a session id and the conversation continues with
   full context, without resending history in `messages`.
2. **Speed** — session turns are served by a **warm process pool**: a live
   `claude` process pinned to the session answers in pure model time, with no
   per-request process startup.

Measured on a typical setup:

| Turn | Path | Latency |
| --- | --- | --- |
| Turn 1 (new conversation) | one-shot spawn | ~4–8s |
| Turn 2 (first turn on a session) | resume into a live process | ~4s |
| Turn 3+ (warm) | stdin of the live process | **~1.8–2.5s** |

### Using sessions

**Turn 1 — create.** Send a normal request. Every response carries the session
id three ways: the body (`session_id`), the `X-Session-Id` header, and — when
streaming — the final chunk (the one with `finish_reason: "stop"`).

```bash
curl -s http://localhost:11435/v1/chat/completions -H "Content-Type: application/json" \
  -d '{"model":"sonnet","messages":[{"role":"user","content":"My name is Hiro."}]}'
# → { ..., "session_id": "bac390a4-..." }
```

**Turn 2+ — resume.** Pass the id in the body (`session_id`) or the
`X-Session-Id` header. Send **only the new message** — the server already has
the context:

```bash
curl -s http://localhost:11435/v1/chat/completions -H "Content-Type: application/json" \
  -d '{"model":"sonnet","session_id":"bac390a4-...","messages":[{"role":"user","content":"What is my name?"}]}'
# → "Hiro" — and the same session_id comes back
```

The id is stable: it does not change across turns, so clients keep a single
handle per conversation.

Rules:

- Omitting `session_id` starts a new session every time.
- Function-calling requests (a `tools` array) are always stateless — those
  clients carry their own history in `messages`, so session ids are ignored.
- Streaming works the same way; grab `session_id` from the final chunk.

### How the warm pool works

```
request with session_id
        │
        ├─ live process for this id?  ──► write message to its stdin   (WARM)
        │
        └─ none? ──► spawn `claude --resume <id> --input-format stream-json`
                     (conversation restored from disk, process kept alive)
```

- The live process is the claude CLI's stream-json REPL — the same multi-turn
  mechanism the official SDK uses. It holds the conversation in memory and
  answers subsequent turns without any startup cost.
- Turns on the same session are serialized (a session is one conversation);
  different sessions run concurrently, subject to the request queue.
- Each live process is bound to the model (and system prompt) of the request
  that created it. Model changes mid-session don't take effect until the
  process is recycled.
- If a `--mcp` profile is active, warm processes load it too, same as
  one-shot requests.

### Lifecycle & fallback

- **Idle reap:** a session with no traffic for `BARNOWL_SESSION_IDLE` seconds
  (default 600) has its process killed.
- **LRU cap:** at most `BARNOWL_MAX_SESSIONS` live processes (default 8); the
  least-recently-used idle session is evicted first.
- **Fallback — context is never lost:** conversations are persisted on disk
  by Claude Code itself. If the live process was reaped, crashed, or the pool
  is disabled, the same request transparently falls back to a one-shot
  `claude --resume <id>` run: slower (one spawn), same context, same session
  id. The next turn warms the session up again.
- Nothing is written to the HTTP response until a warm turn succeeds, so a
  mid-turn failure degrades cleanly to the fallback path instead of returning
  a broken response.

### Session troubleshooting

- **Session turns as slow as normal requests** — the pool may be disabled
  (`BARNOWL_WARM_SESSIONS=off`), the process may have just been reaped (first
  turn back is a resume-spawn), or every turn is hitting a different session
  id. Confirm the client reuses the exact id from the previous response.
- **"claude exited mid-turn" in the log / unexpected fallbacks** — check that
  the `claude` CLI works standalone (`claude -p hi`) and that
  `BARNOWL_CLAUDE_BIN` (if set) points at the right binary.
- **Context missing after passing a session id** — ids expire only if Claude
  Code's on-disk session files are cleaned; otherwise check the id was taken
  from `session_id` / `X-Session-Id` verbatim (it's a UUID).
- **Too many claude processes** — lower `BARNOWL_MAX_SESSIONS` or
  `BARNOWL_SESSION_IDLE`. `ps aux | grep "input-format stream-json"` shows
  the pool's processes.

## MCP profiles (server-side tools)

MCP is **off by default** (that's where the speed comes from) and strictly
opt-in per profile: you declare exactly which servers to load, and nothing
else ever starts. Your global Claude Code MCP config is never auto-loaded.

```
default            barnowl start                → no MCP, fastest
opt-in             barnowl start --mcp <name>   → ONLY that profile's servers
```

### Quick start

Create a profile file under `config/mcp/<name>.json` — a standard
`mcpServers` map, same format as Claude Code:

```json
{
  "mcpServers": {
    "sheet": { "type": "http", "url": "http://localhost:8080/mcp" }
  }
}
```

Start the server with it:

```bash
barnowl start --mcp sheet          # loads config/mcp/sheet.json
barnowl start --mcp /abs/path.json # or any file path
```

`--mcp` can also be set persistently via the config file
(`~/.barnowl/config.json` → `"mcp": "sheet"`) or the `BARNOWL_MCP` env var.
`"mcp": "none"` force-disables it.

Profile files are **gitignored** (`config/mcp/*.json`) — they tend to contain
private URLs, tokens, or machine-specific paths.

### Calling tools from a client

The `claude` that the server runs holds the profile's MCP servers and
**executes their tools itself** (server-side execution). The client sends a
**plain chat request** — no OpenAI `tools` array:

```bash
curl http://localhost:11435/v1/chat/completions -H "Content-Type: application/json" -d '{
  "model":"sonnet",
  "messages":[{"role":"user","content":"List the worksheets of spreadsheet <ID> and report their titles."}]
}'
```

**Two execution models — pick per tool type:**

| | Who runs the tool | Backend needed |
| --- | --- | --- |
| Server-side (this `--mcp` mode) | the server's `claude` | barnowl — send **plain** requests, no `tools` array |
| Client-side (OpenAI function-calling) | your app | a **native** tool-use backend (e.g. Anthropic API) |

Browser tools that must run inside a page can only be client-side — they
cannot work through `--mcp`. Tools that can run anywhere (Sheets, DB, HTTP
APIs) work great server-side.

### Migrating servers you already use in Claude Code

Copy the entries you want into a profile. Where they live depends on how they
were registered:

**a) User-scope servers (`~/.claude.json` → `mcpServers`)** — copy the entry
as-is. Both stdio and HTTP forms work:

```json
{
  "mcpServers": {
    "context7": { "command": "npx", "args": ["-y", "@upstash/context7-mcp"] },
    "lazyweb":  { "type": "http", "url": "https://www.lazyweb.com/mcp" }
  }
}
```

`claude mcp list` shows every registered server and its launch command / URL —
that output is exactly what goes into the profile.

**b) Plugin-provided servers** — also portable: take the launch command shown
by `claude mcp list` and write it as a stdio entry. Supply any required
secrets yourself via `"env"`:

```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_..." }
    }
  }
}
```

**c) claude.ai connectors (Gmail, Google Drive, Calendar, …)** — **not
portable.** These are OAuth-bound to your claude.ai session; the headless
`claude` that the server spawns cannot authenticate to them. Use tools with
their own auth (API keys, local gateways) instead.

### MCP performance guidance

Startup cost is paid per spawned process, so:

| Profile contents | Typical request time |
| --- | --- |
| (no MCP) | fastest |
| 1–2 HTTP/SSE servers | ~10–15s incl. tool round-trip |
| stdio servers (`npx -y ...` etc.) | slow — subprocess spawn per request |
| many servers / heavy stdio | defeats the point of barnowl |

- **Prefer HTTP/SSE servers** — no subprocess spawn, they connect fast.
- Keep profiles **minimal**: only the servers the workload actually needs.
- One profile per use case (`sheet.json`, `github.json`, …) beats one big
  profile with everything.

### MCP troubleshooting

- **"mcp profile not found"** on start — the name didn't resolve; barnowl
  looked at the literal path and `config/mcp/<name>.json` (paths are printed
  in the warning).
- **Tools not available in responses** — check the startup log printed
  `MCP profile: ... (server-side tools ON)`. If not, the profile wasn't
  loaded. Also confirm the install patch is current (`npm install` re-applies
  it).
- **Requests suddenly slow** — a stdio server in the profile is paying its
  spawn cost every request; switch to an HTTP endpoint or drop it.
- **Server needs credentials** — put them in the profile's `"env"` block
  (stdio) or the URL/headers (HTTP). Profiles are gitignored, so secrets stay
  local.

## Outbound PII guard

An optional guard inspects **everything that would leave the machine** — and
adds `POST /v1/messages`, a guarded Anthropic passthrough, so Claude Code's
own traffic can be inspected too:

```
Claude Code ── ANTHROPIC_BASE_URL=http://localhost:11435 ──► barnowl
  ├ /v1/messages, /v1/files … guard → forwarded verbatim to api.anthropic.com
  └ /v1/chat/completions etc. guard → the usual local claude / codex engines
```

```json
{
  "guard": {
    "enabled": true,
    "policy": "~/path/to/policy-dir",
    "maskCmd": null,
    "upstream": null,
    "llm": {
      "url": "http://127.0.0.1:11434/v1/chat/completions",
      "model": "qwen2.5:3b"
    }
  }
}
```

What it does per request:

- **Text** (system prompts, messages, tool results) is piped through the mask
  command — by default `node ~/.claude/hooks/secret-guard.mjs mask`, a
  stdin → stdout filter that replaces PII with stable tokens (`<名前>`,
  `<電話番号>`, …). Tokens are deterministic, so Anthropic prompt caching
  keeps working.
- **Images / documents / audio** cannot be masked and are rejected with
  `403 guard_blocked`.
- **Fail-closed**: if the mask command is missing, exits nonzero, or times
  out (30s), the request is blocked — never forwarded unmasked.

Details:

- `policy` — a directory whose `secret-guard.json` is passed to the mask
  command as `SECRET_GUARD_CONFIG`. Point it at a policy like
  `claudehac/policies/secure` to keep one source of truth.
- `maskCmd` — any stdin → stdout filter; replaces the secret-guard default.
- `upstream` — the Anthropic base URL for `/v1/messages`
  (default `https://api.anthropic.com`; tests point it at a mock).
- `llm` — optional second stage: after masking, any OpenAI-compatible LLM
  (Ollama, LM Studio, vLLM, LiteLLM, …) judges whether unmasked PII remains;
  a leak verdict → `403 guard_blocked`. Verdict only — the LLM never rewrites
  text, and mask tokens are stripped before it looks (small models misread
  them as PII; with stripping, `qwen2.5:3b` scored 6/6 on our verdict cases).
  Per-chunk verdicts are cached by hash, so re-sent conversation history is
  not re-checked. Keys: `url`, `model`, `apiKey`, `timeoutMs` (20s),
  `maxChars` (4000 per chunk), `prompt` (system-prompt override).
  A **remote** checker sees your masked text — keep it local for privacy.
  Checker failure blocks the request (fail-closed), like everything else.
- `/v1/messages` forwards the **client's own** auth headers
  (`Authorization` / `x-api-key` / `anthropic-*`); barnowl holds no key and
  does not apply its own Bearer auth to that route. Verified with API-key
  auth. To use the local Claude Code login instead, see **Messages API on the
  subscription** below.
- With the guard disabled, the anthropic routes still exist but forward
  unmasked, and the engine routes behave exactly as before.
- The guard can only mask **Messages-shaped** bodies (`/v1/messages`,
  `/v1/messages/count_tokens`, `/v1/messages/batches` — every request in the
  batch). With the guard ON, any other proxied body is blocked with
  `403 guard_blocked` rather than forwarded unmasked: an agent config, a skill,
  a multipart file upload. Bodyless methods (GET, DELETE) pass.

Claude Code client setup:

```bash
export ANTHROPIC_BASE_URL=http://localhost:11435
claude
```

## The rest of the Anthropic API (passthrough)

The same passthrough carries the whole first-party surface, every method, so an
Anthropic SDK pointed at barnowl can reach more than chat:

```
/v1/messages            /v1/files        /v1/agents        /v1/vaults
/v1/messages/batches    /v1/skills       /v1/sessions      /v1/memory_stores
/v1/messages/count_tokens                /v1/environments  /v1/deployments
/v1/organizations                                          /v1/deployment_runs
```

Paths outside that list stay local: `/v1/models` and `/api/tags` answer from
barnowl's own catalog, and `/v1/chat/completions`, `/v1/images/generations` and
the Ollama routes run the local claude / codex engines. Queries and sub-paths
are preserved, so `GET /v1/messages/batches/{id}/results` and SSE session
streams work.

With a real API key this is just a reverse proxy. On the subscription login
(next section) most of it is **not** authorized — measured 2026-11-01:

| Surface | Subscription login |
| --- | --- |
| `/v1/messages`, `/v1/messages/count_tokens` | works |
| `/v1/files` | works (`user:file_upload` scope) |
| `/v1/messages/batches` | `403 permission_error` — needs `user:batch` / `user:developer` / `workspace:developer` / `workspace:inference` |
| `/v1/agents`, `/v1/sessions` (Managed Agents) | `403 permission_error` — "OAuth token lacks a scope this endpoint accepts" |

Those 403s come from Anthropic, not barnowl: the Claude Code login is issued
with `user:inference`, `user:profile`, `user:file_upload`, `user:mcp_servers`,
`user:plugins`, `user:sessions:claude_code` and nothing else, so Batches and
Managed Agents need an API key. barnowl forwards them either way.

## Messages API on the subscription (`messages.oauth`)

`POST /v1/messages` normally forwards the client's own credentials. With

```json
{ "messages": { "oauth": true } }
```

barnowl instead authenticates upstream with the **local Claude Code login** —
the same keychain / `.credentials.json` entry the CLI engines use. Clients need
no Anthropic API key, so the Messages API (and its server tools) runs on your
subscription instead of per-token API billing.

What barnowl changes on the way out:

- drops the client's `Authorization` / `x-api-key` and sets
  `Authorization: Bearer <local OAuth token>`
- merges `oauth-2025-04-20` into `anthropic-beta` (the client's own betas are
  kept) and defaults `anthropic-version` to `2023-06-01`
- prepends the Claude Code identity block to `system` — on `/v1/messages`,
  `/v1/messages/count_tokens`, and every request inside a
  `/v1/messages/batches` body — keeping the client's own system prompt right
  after it. **Required**: the login is only authorized for
  Claude Code traffic, and a request whose first system block is anything else
  comes back as `{"type":"error","error":{"type":"rate_limit_error","message":"Error"}}`
  — measured, not documented.
- refreshes the token itself when the stored one is spent (or within 2 minutes
  of expiry), using the refresh token next to it in the store — the same
  `POST https://platform.claude.com/v1/oauth/token` grant the CLI makes, with
  the CLI's client id. Concurrent requests share one refresh.
- writes the refreshed token back into the store it came from, merged into the
  existing blob so `subscriptionType` / `rateLimitTier` survive. This is not
  optional: the server **rotates** the refresh token (measured), so a rotation
  left unwritten would leave Claude Code holding a dead one. The flip side is a
  race if Claude Code writes the same item at the same moment — last writer
  wins, and the loser's token is simply refreshed again on next use.
- answers `401` only when nothing is left to refresh with: no login at all, no
  refresh token (a bare `CLAUDE_CODE_OAUTH_TOKEN`), or an expired refresh
  token. Then run `claude` and log in again.

Measured lifetimes on a Max login: access token ~8 h, refresh token ~7 days
(`refreshTokenExpiresAt` in the store), so an idle barnowl stays usable for
about a week without the CLI being run.

```bash
curl http://localhost:11435/v1/messages \
  -H "content-type: application/json" \
  -d '{"model":"claude-sonnet-5-5","max_tokens":1024,
       "tools":[{"type":"web_search_20250305","name":"web_search","max_uses":1}],
       "messages":[{"role":"user","content":"Search the web for today's news"}]}'
```

Server tools, measured against a Claude Max login on 2026-11-01
(`claude-sonnet-5-5`):

| Tool | Result |
| --- | --- |
| `web_search_20250305` | works — `server_tool_use.web_search_requests: 1` |
| `web_fetch_20250910` | works — returns a `web_fetch_result` document |
| `code_execution_20260521` | **unavailable** — `bash_code_execution_tool_result_error` / `too_many_requests`, 3/3 over 40s |
| `web_search_20260209`, `web_fetch_20260209` | **unavailable** — they run code execution under the hood, so they hit the same error |

So the dynamic-filtering variants and anything sandbox-backed need a real API
key; plain web search / fetch work on the subscription. Whether this use of a
subscription login fits Anthropic's consumer terms is **your call** — barnowl
only forwards it.

With `oauth` off (the default) nothing changes: the route stays a verbatim
passthrough of the client's own auth.

Env: `BARNOWL_MESSAGES_OAUTH=1`

### Credential snapshots

Because the refresh token rotates, a bad write to the store would leave no way
back to a working login. So every write-back first snapshots what it is about
to overwrite, into `<state dir>/credentials-backup/` (dir `0700`, files
`0600`, newest 5 kept):

```bash
barnowl creds list              # the live store + every snapshot (no secrets)
barnowl creds backup            # snapshot the store right now
barnowl creds restore [file]    # put one back (newest if no file given)
```

`restore` snapshots the live store before overwriting it, so it is reversible
too. A restored *access* token is usually expired already — what matters is the
refresh token inside it, which barnowl exchanges on the next request.

### Wire logging, capture, and rewrite

The `/v1/messages` passthrough has three optional, independent switches under
the config `messages` block:

```json
{
  "messages": {
    "log": "~/barnowl-messages.log",
    "capture": true,
    "rewrite": "~/barnowl-rewrite.json"
  }
}
```

- **`log`** (env `BARNOWL_MESSAGES_LOG`) — tees each `/v1/messages` request and
  the raw upstream response (SSE frames included, so the Anthropic
  `message_start` / `content_block_delta` / `message_delta` / `message_stop`
  events are visible) to a file. Bodies are **plaintext**; the `Authorization` /
  `x-api-key` headers are redacted. Point it somewhere private. While logging is
  on, barnowl also taps `stop_details` out of each response and appends a one
  line summary (`--- stop: reason=... category=... ---`); a refusal is also
  printed to barnowl's stdout with a Japanese gloss of the category.
- **`capture`** (env `BARNOWL_MESSAGES_CAPTURE`) — points the spawned `claude`
  CLI's `ANTHROPIC_BASE_URL` back at barnowl, so the OpenAI engine path
  (`/v1/chat/completions`, seal included) routes its own Anthropic calls through
  `/v1/messages` and lands in the log too. barnowl forwards to
  `BARNOWL_GUARD_UPSTREAM` (real Anthropic), so there is no loop; it auto-enables
  the log at `<state dir>/messages.log` if you did not set one.
- **`rewrite`** (env `BARNOWL_MESSAGES_REWRITE`) — a JSON file path or inline
  array of `{ "when": {<dot.path>: value | [values]}, "set": {<dot.path>:
  "template"} }` rules, applied to every response object barnowl parses (SSE
  events and buffered JSON; a rule also sees an event's `delta`, so one rule set
  covers both shapes). `when` is AND over its paths; `set` templates interpolate
  `{dot.path}` tokens from the object's pre-mutation values. A field is set only
  when its parent already exists, so rules never fabricate structure, and rules
  apply in order (later wins). It rewrites **any** field, not just refusals.

  Localize a refusal (what a client that displays `stop_details.explanation`
  then shows) — one rule per category, `{stop_details.explanation}` keeps the
  English original:

  ```json
  [
    { "when": { "stop_reason": "refusal", "stop_details.category": "cyber" },
      "set":  { "stop_details.explanation": "サイバー被害につながりうる要求として拒否されました。（原文: {stop_details.explanation}）" } }
  ]
  ```

  Whether the end client renders `explanation` is up to the client. Rewriting
  `stop_details.type` / `category` can affect client logic and server-side
  fallback routing — touch only `explanation` for a pure localization.

## Open tracking (read receipts)

Embed a 1x1 pixel in an HTML/email you send; when the recipient opens it, their
viewer fetches `http://<host>/t/<id>.gif` from the running barnowl and the open
is recorded locally in `<state dir>/beacons.json` — count, first/last time, and
per-hit IP / User-Agent / Referer. barnowl sends nothing itself; the recipient's
viewer is what calls in.

```bash
echo "<p>the body of your note" > body.html
barnowl beacon make your-host:11435 "Subject" body.html --label tanaka -o memo.html
#   → writes memo.html (your content + the inline pixel) and prints the id
barnowl beacon list                 # the local tally (count, time, IP, client)
barnowl beacon id tanaka            # just mint a unique id
```

The pixel route runs before auth so recipients can reach it; `GET /beacons`
(the tally) is **loopback-only**. Reads are served from the running server
(patched otterly) — `barnowl start` must be up and reachable at `<host>`.

**What it can and can't tell you** — this is the same mechanism as an email
open receipt, so treat it the same (tell recipients):

- "who" is only an inference, and only if you mint a **unique id per recipient**
  (`--label <name>`): then an open of that id ≈ that person (or whoever they
  forwarded it to).
- IP is not identity (NAT / VPN / mobile). Mail image proxies (e.g. Gmail)
  **prefetch** the pixel on delivery → a provider IP and a false "open" before
  the human looks. Tracker blockers suppress it entirely (count 0 ≠ unread).
- Only HTML/email embeds reliably; plain `.txt` and bare images can't carry it,
  and DOCX/PDF remote refs are usually blocked by the viewer.

This counts opens of a file **you** send and own; it is not a way to run code on
someone else's machine.

## Sealed chat (seal relay)

A client-side helper that keeps the **payload** of a request out of
barnowl's own logs and whatever TLS-terminating middle layer sits between
the client and barnowl. The payload is AES-256-GCM encrypted with a fresh
ephemeral key before it leaves the client; the key, IV and ciphertext are
inlined into the system prompt that tells Claude to decrypt via Bash +
Python. Claude runs the shell command, sees the plaintext inside its own
reasoning, and returns the answer. Honest about what this does and does
not hide:

| Layer | Hidden? |
| --- | --- |
| client ↔ barnowl (localhost, other processes sniffing) | ✅ ciphertext only |
| barnowl own log files, request body dumps | ✅ ciphertext only |
| Anthropic / upstream after Claude decrypts | ❌ plaintext in Claude's reasoning context |
| Response moderation and safety classifier | ❌ fully applies to the decrypted intent |

Use seal when: internal customer records, config files, request bodies
you want kept out of audit logs. Don't use seal when: trying to hide
intent from the vendor — the task text and decrypted plaintext still
reach the model.

Setup:

```bash
# Grant the spawned claude CLI *only* the Bash tool. Default is "all
# native tools disabled" (the fast path, ~6s per request); --allow-tools
# subtracts named tools from that kill-list.
barnowl start --allow-tools Bash
# or in config.json:  "allowTools": "Bash"
# or env var:          BARNOWL_ALLOW_TOOLS=Bash
```

```js
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { sealRelay } = require("barnowl/lib/seal/relay.js");

const res = await sealRelay({
  payload: "機密データ: 田中太郎 34歳 営業部",
  task:    "添付の社員レコードを 1 文で要約して",
  model:   "sonnet",
});
console.log(res.choices[0].message.content);
// → "田中太郎さん(34歳)は営業部に所属する社員です。"
```

Design notes:

- **Ephemeral key per call** (`newKey()` in `lib/seal/crypto.js`). The raw
  key `Buffer` is zero-filled after the request; the hex-encoded copy
  embedded in the prompt lives in the serialized JSON body and in JS
  string memory (immutable, cannot be scrubbed).
- **Authenticated encryption**: GCM auth tag is appended to the
  ciphertext, so tampering with the inlined bytes fails `decrypt(...)`
  inside the shell command rather than silently producing garbage.
- **tool_result boundary**: Claude treats the decrypted text as
  tool output (data), not a new instruction turn. Prompt-injection
  attempts embedded in the plaintext don't get a free upgrade to
  `role: "user"`.
- **Requires `--allow-tools Bash`**. If Bash is in the kill-list, the
  system prompt tells Claude to say
  `"sealed-mode requires --allow-tools Bash"` and stop.
- **vs. the Outbound PII guard**: these solve different problems. The
  guard sees plaintext and tokenises PII before it leaves the machine
  (and refuses binary data). Seal keeps a specific payload opaque
  through middle layers but lets the vendor see the plaintext. Use the
  guard to protect against the vendor; use seal to protect against the
  pipe. They can be enabled together.

See `test/seal.test.js`, `test/seal-relay.test.js`,
`test/patch-tools.test.js` for the 20 unit tests covering the crypto
chain, the patch IIFE under every env variant, and the system-prompt
shape.

## Configuration (config file)

Declare everything once and start with no flags. Resolution:
**CLI flags > env vars > config file > defaults**.

```bash
barnowl config init    # creates ~/.barnowl/config.json
barnowl config         # show the effective config + which file was used
```

```json
{
  "port": 11435,
  "dir": "/Users/you/work",
  "mcp": "none",
  "queueTimeout": 300,
  "maxConcurrent": 5,
  "maxQueue": 50,
  "rateLimit": 60,
  "autoUpdate": true
}
```

- `mcp` — MCP profile: a name under `config/mcp/<name>.json`, a file path,
  or `"none"` to disable.
- File lookup: `--config <path>` > `./barnowl.config.json` > `~/.barnowl/config.json`.
- `apiKey` in the file sets `BARNOWL_API_KEY` (Bearer auth) on start.
- `autoUpdate` — `false` stops `start` from fast-forwarding a git clone to
  `origin/main`.
- `messages.oauth` — `true` makes `POST /v1/messages` authenticate with the
  local Claude Code login instead of the client's key (see **Messages API on
  the subscription**).
- `allowTools` — same as the `--allow-tools` flag / `BARNOWL_ALLOW_TOOLS`
  env: space/comma list of native tools to subtract from the default
  kill-list (e.g. `"Bash"` for seal relay). Default is unset → all
  disabled.

## Configuration (env vars)

| Var                       | Default   | Meaning                         |
| ------------------------- | --------- | ------------------------------- |
| `BARNOWL_PORT`            | `11435`   | Listen port                     |
| `BARNOWL_WORK_DIR`        | cwd       | Working directory for Claude    |
| `BARNOWL_API_KEY`         | (unset)   | Require Bearer auth when set     |
| `BARNOWL_AUTO_UPDATE`     | (on)      | `0` skips the GitHub update check on start |
| `BARNOWL_QUEUE_TIMEOUT`   | `300`     | Queue wait timeout (seconds)    |
| `BARNOWL_MAX_CONCURRENT`  | `5`       | Max concurrent requests         |
| `BARNOWL_MAX_QUEUE`       | `50`      | Max queued requests             |
| `BARNOWL_RATE_LIMIT`      | `60`      | Requests/min per client         |
| `BARNOWL_ALLOW_TOOLS`     | (unset)   | Space/comma list of native tools to re-enable (e.g. `Bash` for seal relay). Default kill-list stays applied; names here are subtracted. |
| `BARNOWL_ENABLE_TOOLS`    | `0`       | `1` re-enables EVERY native tool (full regression — slow). |
| `BARNOWL_SESSION_IDLE`    | `600`     | Warm session idle reap (seconds) |
| `BARNOWL_MAX_SESSIONS`    | `8`       | Max live session processes      |
| `BARNOWL_WARM_SESSIONS`   | (on)      | `off` disables the warm pool    |
| `BARNOWL_CLAUDE_BIN`      | `claude`  | claude binary for warm sessions |
| `BARNOWL_CODEX_BIN`       | (auto)    | codex binary path               |
| `BARNOWL_CODEX_EFFORT`    | (unset)   | default reasoning effort for Codex models |
| `BARNOWL_CODEX_SANDBOX`   | `read-only` | codex sandbox mode for chat   |
| `BARNOWL_CODEX_TIMEOUT_MS`| `300000`  | per-request kill for Codex chat |
| `BARNOWL_IMAGE_TIMEOUT_MS`| `600000`  | per-image kill for image generation |
| `BARNOWL_GUARD`           | (off)     | `1` enables the outbound PII guard  |
| `BARNOWL_GUARD_POLICY`    | (unset)   | policy dir; its `secret-guard.json` feeds the mask command |
| `BARNOWL_GUARD_MASK_CMD`  | secret-guard | override mask command (stdin → stdout) |
| `BARNOWL_GUARD_UPSTREAM`  | api.anthropic.com | Anthropic upstream for `/v1/messages` |
| `BARNOWL_MESSAGES_OAUTH`  | (off)     | `1` authenticates `/v1/messages` with the local Claude Code login |

State (PID + log) lives in `~/.barnowl/`.

## Windows

Works natively on Windows (no WSL required):

- Install the `claude` CLI for Windows and make sure it's on `PATH`.
- State (PID + log) lives in `%USERPROFILE%\.barnowl\`.
- barnowl's install patch makes the argument quoting platform-aware
  (upstream otterly quotes for `sh`, which cmd.exe mangles), so prompts and
  system prompts work unchanged.
- The stray-process cleanup fallback (`barnowl stop` when the PID file is
  stale) uses PowerShell, which ships with Windows.

Known limitation: requests are relayed through `cmd.exe`, which expands
`%VAR%` sequences — a prompt containing literal `%PATH%`-style text may have
it substituted.
