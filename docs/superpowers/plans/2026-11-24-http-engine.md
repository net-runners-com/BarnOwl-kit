# HTTP engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** otterly 経由の全ルートから `claude -p` を外し、barnowl 自身の `/v1/messages` へ HTTP で送るエンジンに置き換える。

**Architecture:** otterly の `resolveSDK()` が HTTP QueryFn を返すようパッチ。QueryFn は CLI の stream-json と同形のイベントを yield するので otterly のルート・events はそのまま。会話履歴・MCP・Bash・許可判定は barnowl 側（lib/）で持つ。

**Tech Stack:** Node >= 18（global fetch）、CommonJS、`node --test`、依存は otterly のみ。

**Spec:** `docs/superpowers/specs/2026-11-24-http-engine-design.md`

## Global Constraints

- 新規 npm 依存なし。otterly への変更は `lib/patch-otterly.js` の marker/anchor パッチのみ（idempotent）
- `BARNOWL_ENGINE=cli` で旧挙動に完全に戻る（パッチ済みコードも cli 時は旧分岐を通る）
- 送信先 `BARNOWL_SELF_URL`（barnowl start が `http://127.0.0.1:<port>` を設定）+ `/v1/messages`
- HTTP エンジン有効条件 `httpActive()`: `BARNOWL_ENGINE !== "cli"` かつ `BARNOWL_SELF_URL` あり かつ（`BARNOWL_MESSAGES_OAUTH === "1"` または `ANTHROPIC_API_KEY`）
- セッション保存先 `BARNOWL_SESSIONS_DIR` || `~/.barnowl/sessions`、7 日で削除
- `max_tokens` 既定 16384、ツールループ上限 `maxTurns` 既定 20、Bash タイムアウト 120s・出力 30,000 文字、全体 10 分
- effort: `none`→thinking なし／`minimal`→low／`low|medium|high|max`→そのまま／`xhigh|ultra`→max。effort 指定時 `thinking:{type:"adaptive",display:"omitted"}` + `output_config:{effort}`。`extraBody` は最後に上書きマージ
- Bash は `BARNOWL_ALLOW_TOOLS` に含まれる時のみ定義。`options.canUseTool` があれば全ツール実行前に必ず通し、例外は deny 扱い（seal の fail-closed を維持。seal 分岐は engine.stream が既に canUseTool を詰める）

## Review Focus

- 連続する同 role の OpenAI メッセージ（user,user / tool,tool）→ Anthropic は交互必須。結合されること（Task 2 テスト）
- ストリーム途中で client 切断 → fetch と子プロセスが止まり、セッションに半端なターンを書かない（Task 3 テスト）
- `/v1/messages` が 401 / 429 / masked rate_limit を返す → `result.is_error` + `api_error_status`、401 は auth 経路（Task 3 テスト）
- thinking + tool_use の往復で thinking ブロック（signature 付き）を履歴に保持して再送（Task 4 テスト）
- 未知の session_id → 空履歴で開始し、その ID で保存（Task 1 テスト）

---

### Task 1: セッションストア

**Files:** Create `lib/http-sessions.cjs`, Test `test/http-sessions.test.js`

**Interfaces — Produces:**
- `load(id: string) → {model, system, messages, updatedAt} | null`
- `save(id: string, rec: {model, system, messages}) → void`（`updatedAt` 付与、tmp→rename で原子的に書く）
- `sweep(maxAgeMs = 7*86400e3) → number`（削除件数）
- `dir() → string`
- ID は `/^[A-Za-z0-9._-]{1,128}$/` 以外を拒否（パス注入防止）→ `load` は null、`save` は throw

- [ ] Step 1: テスト — save→load 往復、未知 ID は null、`../x` は load null / save throw、updatedAt が古いファイルを sweep が消す（`BARNOWL_SESSIONS_DIR` を tmpdir に）
- [ ] Step 2: `node --test test/http-sessions.test.js` → FAIL
- [ ] Step 3: 実装
- [ ] Step 4: PASS 確認
- [ ] Step 5: commit `feat(http-engine): session store`

### Task 2: OpenAI → Anthropic 変換

**Files:** Create `lib/openai-anthropic.cjs`, Test `test/openai-anthropic.test.js`

**Interfaces — Produces:**
- `toAnthropic(body) → {system: string|null, messages: AnthropicMessage[], tools?: AnthropicTool[], tool_choice?}`
  - system: role system/developer を連結。`response_format.type==="json_object"` なら既存文言 "You must respond with valid JSON only. No markdown, no explanation, no code fences, just a JSON object." を追記
  - user: string / parts（text, image_url data: → base64 image, http(s) → url image）
  - assistant: content text + `tool_calls` → `tool_use{id, name, input: JSON.parse(arguments)||{}}`
  - tool: `tool_result{tool_use_id, content}` を user ターンに
  - 連続同 role は content 配列を結合
  - tools: `{name, description, input_schema: parameters || {type:"object",properties:{}}}`
  - tool_choice: `"auto"`→`{type:"auto"}`、`"required"`→`{type:"any"}`、`{function:{name}}`→`{type:"tool",name}`、`"none"`→tools を省く
