# barnowl

[日本語版 README はこちら → README.ja.md](README.ja.md)

Fast, OpenAI-compatible **local Claude server**.

Point Cursor, Aider, Continue, or any OpenAI SDK at it and use `sonnet` /
`opus` / `haiku`.

## Install

```bash
npm install -g barnowl      # or: npx barnowl <cmd>
```

Requires the `claude` CLI on your PATH (Claude Code) and a working login.

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

### MCP profiles (server-side tools)

MCP is **off by default** (that's where the speed comes from) and strictly
opt-in per profile. `--mcp <name>` loads `config/mcp/<name>.json` and nothing
else (via the CLI's `--strict-mcp-config --mcp-config`). The `claude` that
otterly runs then holds those MCP servers and **executes their tools itself**,
so a plain chat request (no OpenAI `tools` array) can drive them:

```bash
curl http://localhost:11435/v1/chat/completions -H "Content-Type: application/json" -d '{
  "model":"sonnet",
  "messages":[{"role":"user","content":"List the worksheets of spreadsheet <ID> and report their titles."}]
}'
```

A profile is a standard `mcpServers` map (same format as Claude Code), e.g.
pointing at an HTTP MCP gateway:
```json
{ "mcpServers": { "sheet": { "type": "http", "url": "http://localhost:8080/mcp" } } }
```
Profiles live in `config/mcp/` and are **gitignored** (they tend to contain
private URLs/keys). HTTP/SSE servers connect fast (no subprocess spawn), so a
profile with one or two of them stays quick (~10-15s incl. the tool round-trip).

**Full guide — [docs/mcp.md](docs/mcp.md):** how to migrate servers you
already registered in Claude Code (`~/.claude.json`, plugins, claude.ai
connectors), performance guidance, and troubleshooting.

**Two execution models — pick per tool type:**
| | Who runs the tool | Backend needed |
| --- | --- | --- |
| Server-side (this `--mcp` mode) | otterly's `claude` | barnowl — send **plain** requests, no `tools` array |
| Client-side (OpenAI function-calling) | your app | a **native** tool-use backend (e.g. Anthropic API) — otterly's prompt-injected tool-calling is refused when a system prompt is present |

Browser tools (that must run in the page) can only be client-side, so they need a
native backend. MCP tools that can run anywhere (Sheets, DB, HTTP) work great
server-side through `--mcp`.

## Client setup

| Setting  | Value                        |
| -------- | ---------------------------- |
| Base URL | `http://localhost:11435/v1`  |
| API key  | any string (auth off unless `BARNOWL_API_KEY` is set) |
| Models   | `sonnet` · `opus` · `haiku`  |

```bash
curl http://localhost:11435/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"sonnet","messages":[{"role":"user","content":"hi"}]}'
```

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

