# MCP guide — using tools through barnowl

barnowl's core trade is speed for tools: by default it starts the underlying
`claude` with `--strict-mcp-config`, which **ignores every globally configured
MCP server**. That is what makes a request take ~6s instead of ~37s. MCP is
therefore strictly **opt-in, per profile**: you declare exactly which servers
to load, and nothing else ever starts.

```
default            barnowl start                → no MCP, fastest (~6–8s)
opt-in             barnowl start --mcp <name>   → ONLY that profile's servers
never              your global Claude Code MCP config is never auto-loaded
```

## 1. Quick start

Create a profile file under `config/mcp/<name>.json`:

```json
{
  "mcpServers": {
    "sheet": { "type": "http", "url": "http://localhost:8080/v0/groups/sheets/mcp" }
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
`"mcp": "none"` in the config file force-disables it.

Profile files are **gitignored** (`config/mcp/*.json`) because they typically
contain private URLs, tokens, or machine-specific paths.

## 2. How it works

1. `--mcp <name>` resolves the profile file and exports it as
   `BARNOWL_MCP_CONFIG`.
2. barnowl's patched otterly spawns each per-request `claude` with
   `--strict-mcp-config --mcp-config <profile>`.
3. That `claude` loads **only** the profile's servers and **executes their
   tools itself** (server-side execution).

## 3. Calling tools from a client

Server-side execution means the client sends a **plain chat request** — no
OpenAI `tools` array. barnowl's Claude decides to call the MCP tools, runs
them, and the final answer comes back in the normal completion response:

```bash
curl http://localhost:11435/v1/chat/completions -H "Content-Type: application/json" -d '{
  "model":"sonnet",
  "messages":[{"role":"user","content":"List the worksheets of spreadsheet <ID> and report their titles."}]
}'
```

**Two execution models — pick per tool type:**

| | Who runs the tool | Backend needed |
| --- | --- | --- |
| Server-side (`--mcp` mode) | barnowl's `claude` | barnowl — send **plain** requests, no `tools` array |
| Client-side (OpenAI function-calling) | your app | a **native** tool-use backend (e.g. Anthropic API) |

Browser tools that must run inside a page (Chrome extensions etc.) can only be
client-side — they cannot work through `--mcp`. Tools that can run anywhere
(Sheets, DB, HTTP APIs) work great server-side.

## 4. Migrating servers you already use in Claude Code

barnowl never reads your global config automatically — you copy the entries
you want into a profile. Where they live depends on how they were registered:

### a) User-scope servers (`~/.claude.json` → `mcpServers`)

Copy the entry as-is. Both stdio and HTTP forms work:

```json
{
  "mcpServers": {
    "context7": { "command": "npx", "args": ["-y", "@upstash/context7-mcp"] },
    "lazyweb":  { "type": "http", "url": "https://www.lazyweb.com/mcp" }
  }
}
```

`claude mcp list` shows every registered server and its launch command /
URL — that output is exactly what goes into the profile.

### b) Plugin-provided servers

Also portable: take the launch command shown by `claude mcp list` and write it
as a stdio entry. Supply any required secrets yourself via `"env"`:

```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github@2025.4.8"],
      "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_..." }
    }
  }
}
```

### c) claude.ai connectors (Gmail, Google Drive, Calendar, …)

**Not portable.** These are OAuth-bound to your claude.ai session; the
headless `claude` that barnowl spawns cannot authenticate to them. Use tools
with their own auth (API keys, local gateways) instead.

## 5. Performance guidance

Every request spawns a fresh `claude`, which connects the profile's servers
each time. Startup cost is therefore per-request:

| Profile contents | Typical request time |
| --- | --- |
| (no MCP) | ~6–8s |
| 1–2 HTTP/SSE servers | ~10–15s incl. tool round-trip |
| stdio servers (`npx -y ...` etc.) | slow — subprocess spawn per request |
| many servers / heavy stdio | approaches plain otterly (~37s), defeats the point |

Rules of thumb:

- **Prefer HTTP/SSE servers** — no subprocess spawn, they connect fast.
- Keep profiles **minimal**: only the servers the workload actually needs.
- One profile per use case (`sheet.json`, `github.json`, …) beats one big
  profile with everything.
- If you need the full global tool set, barnowl is the wrong tool — run plain
  `otterly` (slower, MCP on).

## 6. Troubleshooting

- **"mcp profile not found"** on start — the name didn't resolve; barnowl
  looked at the literal path and `config/mcp/<name>.json` (paths are printed
  in the warning).
- **Tools not available in responses** — check the startup log printed
  `MCP profile: ... (server-side tools ON)`. If not, the profile wasn't
  loaded. Also confirm the speed patch is current (`npm install` re-applies
  it): an otterly copy patched by an old version won't read
  `BARNOWL_MCP_CONFIG`.
- **Requests suddenly slow** — a stdio server in the profile is paying its
  spawn cost every request; switch to an HTTP endpoint or drop it.
- **Server needs credentials** — put them in the profile's `"env"` block
  (stdio) or the URL/headers (HTTP). Remember profiles are gitignored, so
  secrets stay local.
