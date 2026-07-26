# barnowl

[日本語版 README はこちら → README.ja.md](README.ja.md)

Fast, OpenAI-compatible **local Claude + Codex server**.

Point Cursor, Aider, Continue, or any OpenAI SDK at it and use `sonnet` /
`opus` / `haiku` / `fable` — or `gpt-5.6-sol` and friends through your
ChatGPT login. Codex models can also **generate images**
(`/v1/images/generations`).

## Install

```bash
npm install -g barnowl      # or: npx barnowl <cmd>
```

Requires the `claude` CLI on your PATH (Claude Code) and a working login.
For `gpt-*` models and image generation, also install the `codex` CLI and
log in with your ChatGPT account (`codex login`).

## Usage

```bash
barnowl start                 # start on port 11435 (fast chat, no MCP)
barnowl start --mcp sheet     # load ONLY the "sheet" MCP profile (server-side tools)
barnowl start -p 8080 -d ~/x  # custom port / working dir
barnowl verify                # end-to-end check + latency
barnowl status                # health JSON
barnowl stop
barnowl restart
barnowl models                # list usable model names
```

## Client setup

| Setting  | Value                        |
| -------- | ---------------------------- |
| Base URL | `http://localhost:11435/v1`  |
| API key  | any string (auth off unless `BARNOWL_API_KEY` is set) |
| Models   | `sonnet` · `opus` · `haiku` · `fable` · `gpt-5.6-sol` · … |

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
| Claude | `sonnet` (default) · `opus` · `haiku` · `fable` · `claude-opus-5` · `claude-opus-5[1m]` (1M context) · `claude-sonnet-5` · `claude-opus-4-8` · `claude-sonnet-4-6` | Claude Code login |
| Codex | `codex` (CLI default) · `gpt-5.6-sol` · `gpt-5.6-terra` · `gpt-5.6-luna` · `gpt-5.5` · `gpt-5.4` · `gpt-5.4-mini` | ChatGPT login (`codex login`) |

`claude-opus-5[1m]` is Opus 5 with a 1M-token context window — same id you
pass to the `claude` CLI, brackets included.

`barnowl models` lists every id in `config/models.json`. `GET /v1/models`
advertises the discovery subset (legacy Claude ids + all Codex ids); ids that
are not advertised still work — the id is passed through to the CLI verbatim.

**Reasoning effort** — append `:<effort>` to any model id, or send the
OpenAI `reasoning_effort` field:

```bash
-d '{"model":"gpt-5.5:high", ...}'          # or "sonnet:xhigh"
-d '{"model":"gpt-5.6-sol","reasoning_effort":"low", ...}'
```

Accepted levels are clamped per family/generation automatically:

| Family | Levels |
| --- | --- |
| Claude | `low` `medium` `high` `xhigh` `max` |
| Codex gpt-5.6+ | `none` `low` `medium` `high` `xhigh` (`minimal`→`none`, `max`→`xhigh`) |
| Codex older gpt-5.x | `minimal` `low` `medium` `high` |

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
  -d '{"model":"gpt-5.6-sol","verbosity":"low","messages":[{"role":"user","content":"..."}]}'
```

## Image generation (Codex models)

`POST /v1/images/generations` — OpenAI Images API shape, served by Codex
CLI's built-in `image_generation` tool through your ChatGPT subscription
(no API billing). Claude models cannot generate images (400).

```bash
curl http://localhost:11435/v1/images/generations -H "Content-Type: application/json" -d '{
  "model": "gpt-5.6-sol",
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
  "rateLimit": 60
}
```

- `mcp` — MCP profile: a name under `config/mcp/<name>.json`, a file path,
  or `"none"` to disable.
- File lookup: `--config <path>` > `./barnowl.config.json` > `~/.barnowl/config.json`.
- `apiKey` in the file sets `BARNOWL_API_KEY` (Bearer auth) on start.

## Configuration (env vars)

| Var                       | Default   | Meaning                         |
| ------------------------- | --------- | ------------------------------- |
| `BARNOWL_PORT`            | `11435`   | Listen port                     |
| `BARNOWL_WORK_DIR`        | cwd       | Working directory for Claude    |
| `BARNOWL_API_KEY`         | (unset)   | Require Bearer auth when set     |
| `BARNOWL_QUEUE_TIMEOUT`   | `300`     | Queue wait timeout (seconds)    |
| `BARNOWL_MAX_CONCURRENT`  | `5`       | Max concurrent requests         |
| `BARNOWL_MAX_QUEUE`       | `50`      | Max queued requests             |
| `BARNOWL_RATE_LIMIT`      | `60`      | Requests/min per client         |
| `BARNOWL_SESSION_IDLE`    | `600`     | Warm session idle reap (seconds) |
| `BARNOWL_MAX_SESSIONS`    | `8`       | Max live session processes      |
| `BARNOWL_WARM_SESSIONS`   | (on)      | `off` disables the warm pool    |
| `BARNOWL_CLAUDE_BIN`      | `claude`  | claude binary for warm sessions |
| `BARNOWL_CODEX_BIN`       | (auto)    | codex binary path               |
| `BARNOWL_CODEX_EFFORT`    | (unset)   | default reasoning effort for Codex models |
| `BARNOWL_CODEX_SANDBOX`   | `read-only` | codex sandbox mode for chat   |
| `BARNOWL_CODEX_TIMEOUT_MS`| `300000`  | per-request kill for Codex chat |
| `BARNOWL_IMAGE_TIMEOUT_MS`| `600000`  | per-image kill for image generation |

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
