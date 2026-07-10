# barnowl

[English README → README.md](README.md)

高速な OpenAI 互換の**ローカル Claude サーバー**。

Cursor・Aider・Continue や任意の OpenAI SDK を向けるだけで、`sonnet` /
`opus` / `haiku` / `fable` が使えます。

## インストール

```bash
npm install -g barnowl      # または: npx barnowl <cmd>
```

PATH 上に `claude` CLI（Claude Code）とログイン済みの環境が必要です。

## 使い方

```bash
barnowl start                 # ポート 11435 で起動（高速チャット、MCP なし）
barnowl start --mcp sheet     # "sheet" MCP プロファイルだけ読み込む（サーバーサイドツール）
barnowl start -p 8080 -d ~/x  # ポート / 作業ディレクトリを指定
barnowl verify                # エンドツーエンド確認 + レイテンシ計測
barnowl status                # ヘルスチェック（JSON）
barnowl stop
barnowl restart
barnowl models                # 使えるモデル名の一覧
```

## クライアント設定

| 設定     | 値                           |
| -------- | ---------------------------- |
| Base URL | `http://localhost:11435/v1`  |
| API キー | 任意の文字列（`BARNOWL_API_KEY` を設定しない限り認証オフ） |
| モデル   | `sonnet` · `opus` · `haiku` · `fable` |

```bash
curl http://localhost:11435/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"sonnet","messages":[{"role":"user","content":"hi"}]}'
```

## セッション（会話の継続）

リクエストはデフォルトでステートレスです — 毎回新しい会話として処理されます。
セッションはその上に2つの機能を足します:

1. **継続性** — セッション ID を渡すと、`messages` に履歴を再送しなくても
   文脈を保ったまま会話が続きます。
2. **速度** — セッションのターンは**ウォームプロセスプール**が処理します。
   セッション専属の live な `claude` プロセスが応答するため、リクエスト毎の
   プロセス起動コストがありません。

実測値:

| ターン | 経路 | レイテンシ |
| --- | --- | --- |
| ターン1（新規会話） | 都度 spawn | 約4〜8秒 |
| ターン2（セッション初回） | live プロセスへ resume | 約4秒 |
| ターン3以降（ウォーム） | live プロセスの stdin | **約1.8〜2.5秒** |

### 使い方

**ターン1 — 作成。** 普通にリクエストを送るだけ。レスポンスには3経路で
セッション ID が入ります: ボディの `session_id`、`X-Session-Id` ヘッダー、
ストリーミング時は最終チャンク（`finish_reason: "stop"` のもの）。

```bash
curl -s http://localhost:11435/v1/chat/completions -H "Content-Type: application/json" \
  -d '{"model":"sonnet","messages":[{"role":"user","content":"私の名前はヒロです。"}]}'
# → { ..., "session_id": "bac390a4-..." }
```

**ターン2以降 — 再開。** ID をボディ（`session_id`）か `X-Session-Id`
ヘッダーで渡します。サーバーが文脈を持っているので、**新しいメッセージだけ**
送れば OK:

```bash
curl -s http://localhost:11435/v1/chat/completions -H "Content-Type: application/json" \
  -d '{"model":"sonnet","session_id":"bac390a4-...","messages":[{"role":"user","content":"私の名前は？"}]}'
# → 「ヒロ」 — 同じ session_id が返ってきます
```

ID は安定しています: ターンをまたいで変わらないため、クライアントは会話ごとに
1つの ID を持ち回るだけです。

ルール:

- `session_id` を省略すれば毎回新規セッション。
- function-calling リクエスト（`tools` 配列あり）は常にステートレス —
  そのタイプのクライアントは履歴を `messages` に自分で持つため、セッション
  ID は無視されます。
- ストリーミングも同様に動きます。ID は最終チャンクから取得してください。

### ウォームプールの仕組み

```
session_id 付きリクエスト
        │
        ├─ この ID の live プロセスあり? ──► stdin にメッセージ投入（ウォーム）
        │
        └─ なし? ──► `claude --resume <id> --input-format stream-json` を spawn
                     （ディスクから会話を復元し、プロセスを常駐させる）
```

- live プロセスの実体は claude CLI の stream-json REPL — 公式 SDK が使うのと
  同じマルチターン機構です。会話をメモリに保持し、以降のターンには起動コスト
  ゼロで応答します。
- 同一セッションのターンは直列化されます（セッション = 1つの会話）。別々の
  セッションはリクエストキューの範囲内で並行動作します。
- 各 live プロセスは作成時リクエストのモデル（とシステムプロンプト）に固定
  されます。途中でモデルを変えても、プロセスが再生成されるまで反映されません。
- `--mcp` プロファイルが有効な場合、ウォームプロセスにも同様に適用されます。

### ライフサイクルとフォールバック

- **アイドル回収:** `BARNOWL_SESSION_IDLE` 秒（デフォルト600）トラフィックが
  ないセッションのプロセスは kill されます。
