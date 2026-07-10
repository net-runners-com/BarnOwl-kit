# Sessions guide — conversation continuity & the warm process pool

barnowl requests are stateless by default: each `/v1/chat/completions` call is
a fresh conversation. Sessions add two things on top:

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

## Using sessions

**Turn 1 — create.** Send a normal request. Every response carries the session
id three ways:

- response body: top-level `session_id`
- response header: `X-Session-Id`
- streaming: `session_id` on the final chunk (the one with
  `finish_reason: "stop"`)

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

- Omit `session_id` → a brand-new session every time.
- Function-calling requests (a `tools` array) are always stateless — those
  clients carry their own history in `messages`, so session ids are ignored.
- Streaming works the same way; grab `session_id` from the final chunk.

## How the warm pool works

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
  different sessions run concurrently, subject to otterly's request queue.
- Each live process is bound to the model (and system prompt) of the request
  that created it. Model changes mid-session don't take effect until the
  process is recycled.
- If a `--mcp` profile is active (`BARNOWL_MCP_CONFIG`), warm processes load
  it too, same as one-shot requests.

## Lifecycle & fallback

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

## Configuration

| Var | Default | Meaning |
| --- | --- | --- |
| `BARNOWL_SESSION_IDLE` | `600` | Seconds of inactivity before a live session process is reaped |
| `BARNOWL_MAX_SESSIONS` | `8` | Max concurrent live session processes (LRU eviction) |
| `BARNOWL_WARM_SESSIONS` | (on) | Set to `off` to disable the pool — session ids then always use one-shot `--resume` |
| `BARNOWL_CLAUDE_BIN` | `claude` | Path to the claude binary used for warm processes |

## Troubleshooting

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