- `toolUseToOpenAI(block) → {id, type:"function", function:{name, arguments: JSON.stringify(input)}}`

- [ ] Step 1: テスト — 上記各規則 1 ケースずつ + user,user 結合 + tool,tool が 1 つの user ターン（2 つの tool_result）
- [ ] Step 2: FAIL 確認
- [ ] Step 3: 実装
- [ ] Step 4: PASS
- [ ] Step 5: commit `feat(http-engine): openai→anthropic conversion`

### Task 3: HTTP QueryFn（単発・ストリーム・エラー・中断・セッション）

**Files:** Create `lib/http-engine.cjs`, Test `test/http-engine.test.js`（モック `/v1/messages` を `http.createServer` で立て SSE を返す）

**Interfaces:**
- Consumes: Task 1 `load/save`、Task 2 は使わない（route 側）
- Produces:
  - `httpActive() → boolean`（Global Constraints の条件）
  - `createHttpQueryFn({ selfUrl?, toolProvider? }) → (args:{prompt, options}) → AsyncIterable<rawEvent>`
  - `options.anthropic?: {system, messages, tools?, tool_choice?, max_tokens?}`（route が渡す。無ければ `prompt` + `options.images` + `options.systemPrompt` から 1 user ターン）
  - `options.resume?: string`、`options.model`、`options.effort`、`options.extraBody`、`options.abortController`、`options.canUseTool`、`options.maxTurns`、`options.cwd`
  - raw イベント形は spec「出すイベント」のとおり。`result` に追加で `stop_reason` を載せる
- モデル: `options.model` は `lib/model-catalog.cjs` の既存解決関数で ID 化（無ければそのまま）
- ヘッダー: `content-type`, `anthropic-version: 2023-06-01`, `x-api-key: ANTHROPIC_API_KEY`（あれば）。oauth 時の付与は `/v1/messages` 側が行う
- 最後の user ターン末尾ブロックに `cache_control:{type:"ephemeral"}`（保存時は外す）
- session: `resume` あり→`load` の messages + 今回 messages（今回 system が無ければ保存 system）。無し→`randomUUID()`。成功時のみ `save`

- [ ] Step 1: テスト — (a) text 2 delta → init / stream_event×2 / assistant / result(success, usage) の順 (b) モックが 401 → result is_error + api_error_status 401 (c) abort 途中 → イテレーション終了・save されない (d) resume 2 ターン目でモックが受けた messages に 1 ターン目が含まれる (e) effort "xhigh" → body.output_config.effort==="max" かつ thinking.type==="adaptive" (f) extraBody.temperature がbodyに入る
- [ ] Step 2: FAIL
- [ ] Step 3: 実装（SSE パース: `event:`/`data:` 行、`content_block_start/delta/stop`、`message_delta` の usage/stop_reason を集約）
- [ ] Step 4: PASS
- [ ] Step 5: commit `feat(http-engine): http query fn`

### Task 4: サーバー側ツールループ（Bash・許可判定）

**Files:** Create `lib/local-tools.cjs`, Modify `lib/http-engine.cjs`, Test `test/http-engine-tools.test.js`

**Interfaces — Produces:**
- `local-tools.cjs`: `bashDefinition() → AnthropicTool`（name `"Bash"`, input `{command: string, description?: string}`）、`runBash(command, {cwd, signal}) → Promise<{output: string, isError: boolean}>`、`allowedLocalTools() → string[]`（`BARNOWL_ALLOW_TOOLS` 由来、Bash 以外は起動時 1 回警告して除外）
- `toolProvider` 契約: `{ definitions(): Promise<AnthropicTool[]>, call(name, input, {signal, cwd}) → Promise<{output, isError}> }`。http-engine は local + MCP（Task 5）を合成
- ループ: `options.anthropic.tools`（client tools）がある時はサーバー実行せず `tool_use` で終了。無い時、`stop_reason==="tool_use"` なら各 tool_use を `canUseTool(name, input)`（あれば）→ allow なら call → user ターン（`tool_use_result: true`）を yield → 再送。deny は `tool_result{is_error:true, content: message}`

- [ ] Step 1: テスト — (a) モックが tool_use(Bash "echo hi") → 2 回目の送信に tool_result "hi\n" (b) canUseTool deny → is_error tool_result、コマンド未実行（副作用ファイルで確認） (c) client tools ありなら 1 回で終わり assistant に tool_use (d) thinking ブロック付き assistant が 2 回目送信の履歴にそのまま入る (e) maxTurns 超過で result error
- [ ] Step 2: FAIL
- [ ] Step 3: 実装
- [ ] Step 4: PASS
- [ ] Step 5: commit `feat(http-engine): server-side tool loop + Bash`

