# HTTP engine — `claude -p` を barnowl から外す

Date: 2026-11-24

## 意図

Claude Code の中身は「パラメータを組み立てて Messages API に送る」だけ。barnowl は
`/v1/messages` ではすでに OAuth で api.anthropic.com に直送している（実測 1.3s / 入力 401 tok）。
一方 `/v1/chat/completions` などは otterly が毎回 `claude -p` を起動している
（実測 "say hi" で 1.9s / 入力 12,135 tok — Claude Code の system prompt とツール定義の分）。
これを HTTP 直送に置き換え、`claude -p` に依存していた機能も HTTP 上で作り直す。

## ゴール

- otterly 経由の全ルート（OpenAI / Ollama / native / WebSocket）が `claude` プロセスを起動しない
- 依存機能を HTTP 上で再実装: 会話継続（session_id）、MCP、seal（Bash 実行 + 許可判定）、
  画像入力、effort / extraBody、モデル別名
- 本物のストリーミング（現状は CLI 出力を最後まで溜めてから流している）
- OpenAI `tools` をネイティブの Messages `tools` で渡す（system prompt 指示 + テキスト解析をやめる）
- OpenAI messages を役割付きの構造のまま送る（現状は 1 本の文字列に平坦化）

## 非ゴール

- otterly を捨てる／自前サーバー化（案 3。今回はやらない）
- `gpt-*`（codex-engine）と画像生成の経路は変更しない
- Claude Code の組み込みツール群（Read/Edit/Write/Grep…）の再実装。Bash のみ（seal 用）

## アンチゴール（動いてもこうなったら失敗）

- OAuth トークンの扱いが `/v1/messages` 経路と二重実装になる（必ず guard / claude-oauth を共用）
- `claude -p` に戻す手段がない（`BARNOWL_ENGINE=cli` で即時ロールバックできること）
- seal が「許可判定なしで Bash を実行する」状態になる（判定不能時は fail-closed）

## 制約

- 依存は otterly のみ。新規 npm 依存は入れない（MCP クライアントも手書き）
- otterly は postinstall の `lib/patch-otterly.js` でパッチする方式を維持（アンカー + マーカー）
- Node >= 18、`node --test`
- 作業は git リポジトリ（`~/orca/projects/CollectiveOS/barnowl`）。稼働コピー
  `~/.claude/local-plugins/barnowl` はリポジトリより古い（seed-prepend 欠落、guard 差分）ので、
  完了後にリポジトリから同期して再パッチ・再起動する

## 検討した案

| 案 | 内容 | トレードオフ |
|---|---|---|
| **1（採用）** | otterly の `createCLIQueryFn` を HTTP 版 QueryFn に差し替え。CLI と同じ stream-json 形のイベントを出す | 差し替え口が 1 か所で全ルートに効く。ロールバック容易。otterly のイベント形に合わせる必要あり |
| 2 | `/v1/chat/completions` だけ barnowl 自前ルートで書き直す | 中身は綺麗だが Ollama / native / WS に `claude -p` が残る |
| 3 | otterly を捨て barnowl 単独サーバー化 | 最も綺麗だがキュー・Ollama 互換・playground まで作り直しで最大工数 |

ユーザーが案 1 を選択。

## 設計

### 差し替え口

`dist/engine.js` の `resolveSDK()` で、`BARNOWL_ENGINE !== "cli"`（既定）のとき
`lib/http-engine.cjs` の `createHttpQueryFn()` を返す。`cli` のときは従来の `createCLIQueryFn`。
QueryFn の契約は現状どおり `queryFn({ prompt, options }) → AsyncIterable<raw event>`。

### 出すイベント（`events.js` の `normalizeEvents` が読む形）

1. `{type:"system", subtype:"init", session_id, model, cwd, tools:[names]}`
2. ストリーム中: `{type:"stream_event", event:{type:"content_block_delta", delta:{type:"text_delta", text}}}`
3. ターン完了ごと: `{type:"assistant", message:{content:[text / tool_use blocks]}}`
4. サーバー側でツール実行したら: `{type:"user", tool_use_result:…, message:{content:[tool_result blocks]}}`
5. 最後: `{type:"result", subtype:"success", result, usage, duration_ms, total_cost_usd:0}`
   エラー時 `{type:"result", is_error:true, result:msg, api_error_status}`（401 は既存の auth-state 経路に乗る）

### Anthropic への送信