- **LRU 上限:** live プロセスは最大 `BARNOWL_MAX_SESSIONS` 個（デフォルト8）。
  超過時は最も使われていないアイドルセッションから破棄されます。
- **フォールバック — 文脈は絶対に失われません:** 会話は Claude Code 自身が
  ディスクに永続化しています。live プロセスが回収・クラッシュ・無効化されて
  いても、同じリクエストが透過的に一発 `claude --resume <id>` 実行へフォール
  バックします: 遅い（spawn 1回分）だけで、文脈も session_id も同じ。次の
  ターンで再びウォーム化されます。
- ウォームターンが成功するまで HTTP レスポンスには何も書き込まれないため、
  ターン途中の失敗も壊れたレスポンスにならず、きれいにフォールバックします。

### セッションのトラブルシューティング

- **セッションのターンが普通のリクエストと同じ速さ** — プールが無効
  （`BARNOWL_WARM_SESSIONS=off`）、直前に回収された（復帰初回は resume-spawn）、
  または毎回違う ID を送っている可能性。前回レスポンスの ID をそのまま
  使い回しているか確認してください。
- **ログに "claude exited mid-turn" / 頻繁なフォールバック** — `claude` CLI が
  単体で動くか（`claude -p hi`）、`BARNOWL_CLAUDE_BIN`（設定時）が正しい
  バイナリを指しているか確認。
- **session_id を渡したのに文脈がない** — ID が消えるのは Claude Code の
  ディスク上セッションファイルが掃除された場合のみ。まずは `session_id` /
  `X-Session-Id` の値（UUID）をそのまま使っているか確認してください。
- **claude プロセスが多すぎる** — `BARNOWL_MAX_SESSIONS` か
  `BARNOWL_SESSION_IDLE` を下げてください。プールのプロセスは
  `ps aux | grep "input-format stream-json"` で確認できます。

## MCP プロファイル（サーバーサイドツール）

MCP は**デフォルトでオフ**です（それが速さの源）。使うときはプロファイル単位で
明示的にオプトインします: 読み込むサーバーを自分で宣言したものだけが起動し、
グローバルの Claude Code MCP 設定が自動で読まれることはありません。

```
デフォルト   barnowl start                → MCP なし、最速
オプトイン   barnowl start --mcp <name>   → そのプロファイルのサーバーのみ
```

### クイックスタート

`config/mcp/<name>.json` にプロファイルを作ります — Claude Code と同じ
標準の `mcpServers` マップです:

```json
{
  "mcpServers": {
    "sheet": { "type": "http", "url": "http://localhost:8080/mcp" }
  }
}
```

それを指定して起動:

```bash
barnowl start --mcp sheet          # config/mcp/sheet.json を読み込む
barnowl start --mcp /abs/path.json # ファイルパス指定も可
```

`--mcp` は設定ファイル（`~/.barnowl/config.json` → `"mcp": "sheet"`）や
環境変数 `BARNOWL_MCP` でも恒久設定できます。`"mcp": "none"` で強制無効化。

プロファイルは **gitignore 対象**（`config/mcp/*.json`）です — プライベートな
URL・トークン・マシン固有パスを含みがちなため。

### クライアントからのツール呼び出し

サーバーが起動する `claude` がプロファイルの MCP サーバーを保持し、
**ツールを自分で実行**します（サーバーサイド実行）。クライアントは `tools`
配列なしの**プレーンなチャットリクエスト**を送るだけ:

```bash
curl http://localhost:11435/v1/chat/completions -H "Content-Type: application/json" -d '{
  "model":"sonnet",
  "messages":[{"role":"user","content":"スプレッドシート <ID> のワークシート一覧とタイトルを報告して。"}]
}'
```

**実行モデルは2種類 — ツールの種類で選ぶ:**

| | ツールを実行するのは | 必要なバックエンド |
| --- | --- | --- |
| サーバーサイド（この `--mcp` モード） | サーバーの `claude` | barnowl — `tools` 配列なしの**プレーン**リクエスト |
| クライアントサイド（OpenAI function-calling） | あなたのアプリ | **ネイティブ**な tool-use バックエンド（例: Anthropic API） |

ページ内で動く必要があるブラウザ系ツールはクライアントサイドのみ対応です —
`--mcp` では動きません。どこでも実行できるツール（Sheets・DB・HTTP API）は
サーバーサイドが最適です。

### Claude Code で使用中のサーバーの移行

使いたいエントリをプロファイルに転記します。登録方法によって場所が違います:

**a) ユーザースコープ（`~/.claude.json` → `mcpServers`）** — そのままコピー。
stdio 型・HTTP 型どちらも動きます:

```json
{
  "mcpServers": {
    "context7": { "command": "npx", "args": ["-y", "@upstash/context7-mcp"] },
    "lazyweb":  { "type": "http", "url": "https://www.lazyweb.com/mcp" }
  }
}
```

`claude mcp list` で全登録サーバーの起動コマンド / URL が見られます —
その出力がそのままプロファイルに書く内容です。