### Task 5: MCP クライアント

**Files:** Create `lib/mcp-client.cjs`, Test `test/mcp-client.test.js`（stdio モックサーバーを `test/fixtures/mcp-echo.cjs` に）

**Interfaces — Produces:**
- `createMcpHub(profilePath) → { definitions(), call(name, input, {signal}), close() }`（toolProvider 契約に一致）
- profile は `{mcpServers: {<name>: {type:"http", url, headers?} | {command, args?, env?}}}`
- JSON-RPC 2.0: `initialize`（protocolVersion "2025-06-18", clientInfo barnowl）→ `notifications/initialized` → `tools/list`（cursor ページング）→ `tools/call`
- http: POST、`Accept: application/json, text/event-stream`、`Mcp-Session-Id` を保持、SSE 応答なら該当 id の message を拾う
- stdio: 改行区切り JSON、id で応答待ち
- 名前 `mcp__<server>__<tool>`、`inputSchema`→`input_schema`。結果 content の text を連結、`isError` を引き継ぐ
- 接続は遅延・プロセス内キャッシュ。1 サーバー失敗はそのサーバーだけ除外（警告ログ）

- [ ] Step 1: テスト — stdio echo サーバーで definitions に `mcp__echo__echo`、call が "pong:abc" を返す、壊れたサーバーを混ぜても他は使える
- [ ] Step 2: FAIL
- [ ] Step 3: 実装、http-engine の toolProvider に `BARNOWL_MCP_CONFIG` があれば合成
- [ ] Step 4: PASS
- [ ] Step 5: commit `feat(http-engine): MCP client (http + stdio)`

### Task 6: otterly パッチ + 起動設定

**Files:** Modify `lib/patch-otterly.js`（新パッチ 4 本を `ensurePatched()` に追加）、`bin/barnowl.js`、Test `test/patch-otterly.test.js`

**Patches（marker / 内容）:**
1. `engine.js` `barnowl: http engine` — `resolveSDK()` 冒頭で `httpActive()` なら `createHttpQueryFn()` を返す（`resolvedMode="http"`）。require パスは seal と同じ `../../../lib/http-engine.cjs`
2. `engine.js` `barnowl: anthropic options` — `stream()` の queryOptions に `anthropic`, `canUseTool`(既存 seal 分岐は維持) を通す
3. `routes-openai.js` `barnowl: http route` — `httpActive()` かつ Claude モデル時: `options.anthropic = toAnthropic(body)`、`buildToolInstruction` と `disallowedTools` をスキップ、tools/画像でも sessionId を許可、warm pool をスキップ
4. `routes-openai.js` `barnowl: http function calling` — `handleFunctionCalling` で http 時は `engine.stream` を回して `tool_use` イベントを `toolUseToOpenAI` で集め、text と合わせて既存の応答組み立てへ（`parseToolCalls` は使わない）

**bin/barnowl.js:** `process.env.BARNOWL_SELF_URL = baseUrl(cfg.port)` を設定。config `engine: "http"|"cli"`（既定 http）→ `BARNOWL_ENGINE`。起動表示に `Engine : http (→ <self>/v1/messages)` か、条件不足なら `Engine : cli (http needs messages.oauth or ANTHROPIC_API_KEY)`。起動時に `http-sessions.sweep()`。

- [ ] Step 1: テスト — 既存 test の fixture 方式に合わせ、4 パッチが適用され 2 回目は "already"、アンカー欠落で "no-anchor"
- [ ] Step 2: FAIL
- [ ] Step 3: 実装
- [ ] Step 4: `npm test` 全体 PASS
- [ ] Step 5: commit `feat(http-engine): wire into otterly + start config`

### Task 7: 実機検証と稼働コピー反映

- [ ] Step 1: 稼働コピーをバックアップ `tar -C ~/.claude/local-plugins -czf ~/.barnowl/backup-local-plugin-<date>.tgz barnowl`
- [ ] Step 2: リポジトリの `bin lib config package.json` を稼働コピーへ rsync（node_modules は除外）→ 稼働コピーで `node lib/patch-otterly.js` → `barnowl stop && barnowl start`
- [ ] Step 3: 検証（全て `claude` プロセスが起動しないことを `pgrep -f "claude -p"` で確認）
  - `curl /v1/chat/completions` "say hi" → 200、prompt_tokens が数百
  - 同 stream:true → 複数 delta チャンク
  - session_id 2 ターン（名前を覚えるか）
  - tools 付き → `tool_calls` + finish_reason `tool_calls`
  - `barnowl verify`
- [ ] Step 4: `BARNOWL_ENGINE=cli` で再起動し旧経路が動くこと → http に戻す
- [ ] Step 5: commit（spec/plan 含む）