- 送信先は **barnowl 自身の `/v1/messages`**（`BARNOWL_SELF_URL`、既定 `http://127.0.0.1:<port>`）。
  これで OAuth・Claude Code identity system ブロック付与（無いと masked rate_limit_error）・トークン更新・
  seed・rewrite/block・wire log が既存実装のまま効く。`/v1/messages` は otterly のキュー/レート制限より前で
  処理されるのでループバックでも詰まらない。`stream: true` で SSE を読み、上の 2→3 に変換
- `messages.oauth` が off かつ `ANTHROPIC_API_KEY` も無い場合は起動時に警告して CLI エンジンへ自動フォールバック
  （API キーがあれば `x-api-key` で送る）
- body: `model`（model-catalog で別名解決）、`max_tokens`（client 指定 → 無ければ 16384。私の判断）、`system`、`messages`、`tools`、
  `thinking`/`output_config` 等は `options.effort` と `options.extraBody` をマージ（extraBody が最優先）

### 入力の組み立て

- `options.messages`（新設、Anthropic 形の構造化履歴）があればそれを使う。無ければ `prompt` 文字列 +
  `options.images` を 1 つの user ターンにする（Ollama / native / WS はこちら）
- `routes-openai.js` パッチ: `openaiToClaudeInput` に加えて `openaiToAnthropicMessages(body)` を作り
  `options.messages` に載せる。role 交互化（連続 user の結合）、`tool_calls`→`tool_use`、`tool`→`tool_result`、
  `image_url`→image block

### 会話継続（session_id）

- `lib/http-sessions.cjs`: `~/.barnowl/sessions/<id>.json` に `{model, system, messages, updatedAt}`
- `options.resume = id` → 保存履歴 + 今回入力で送信、応答を追記して保存。新規は `crypto.randomUUID()`
- 既存の `claude --resume` 用セッション ID（Claude Code の JSONL）は**移行しない**。未知 ID は空履歴で開始（ログに警告）
- warm-sessions は HTTP エンジン時は使わない（routes-openai の pool 分岐を `BARNOWL_ENGINE=cli` 時のみに）
- 保持: 最終更新から 7 日で削除（起動時と 1 時間ごとに掃除）

### OpenAI `tools`

- HTTP エンジン時: client の `tools` を Anthropic `tools` に変換して渡し、`tool_use` が返ったら
  サーバー側で実行せず、そのまま OpenAI `tool_calls`（finish_reason `tool_calls`）で返す
- system prompt への `buildToolInstruction` 注入とテキスト解析は CLI エンジン時のみ
- tools 付きリクエストでも session_id を使えるようにする（現状は stateless 強制）— 判断は builder

### サーバー側ツールループ（MCP / Bash）

- client `tools` が無いリクエストで、MCP または許可済み Bash がある場合のみ有効
- ループ: 送信 → `tool_use` → 許可判定（`options.canUseTool` があれば必ず通す。seal はここ）→ 実行 →
  `tool_result` を付けて再送。上限 `options.maxTurns`（既定 20）
- **MCP**: `lib/mcp-client.cjs` 手書き JSON-RPC 2.0。`type:"http"`（Streamable HTTP、POST + SSE 応答対応）と
  `stdio`（子プロセス、改行区切り JSON）。`initialize` → `tools/list` → `tools/call`。
  ツール名は `mcp__<server>__<tool>`（Claude Code と同じ）。サーバー接続はプロセス内でキャッシュ
- **Bash**: `BARNOWL_ALLOW_TOOLS` に `Bash` があるときだけ定義を出す。`/bin/bash -c`、cwd は `options.cwd`、
  タイムアウト 120s、出力 30k 文字で切る。ほかの許可ツール名は未対応として起動時に警告
- **seal**: `lib/seal/firewall.js` が両コピーに存在せず現状 fail-closed。HTTP 版では許可判定関数が
  無ければ Bash を拒否（従来どおり fail-closed）。firewall.js の復元/作成は別件として扱う

### 中断・タイムアウト

`options.abortController` で fetch と子プロセス（Bash / MCP stdio）を止める。全体 10 分。

## テスト

- `test/http-engine.test.js`: ローカルのモック Anthropic サーバー（SSE）を立て、イベント列・ツールループ・
  セッション追記・401→auth 経路・abort を検証
- `test/mcp-client.test.js`: stdio のモック MCP サーバー
- `test/patch-otterly.test.js` に新パッチのアンカー検証を追加
- 実機: `barnowl verify` と、curl で chat/completions（通常・stream・session_id 2 ターン・tools）

## 実装者に任せること

- イベント変換・SSE パーサーの細部、ファイル分割
- tools 付き + session_id の併用可否（上記）
- セッション保持期間の掃除実装