**b) プラグイン提供のサーバー** — これも移行可能: `claude mcp list` に出る
起動コマンドを stdio エントリとして書きます。必要なシークレットは `"env"` で
自分で与えてください:

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

**c) claude.ai コネクタ（Gmail・Google Drive・Calendar など）** — **移行不可。**
claude.ai セッションの OAuth に紐づいており、サーバーが spawn する headless な
`claude` からは認証できません。独自の認証を持つツール（API キー、ローカル
ゲートウェイ）を使ってください。

### MCP のパフォーマンス指針

起動コストは spawn されるプロセスごとに発生します:

| プロファイルの内容 | 典型的なリクエスト時間 |
| --- | --- |
| （MCP なし） | 最速 |
| HTTP/SSE サーバー 1〜2個 | ツール往復込みで約10〜15秒 |
| stdio サーバー（`npx -y ...` 等） | 遅い — リクエスト毎にサブプロセス起動 |
| 多数のサーバー / 重い stdio | barnowl を使う意味がなくなる |

- **HTTP/SSE サーバーを優先** — サブプロセス起動がなく接続が速い。
- プロファイルは**最小限に**: そのワークロードに本当に必要なサーバーだけ。
- 用途ごとに1プロファイル（`sheet.json`、`github.json`、…）が、全部入りの
  巨大プロファイルより有効です。

### MCP のトラブルシューティング

- **起動時に "mcp profile not found"** — 名前が解決できていません。リテラル
  パスと `config/mcp/<name>.json` の両方を探します（警告にパスが出ます）。
- **レスポンスでツールが使われない** — 起動ログに
  `MCP profile: ... (server-side tools ON)` が出ているか確認。出ていなければ
  プロファイルが読まれていません。インストールパッチが最新かも確認
  （`npm install` で再適用）。
- **急にリクエストが遅くなった** — プロファイル内の stdio サーバーが毎
  リクエスト起動コストを払っています。HTTP エンドポイントに替えるか外して
  ください。
- **サーバーに認証情報が必要** — stdio はプロファイルの `"env"`、HTTP は
  URL/ヘッダーに書きます。プロファイルは gitignore されるのでシークレットは
  ローカルに留まります。

## 設定（設定ファイル）

一度書いておけばフラグなしで起動できます。優先順位:
**CLI フラグ > 環境変数 > 設定ファイル > デフォルト**。

```bash
barnowl config init    # ~/.barnowl/config.json を作成
barnowl config         # 有効な設定と、どのファイルが使われたかを表示
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

- `mcp` — MCP プロファイル: `config/mcp/<name>.json` の名前、ファイルパス、
  または `"none"` で無効化。
- ファイル探索順: `--config <path>` > `./barnowl.config.json` > `~/.barnowl/config.json`。
- ファイル内の `apiKey` は起動時に `BARNOWL_API_KEY`（Bearer 認証）として設定されます。

## 設定（環境変数）

| 変数                      | デフォルト | 意味                            |
| ------------------------- | --------- | ------------------------------- |
| `BARNOWL_PORT`            | `11435`   | 待ち受けポート                  |
| `BARNOWL_WORK_DIR`        | cwd       | Claude の作業ディレクトリ       |
| `BARNOWL_API_KEY`         | （未設定）| 設定すると Bearer 認証を必須化  |
| `BARNOWL_QUEUE_TIMEOUT`   | `300`     | キュー待ちタイムアウト（秒）    |
| `BARNOWL_MAX_CONCURRENT`  | `5`       | 最大同時リクエスト数            |
| `BARNOWL_MAX_QUEUE`       | `50`      | 最大キュー数                    |
| `BARNOWL_RATE_LIMIT`      | `60`      | クライアントごとの毎分リクエスト数 |
| `BARNOWL_SESSION_IDLE`    | `600`     | ウォームセッション回収までの秒数 |
| `BARNOWL_MAX_SESSIONS`    | `8`       | live セッションプロセスの上限   |
| `BARNOWL_WARM_SESSIONS`   | （有効）  | `off` でウォームプール無効化    |
| `BARNOWL_CLAUDE_BIN`      | `claude`  | ウォームセッション用 claude バイナリ |

状態（PID とログ）は `~/.barnowl/` に置かれます。

## Windows

Windows でもネイティブに動作します（WSL 不要）:

- Windows 版の `claude` CLI をインストールし、`PATH` を通してください。
- 状態（PID とログ）は `%USERPROFILE%\.barnowl\` に置かれます。
- インストール時のパッチで引数の引用符処理をプラットフォーム対応にしている
  ため（上流の otterly は `sh` 向けの引用で、cmd.exe では壊れる）、プロンプト・
  システムプロンプトはそのまま動きます。
- 迷子プロセスの掃除フォールバック（PID ファイルが古い状態での `barnowl stop`）
  は Windows 標準の PowerShell を使います。

既知の制限: リクエストは `cmd.exe` 経由で中継されるため、`%VAR%` 形式の文字列は
展開されます — プロンプトに `%PATH%` のようなテキストを含めると置換される可能性が
あります。
