---
description: barnowl ローカルサーバーの起動・停止・設定確認（messages.oauth / log / capture / rewrite, creds, beacon 対応）
---

barnowl（ローカル OpenAI 互換 Claude/Codex サーバー）を操作する。CLI はこのプラグインに同梱したコード: `node ${CLAUDE_PLUGIN_ROOT}/bin/barnowl.js`（PATH 上の `barnowl` ではなく同梱版を使う）。

引数が無ければ現状を見せる:

1. `node ${CLAUDE_PLUGIN_ROOT}/bin/barnowl.js status` を実行し、結果をそのまま見せる（接続できなければ「停止中」と伝える）
2. `node ${CLAUDE_PLUGIN_ROOT}/bin/barnowl.js config` を実行し、`messages` ブロック（oauth / log / capture / rewrite）と `paths` を要約する

引数があればそのまま渡す: `node ${CLAUDE_PLUGIN_ROOT}/bin/barnowl.js $ARGUMENTS`

よく使うサブコマンド:

- `start` / `stop` / `restart` / `verify` / `models` / `login [claude|codex]`
- `creds list|backup|restore` — Claude Code ログインのスナップショット（refresh token はローテートするので書き戻し前に自動退避）
- `beacon make|list|id` — 開封トラッキング（read receipts）
- `config` / `config init`

`messages` ブロック（`~/.barnowl/config.json`、いずれも opt-in）:

- `oauth` — `/v1/messages` をローカル Claude Code ログインで認証（クライアントは anthropic キー不要。サブスク枠で Messages API + web_search / web_fetch / files が使える。code_execution と Batch / Managed Agents はサブスクのスコープ外）
- `log` — `/v1/messages` の生 SSE（message_start / content_block_delta / message_delta / message_stop）をファイルに tee。auth は伏せ字、ボディは平文なので private な場所へ。refusal は stop_details を日本語 gloss つきで stdout にも出す
- `capture` — spawn する claude CLI の ANTHROPIC_BASE_URL を barnowl 自身に向け、`/v1/chat/completions`（seal 含む）の裏 Anthropic 通信も上のログに乗せる
- `rewrite` — `{ "when": {<dot.path>: 値|[値]}, "set": {<dot.path>: "{dot.path} トークン入りテンプレート"} }` ルール配列（またはその JSON ファイルパス）で、レスポンスの任意フィールドを書き換え。refusal の explanation 日本語化などに使う。`category` / `type` を変えると fallback ルーティングやクライアント分岐に影響しうるので、表示用途なら `explanation` だけ触る

引数: $ARGUMENTS
