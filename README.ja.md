# barnowl

[English README → README.md](README.md)

高速な OpenAI 互換の**ローカル Claude + Codex サーバー**。

Cursor・Aider・Continue や任意の OpenAI SDK を向けるだけで、`sonnet` /
`opus` / `haiku` / `fable` に加え、ChatGPT ログイン経由の `gpt-5.6-terra`
などが使えます。Codex 系モデルは**画像生成**（`/v1/images/generations`）
にも対応。

## インストール

```bash
npm install -g barnowl      # または: npx barnowl <cmd>
```

PATH 上に `claude` CLI（Claude Code）とログイン済みの環境が必要です。
`gpt-*` モデルと画像生成を使う場合は `codex` CLI も入れて ChatGPT
アカウントでログインしてください（`codex login`）。

## AI エージェントでのセットアップ

`claude` / `codex` / `python3` の場所や、Claude のログインが入っている
キーチェーン項目は環境ごとに違います。これらは `~/.barnowl/config.json` の
`paths` に書きます。以下は AI コーディングエージェント（Claude Code、Codex
など）向けの手順です。エージェントにこの節を読ませて設定させてください。

> **エージェントへの指示 — barnowl のパス設定**
>
> 1. `barnowl config init` を実行する。自動検出で `paths` を埋めた
>    `~/.barnowl/config.json` ができる。既にファイルがある場合はそれを残し、
>    `paths` オブジェクトを追加・マージする。
> 2. 下の表の各キーを確認コマンドで調べ、`paths` の値を直す。絶対パスで書く
>    （`~` は可）。既定値で正しいキーは消してよい。
> 3. macOS のみ: キーチェーンに `Claude Code-credentials` が複数あることがある。
>    `security dump-keychain | grep -B12 '"svce"<blob>="Claude Code-credentials"' | grep -E '"acct"|"mdat"'`
>    で一覧し、更新日時（mdat）が最も新しい項目の acct を
>    `claudeKeychainAccount` に設定する。通常は OS のユーザー名で、`unknown`
>    は選ばない。
> 4. 確認:
>    - `barnowl config` で各パスが `[file]` か `[auto]` で実在の値になっている
>    - `barnowl start` が `Auth     : claude ok · codex ok` を表示する
>    - `barnowl verify` が `OK` で終わる
>
>    ログインが `revoked` / `logged_out` なら、ユーザーに
>    `barnowl login <provider>` の実行を頼む（ブラウザが開く）。代わりに
>    ログインはしない。
> 5. barnowl のために `CLAUDE_CONFIG_DIR` を設定しない。Claude Code は
>    これからキーチェーン項目名を決めるので、CLI が未ログイン扱いになる。

| キー | 内容 | 調べ方 | 既定値 |
| --- | --- | --- | --- |
| `claudeBin` | Claude Code CLI | `which claude` | PATH 上の `claude` |
| `codexBin` | Codex CLI | `which codex` | よくあるインストール先 → PATH |
| `python` | 画像生成用 Python 3 | `which python3` | `python3` |
| `codexHome` | Codex のデータ（ログイン・モデルキャッシュ） | `echo ${CODEX_HOME:-$HOME/.codex}` | `~/.codex` |
| `claudeKeychainAccount` | Claude ログインのキーチェーン acct（macOS） | 手順 3 | OS ユーザー名 |
| `claudeCredentialsFile` | Claude 認証ファイル（Linux / Windows） | `ls ~/.claude/.credentials.json` | `~/.claude/.credentials.json` |
| `stateDir` | barnowl のカタログ・pid・ログ・画像 | — | `~/.barnowl` |

各キーは環境変数でも指定できます（ファイルより優先）:
`BARNOWL_CLAUDE_BIN`、`BARNOWL_CODEX_BIN`、`BARNOWL_PYTHON`、`CODEX_HOME`、
`BARNOWL_CLAUDE_KEYCHAIN_ACCOUNT`、`BARNOWL_CLAUDE_CREDENTIALS_FILE`、
`BARNOWL_STATE_DIR`。

## 使い方

```bash
barnowl start                 # ポート 11435 で起動（高速チャット、MCP なし）
barnowl start --mcp sheet     # "sheet" MCP プロファイルだけ読み込む（サーバーサイドツール）
barnowl start -p 8080 -d ~/x  # ポート / 作業ディレクトリを指定
barnowl start --no-update     # GitHub の更新確認をしない
barnowl verify                # エンドツーエンド確認 + レイテンシ計測
barnowl status                # ヘルスチェック（JSON）
barnowl stop
barnowl restart
barnowl models                # ログインごとの実モデル一覧
barnowl login [claude|codex]  # revoke / 期限切れ後の再ログイン（再起動不要）
```

**自動アップデート** — git クローンから動かしている場合、`start`（と
`restart`）のたびに `origin/main` を取得し、起動前に fast-forward します。
GitHub にマージされたモデル更新が手動 pull なしで反映されます（依存が
変わっていれば `npm install` も実行）。対象はクリーンな `main` のみで、
別ブランチ・ローカル変更・オフラインのときは `Auto-update skipped: …` を
表示してそのまま起動します。npm レジストリからのインストールは対象外です。

## クライアント設定

| 設定     | 値                           |
| -------- | ---------------------------- |
| Base URL | `http://localhost:11435/v1`  |
| API キー | 任意の文字列（`BARNOWL_API_KEY` を設定しない限り認証オフ） |
| モデル   | `sonnet` · `opus` · `haiku` · `fable` · `gpt-5.6-terra` · … |

```bash
curl http://localhost:11435/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"sonnet","messages":[{"role":"user","content":"hi"}]}'
```

## モデル

1つのエンドポイントの裏に2つのエンジン。モデル ID で自動ルーティング
されます（`gpt*`/`codex` → Codex CLI、それ以外 → Claude CLI）:

| ファミリー | モデル ID | 認証 |
| --- | --- | --- |
| Claude | `sonnet`（デフォルト）· `opus` · `haiku` · `fable` · `claude-fable-5-1` · `claude-opus-5` · `claude-opus-5[1m]`（1M コンテキスト）· `claude-sonnet-5` · `claude-sonnet-5[1m]`（1M コンテキスト）· `claude-opus-4-8` · `claude-sonnet-4-6` | Claude Code ログイン |
| Codex | `codex`（CLI 既定 = `gpt-5.6-terra`）· `gpt-5.6-terra` · `gpt-5.6-luna` · `gpt-5.5` | ChatGPT ログイン（`codex login`） |

エイリアスは CLI の現行モデルを指します: `fable` → Fable 5.1、`opus` → Opus 5、
`sonnet` → Sonnet 5、`haiku` → Haiku 4.5。`[1m]` 付き ID は 1M トークン
コンテキスト版です。角括弧込みでそのまま `claude` CLI に渡る ID なので、
この表記のまま指定してください。

廃止: `claude-fable-5`（無害なプロンプトでも拒否が返る — `fable` /
`claude-fable-5-1` を使う）、`gpt-5.6-sol` / `gpt-5.4` / `gpt-5.4-mini`
（ChatGPT バックエンドが 400 "not supported" を返す）。

**モデル一覧の自動更新** — `barnowl start` のたびに、`claude` / `codex` CLI が
持っているトークンで Claude と Codex のモデル一覧 API を叩き、結果を
`~/.barnowl/catalog.json` に保存します。`GET /v1/models`・`/api/tags`・
`barnowl models` はこの一覧を返します。中身は Claude のエイリアス（`sonnet`
`opus` `haiku` `fable` `default`）、API が返す全 Claude モデル（1M 対応モデルは
`[1m]` 版も追加、上記の廃止 ID は除外）、ChatGPT アカウントで使える Codex
モデルです。Claude のトークンが期限切れのときは、先に `claude -p`（haiku）を
1 回だけ流して CLI に更新させます。オフラインや認証情報が読めない場合は前回の
一覧を使います。一覧にない ID もそのまま CLI に渡るので利用できます。

**ログインが revoke されたとき** — ログインが無効になると（revoke・期限切れ・
ログアウト）、そのプロバイダへのリクエストは HTTP 401 と対処法を返し、モデルは
`/v1/models` から消え、`barnowl status` に表示されます。`barnowl login claude`
または `barnowl login codex` を実行すれば、動いているサーバーが再起動なしで
新しいログインを拾います。Claude Code など barnowl の外で直した場合も、次に
成功したリクエストで自動的に元に戻ります。

**推論 effort** — モデル ID に `:<effort>` を付けるか、OpenAI の
`reasoning_effort` フィールドで指定:

```bash
-d '{"model":"gpt-5.5:high", ...}'          # または "sonnet:xhigh"
-d '{"model":"gpt-5.6-terra","reasoning_effort":"low", ...}'
```

レベルはモデルごとに自動でクランプされます（上限を超える値はそのモデルの
最上位に、`minimal`→`none`）:

| ファミリー | レベル |
| --- | --- |
| Claude | `low` `medium` `high` `xhigh` `max` |
| Codex gpt-5.6-terra | `none` `low` `medium` `high` `xhigh` `max` `ultra` |
| Codex gpt-5.6-luna | `none` `low` `medium` `high` `xhigh` `max` |
| Codex gpt-5.5 | `none` `low` `medium` `high` `xhigh` |

`ultra` は Codex の最大推論＋自動タスク委譲です。Claude CLI は一覧外の値
（`none`・`ultra` など）を無視して既定 effort で動きます。

## リクエストパラメータ — 実際に効くもの

バックエンドは素の API ではなくエージェント CLI なので、OpenAI の
サンプリング系パラメータが全部通るわけではありません。検証済みの挙動:

| パラメータ | Claude 系 | Codex 系 |
| --- | --- | --- |
| `temperature` | ✅ 本物のサンプリング制御 | 無視（バックエンドが拒否） |
| `top_p` | ✅ | 無視 |
| `stop` / `stop_sequences` | ✅（サーバー側で切断） | 無視 |
| `reasoning_effort` / `:suffix` | ✅ | ✅ |
| `verbosity`（`low`/`medium`/`high`） | 無視 | ✅ 応答長の制御 |
| `response_format: {"type":"json_object"}` | プロンプト注入方式（```フェンス付きで返ることあり — クライアント側で剥がすこと） | プロンプト注入方式（生 JSON が返る） |
| `max_tokens`・`n`・`seed`・penalty 系・`logit_bias`・`logprobs`・`user` | 無視 | 無視 |

補足:

- Claude のサンプリングは CLI の API リクエストに `CLAUDE_CODE_EXTRA_BODY`
  を注入して実現しています。このとき extended thinking は自動オフになる
  （API が thinking 中は `temperature: 1` しか受けないため）ので、通常
  リクエストと挙動が少し変わります。`temperature: 0` で決定的な出力に
  なります。
- ChatGPT-Codex バックエンドはサンプリング制御を明示拒否
  （`Unsupported parameter: temperature`）するため、Codex 側は配線の
  しようがありません。代わりに `reasoning_effort` と `verbosity` を
  使ってください。同一プロンプトでの `verbosity` の実測: low ≈ 0.9KB、
  medium ≈ 1.4KB、high ≈ 2〜5KB。

```bash
# Claude で決定的な出力
curl http://localhost:11435/v1/chat/completions -H "Content-Type: application/json" \
  -d '{"model":"haiku","temperature":0,"messages":[{"role":"user","content":"..."}]}'

# Codex で短い回答
curl http://localhost:11435/v1/chat/completions -H "Content-Type: application/json" \
  -d '{"model":"gpt-5.6-terra","verbosity":"low","messages":[{"role":"user","content":"..."}]}'
```

## 画像生成（Codex 系モデル）

`POST /v1/images/generations` — OpenAI Images API 互換。Codex CLI 内蔵の
`image_generation` ツールを ChatGPT サブスクリプション経由で使うため
**API 課金なし**。Claude 系モデルでは使えません（400）。

```bash
curl http://localhost:11435/v1/images/generations -H "Content-Type: application/json" -d '{
  "model": "gpt-5.6-terra",
  "prompt": "月明かりの麦畑を飛ぶメンフクロウの水彩画",
  "size": "1536x1024",
  "quality": "hd"
}'
```

| フィールド | 意味 |
| --- | --- |
| `prompt` | 必須 — 画像の説明（日本語テキストも正確に描画される） |
| `model` | 任意の Codex モデル（既定 `codex`） |
| `size` | 例: `1024x1024` · `1536x1024` · `1024x1536`（無指定 → 1254×1254） |
| `quality` | `standard`（既定）または `hd` |
| `n` | 1〜4 枚（直列生成） |
| `image` | *（独自拡張）* 編集の参照にするローカル画像のパス |

レスポンス: `{ "created": ..., "data": [{ "b64_json": "...", "path": "..." }] }`
— `path`（独自拡張）は `~/.barnowl/images/` に保存されたコピーです。

ツール自体には size/quality のパラメータが存在せず、barnowl がプロンプト
経由で指示します（実測: `1536x1024` 指定 → ぴったり 1536×1024 の PNG）。
生成時間は標準・正方形で約 2〜3 分、HD・横長で約 5〜6 分。画像ルートは
10 分枠で動きます（`BARNOWL_IMAGE_TIMEOUT_MS` で上書き可）。

生成は [codex-image](https://github.com/Leon-llb/codex-image) の vendored
コピー（`vendor/codex-image`、MIT）経由で、barnowl 拡張として
`--model`/`--quality` 対応・汎用プロンプトテンプレート・高速起動フラグを
加えています。

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

## 送信 PII ガード

外に出るリクエストを全経路で検査するオプション機能。`POST /v1/messages`
（Anthropic パススルー）も追加され、Claude Code のトラフィックも検査できる:

```
Claude Code ── ANTHROPIC_BASE_URL=http://localhost:11435 ──► barnowl
  ├ /v1/messages, /v1/files ほか ガード → api.anthropic.com へそのまま転送
  └ /v1/chat/completions など既存 ガード → 従来どおりローカルエンジンへ
```

```json
{ "guard": { "enabled": true, "policy": "~/path/to/policy-dir",
  "llm": { "url": "http://127.0.0.1:11434/v1/chat/completions", "model": "qwen2.5:3b" } } }
```

- **テキスト**はマスクコマンド（既定 `node ~/.claude/hooks/secret-guard.mjs mask`）で
  `<名前>` `<電話番号>` 等の決定的トークンに置換して転送（プロンプトキャッシュ維持）
- **画像・文書・音声**はマスク不能なので `403 guard_blocked` で拒否
- **fail-closed**: マスクコマンドの不在・異常終了・タイムアウト（30s）は全て拒否。
  マスクなしで転送されることはない
- `policy` ディレクトリの `secret-guard.json` が `SECRET_GUARD_CONFIG` として
  マスクコマンドに渡る
- `/v1/messages` はクライアント自身の認証ヘッダをそのまま上流へ転送
  （API キーで動作確認済み）。ローカルの Claude Code ログインで叩く場合は
  後述の **サブスクで Messages API を叩く** を参照
- `llm` — 任意の OpenAI 互換 LLM（Ollama / LM Studio / vLLM / LiteLLM など）に
  マスク後の残留 PII を判定させる二次チェック。leak 判定 → `403`。判定のみで
  書き換えはしない。マスクトークンは除去してから渡す（小型モデルの誤検出対策。
  `qwen2.5:3b` で 6/6 正解を実測）。チャンク単位の判定はハッシュでキャッシュされ、
  再送された会話履歴は再チェックしない。リモート LLM を指すとそれ自体が送信に
  なるのでローカル推奨。チェッカー障害も fail-closed

- ガードがマスクできるのは **Messages 形式のボディ** だけ（`/v1/messages`、
  `/v1/messages/count_tokens`、`/v1/messages/batches` — バッチ内の各
  リクエスト）。ガード ON の時、それ以外の転送対象ボディは
  `403 guard_blocked` で拒否する（agent 設定、skill、multipart のファイル
  アップロード等）。ボディの無いメソッド（GET / DELETE）は通す

環境変数: `BARNOWL_GUARD` `BARNOWL_GUARD_POLICY` `BARNOWL_GUARD_MASK_CMD`
`BARNOWL_GUARD_UPSTREAM`

## Anthropic API の残り（パススルー）

同じパススルーがファーストパーティ API 全面を全メソッドで中継するので、
Anthropic SDK を barnowl に向けるとチャット以外も叩ける:

```
/v1/messages            /v1/files        /v1/agents        /v1/vaults
/v1/messages/batches    /v1/skills       /v1/sessions      /v1/memory_stores
/v1/messages/count_tokens                /v1/environments  /v1/deployments
/v1/organizations                                          /v1/deployment_runs
```

この一覧の外はローカル処理のまま: `/v1/models` と `/api/tags` は barnowl 自身の
カタログ、`/v1/chat/completions` `/v1/images/generations` と Ollama 系は
ローカルの claude / codex エンジン。クエリとサブパスは保持するので
`GET /v1/messages/batches/{id}/results` や SSE のセッションストリームも通る。

実 API キーを使うなら単なるリバースプロキシ。サブスクログイン（次節）では
**大半が認可されていない** — 2026-11-01 実測:

| エンドポイント | サブスクログイン |
| --- | --- |
| `/v1/messages`, `/v1/messages/count_tokens` | 動く |
| `/v1/files` | 動く（`user:file_upload` スコープ） |
| `/v1/messages/batches` | `403 permission_error` — `user:batch` / `user:developer` / `workspace:developer` / `workspace:inference` のいずれかが必要 |
| `/v1/agents`, `/v1/sessions`（Managed Agents） | `403 permission_error` — "OAuth token lacks a scope this endpoint accepts" |

この 403 は barnowl ではなく Anthropic が返している。Claude Code の
ログインに付くスコープは `user:inference` `user:profile` `user:file_upload`
`user:mcp_servers` `user:plugins` `user:sessions:claude_code` だけなので、
Batch API と Managed Agents は API キーが必要。barnowl はどちらでも転送する。

## サブスクで Messages API を叩く（`messages.oauth`）

`POST /v1/messages` は既定ではクライアントの認証情報をそのまま上流へ流します。

```json
{ "messages": { "oauth": true } }
```

を設定すると、barnowl が **ローカルの Claude Code ログイン**（CLI エンジンが
使うのと同じ keychain / `.credentials.json`）で上流に認証します。クライアント
側に Anthropic API キーは不要で、Messages API とそのサーバーツールが
トークン課金ではなくサブスク枠で動きます。

送信時に barnowl が書き換えるもの:

- クライアントの `Authorization` / `x-api-key` を捨て、
  `Authorization: Bearer <ローカル OAuth トークン>` を付ける
- `anthropic-beta` に `oauth-2025-04-20` をマージ（クライアント指定の beta は
  保持）。`anthropic-version` が無ければ `2023-06-01` を補う
- `system` の先頭に Claude Code の identity ブロックを挿入し、クライアント自身の
  system プロンプトはその直後に残す（`/v1/messages`、
  `/v1/messages/count_tokens`、`/v1/messages/batches` の各リクエストが対象）。**必須**: このログインは Claude Code の
  トラフィックにしか認可されておらず、先頭が別の system ブロックだと
  `{"type":"error","error":{"type":"rate_limit_error","message":"Error"}}`
  が返る（ドキュメント化されていない挙動。実測）
- アクセストークンが切れていれば（期限の 2 分前から）barnowl 自身が更新する。
  store に並んで入っている refresh token を使い、CLI と同じ
  `POST https://platform.claude.com/v1/oauth/token`、CLI と同じ client id で
  交換する。同時リクエストは 1 回の更新を共有する
- 更新結果は元の store に書き戻す。既存の blob にマージするので
  `subscriptionType` / `rateLimitTier` は保持される。これは任意ではない:
  サーバーは refresh token を **ローテートする**（実測）ので、書き戻さないと
  Claude Code 側が死んだ refresh token を持つことになる。代償として Claude
  Code が同時に同じ項目を書くと競合する（後から書いた方が勝ち、負けた側は
  次回利用時に再更新されるだけ）
- `401` を返すのは更新材料が無い時だけ: ログイン自体が無い、refresh token が
  無い（`CLAUDE_CODE_OAUTH_TOKEN` 直指定など）、refresh token も失効している。
  その場合は `claude` で再ログインする

実測の寿命（Max ログイン）: アクセストークン約 8 時間、refresh token 約 7 日
（store の `refreshTokenExpiresAt`）。つまり barnowl を放置しても 1 週間程度は
CLI を起動せずに使える。

```bash
curl http://localhost:11435/v1/messages \
  -H "content-type: application/json" \
  -d '{"model":"claude-sonnet-5-5","max_tokens":1024,
       "tools":[{"type":"web_search_20250305","name":"web_search","max_uses":1}],
       "messages":[{"role":"user","content":"今日のニュースを検索して"}]}'
```

サーバーツールの実測（2026-11-01、Claude Max ログイン、`claude-sonnet-5-5`）:

| ツール | 結果 |
| --- | --- |
| `web_search_20250305` | 動く（`server_tool_use.web_search_requests: 1`） |
| `web_fetch_20250910` | 動く（`web_fetch_result` ドキュメントが返る） |
| `code_execution_20260521` | **使えない** — `bash_code_execution_tool_result_error` / `too_many_requests`、40 秒間に 3/3 で失敗 |
| `web_search_20260209`, `web_fetch_20260209` | **使えない** — 内部で code execution を使うため同じエラー |

つまり dynamic filtering 版とサンドボックス依存のツールは実 API キーが必要で、
素の web search / fetch はサブスクで動きます。サブスクのログインをこの用途に
使うことが Anthropic の規約に収まるかの判断は **利用者側**。barnowl は転送しか
しません。

`oauth` を切っている既定状態では挙動は変わりません（クライアント認証をそのまま
流す素通し）。

環境変数: `BARNOWL_MESSAGES_OAUTH=1`

### 資格情報のスナップショット

refresh token がローテートするので、store への書き込みを失敗すると復帰手段が
無くなる。そこで書き戻しの前に必ず上書き対象をスナップショットする。保存先は
`<state dir>/credentials-backup/`（ディレクトリ `0700`、ファイル `0600`、
新しい 5 件を保持）:

```bash
barnowl creds list              # 現在の store と全スナップショット（秘密は出さない）
barnowl creds backup            # 今の store をスナップショット
barnowl creds restore [file]    # 書き戻す（ファイル省略で最新）
```

`restore` も上書き前に現状をスナップショットするので戻せる。復元した
*アクセス* トークンは大抵もう失効しているが、重要なのは中の refresh token で、
次のリクエストで barnowl が交換する。

### wire ログ・capture・rewrite

`/v1/messages` パススルーに、config `messages` ブロック配下の独立した3スイッチ:

```json
{
  "messages": {
    "log": "~/barnowl-messages.log",
    "capture": true,
    "rewrite": "~/barnowl-rewrite.json"
  }
}
```

- **`log`**（env `BARNOWL_MESSAGES_LOG`）— `/v1/messages` のリクエストと上流の
  生レスポンス（SSE フレーム込み。Anthropic の `message_start` /
  `content_block_delta` / `message_delta` / `message_stop` が見える）をファイルに
  tee。ボディは**平文**、`Authorization` / `x-api-key` だけ伏せ字。private な
  場所へ。ログ有効時は各レスポンスから `stop_details` を抜いて1行要約
  （`--- stop: reason=... category=... ---`）を追記し、refusal は category の
  日本語説明つきで stdout にも出す。
- **`capture`**（env `BARNOWL_MESSAGES_CAPTURE`）— spawn する `claude` CLI の
  `ANTHROPIC_BASE_URL` を barnowl 自身に向け、OpenAI エンジン経路
  （`/v1/chat/completions`、seal 含む）の Anthropic 通信を `/v1/messages` 経由に
  して上のログに乗せる。barnowl の転送先は `BARNOWL_GUARD_UPSTREAM`（実
  Anthropic）なので周回しない。ログ未指定なら `<state dir>/messages.log` に自動
  有効化。
- **`rewrite`**（env `BARNOWL_MESSAGES_REWRITE`）— JSON ファイルパス、または
  `{ "when": {<dot.path>: 値 | [値,...]}, "set": {<dot.path>: "テンプレート"} }`
  ルールのインライン配列。barnowl がパースする全レスポンスオブジェクト（SSE
  イベント・バッファ JSON。イベントの `delta` 配下も見るので両形式で同じパスが
  効く）に適用。`when` はパスの AND、`set` のテンプレートは `{dot.path}` で発火前
  の値を差し込む。親が既存の時だけ代入（構造は捏造しない）。複数ルールは順に
  適用（後勝ち）。refusal 限定ではなく**任意フィールド**を書き換える。

  refusal の日本語化（`stop_details.explanation` を表示するクライアントで見える）
  — カテゴリごとに1ルール、`{stop_details.explanation}` で英語原文を保持:

  ```json
  [
    { "when": { "stop_reason": "refusal", "stop_details.category": "cyber" },
      "set":  { "stop_details.explanation": "サイバー被害につながりうる要求として拒否されました。（原文: {stop_details.explanation}）" } }
  ]
  ```

  クライアントが `explanation` を実際に表示するかはクライアント依存。
  `stop_details.type` / `category` を書き換えるとクライアントの分岐やサーバー
  サイド fallback ルーティングに影響しうる。純粋な日本語化なら `explanation`
  だけ触る。

## 開封トラッキング（read receipts）

送る HTML/メールに 1x1 ピクセルを仕込む。受信者が開くと、そのビューアが起動中の
barnowl から `http://<host>/t/<id>.gif` を取得し、開封が `<state dir>/beacons.json`
にローカル記録される（回数、初回/最終時刻、ヒットごとの IP / User-Agent / Referer）。
barnowl 自身は何も送らない。呼びに来るのは受信者のビューア。

```bash
echo "<p>本文です" > body.html
barnowl beacon make your-host:11435 "件名" body.html --label tanaka -o memo.html
#   → memo.html（本文 + インラインピクセル）を書き出し、id を表示
barnowl beacon list                 # ローカルの集計（回数・時刻・IP・クライアント）
barnowl beacon id tanaka            # ユニーク id だけ発行
```

ピクセル経路は受信者が到達できるよう auth より前で動く。`GET /beacons`（集計）は
**ループバック限定**。読み出しは起動中のサーバー（パッチ済み otterly）が返すので、
`barnowl start` が `<host>` で到達可能である必要がある。

**分かること・分からないこと** — メールの開封通知と同じ仕組みなので同じ扱いにする
（受信者に伝える）:

- 「誰が」は推定でしかなく、**受信者ごとにユニーク id**（`--label <名前>`）を振って
  初めて「その id の開封 ≈ その人（または転送先）」と結びつく。
- IP は身元ではない（NAT / VPN / モバイル）。メールの画像プロキシ（Gmail 等）は
  配信時にピクセルを**先読み**する → プロバイダの IP と、本人が見る前の偽の「開封」。
  トラッカー遮断で完全に抑止される（回数0 ≠ 未読）。
- 確実に仕込めるのは HTML/メールのみ。素の `.txt` や画像単体は不可、DOCX/PDF の
  外部参照はビューアがブロックすることが多い。

これは**自分が送る自分のファイル**の開封を数えるもので、他人のマシンでコードを
実行する手段ではない。

## 封印チャット（seal relay）

クライアント側のヘルパー。リクエストの **ペイロード** を、barnowl 自身の
ログや、クライアント↔barnowl 間に挟まる TLS 終端中間層から隔離します。
ペイロードはクライアントを出る前にセッションごとに生成した AES-256-GCM
鍵で暗号化され、その鍵・IV・暗号文を Bash + Python で復号せよと指示する
system prompt に埋め込んで送ります。Claude がシェル経由で復号し、平文を
自分の推論コンテキスト内で読み、答えを返します。何を隠し、何を隠さないか:

| レイヤ | 隠れる？ |
| --- | --- |
| client ↔ barnowl（localhost、他プロセスの snooping） | ✅ 暗号文のみ |
| barnowl 自身のログ・リクエストダンプ | ✅ 暗号文のみ |
| Claude が復号した後の Anthropic / upstream | ❌ Claude の推論コンテキストに平文 |
| 応答モデレーション・safety 分類器 | ❌ 復号後の意図にそのまま適用される |

**向いている用途**: 社内の顧客レコード、設定ファイル、監査ログに平文を
残したくないリクエスト。**向かない用途**: ベンダから意図を隠す目的 —
タスク文も復号後の内容もモデルには届きます。

セットアップ:

```bash
# spawn される claude CLI に Bash tool だけを許可する。デフォルトは
# 「全ネイティブツール無効」(fast path, 1 リクエスト ~6s) で、
# --allow-tools はそのキルリストから指定分だけ差し引きます。
barnowl start --allow-tools Bash
# もしくは config.json に  "allowTools": "Bash"
# もしくは環境変数で       BARNOWL_ALLOW_TOOLS=Bash
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

設計メモ:

- **呼び出しごとに ephemeral key**（`lib/seal/crypto.js` の `newKey()`）。
  生の `Buffer` はリクエスト直後にゼロ埋め。system prompt に埋めた
  hex 文字列と JSON body 中の値は JS String なので zero-fill 不可。
- **認証付き暗号**: GCM の auth tag を暗号文末尾に連結しているため、
  埋め込みバイト列を改変すると復号時に失敗します（破損したバイト列を
  黙って通さない）。
- **tool_result 境界**: 復号後のテキストは Claude からは「ツール出力
  (データ)」として扱われ、新しい指示 (role=user) に昇格しません。
  復号結果に prompt injection が仕込まれていても、system+user の
  本来の指示が優先されます。
- **Bash 必須**: `--allow-tools Bash` なしで seal relay を使うと、
  system prompt に書かれたエスケープハッチが発動して Claude は
  「sealed-mode requires --allow-tools Bash」と返して停止します。
- **送信 PII ガードとの比較**: 両者は別物。ガードは平文を見てから
  トークナイズして送るので **ベンダに個人情報を見せない** 用途。
  seal は payload を中間層から隠すが **ベンダは復号後の平文を見る**。
  併用可能。

テストは `test/seal.test.js` `test/seal-relay.test.js`
`test/patch-tools.test.js` で、暗号チェーン・patch IIFE の env 変種・
system prompt 構造を網羅した 20 ケース。

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
  "rateLimit": 60,
  "autoUpdate": true
}
```

- `mcp` — MCP プロファイル: `config/mcp/<name>.json` の名前、ファイルパス、
  または `"none"` で無効化。
- ファイル探索順: `--config <path>` > `./barnowl.config.json` > `~/.barnowl/config.json`。
- ファイル内の `apiKey` は起動時に `BARNOWL_API_KEY`（Bearer 認証）として設定されます。
- `autoUpdate` — `false` にすると `start` 時の `origin/main` への
  fast-forward を行いません。
- `messages.oauth` — `true` で `POST /v1/messages` がクライアントのキーでは
  なくローカルの Claude Code ログインで認証します（**サブスクで Messages API
  を叩く** 参照）。
- `allowTools` — `--allow-tools` フラグ / `BARNOWL_ALLOW_TOOLS` 環境変数と
  同じ。デフォルトのキルリストから差し引く native tool 名をスペース/
  カンマ区切りで指定（例: seal relay 用の `"Bash"`）。未設定 →
  全ツール無効。

## 設定（環境変数）

| 変数                      | デフォルト | 意味                            |
| ------------------------- | --------- | ------------------------------- |
| `BARNOWL_PORT`            | `11435`   | 待ち受けポート                  |
| `BARNOWL_WORK_DIR`        | cwd       | Claude の作業ディレクトリ       |
| `BARNOWL_API_KEY`         | （未設定）| 設定すると Bearer 認証を必須化  |
| `BARNOWL_AUTO_UPDATE`     | （有効）  | `0` で起動時の GitHub 更新確認を省略 |
| `BARNOWL_QUEUE_TIMEOUT`   | `300`     | キュー待ちタイムアウト（秒）    |
| `BARNOWL_MAX_CONCURRENT`  | `5`       | 最大同時リクエスト数            |
| `BARNOWL_MAX_QUEUE`       | `50`      | 最大キュー数                    |
| `BARNOWL_RATE_LIMIT`      | `60`      | クライアントごとの毎分リクエスト数 |
| `BARNOWL_ALLOW_TOOLS`     | (未設定)  | スペース/カンマ区切りで復活させるネイティブツール名（例: seal relay 用の `Bash`）。デフォルトのキルリストはそのまま適用され、ここに書いた名前だけ差し引かれる。 |
| `BARNOWL_ENABLE_TOOLS`    | `0`       | `1` にすると全ネイティブツールを復活（完全な regression — 遅くなる）。 |
| `BARNOWL_SESSION_IDLE`    | `600`     | ウォームセッション回収までの秒数 |
| `BARNOWL_MAX_SESSIONS`    | `8`       | live セッションプロセスの上限   |
| `BARNOWL_WARM_SESSIONS`   | （有効）  | `off` でウォームプール無効化    |
| `BARNOWL_CLAUDE_BIN`      | `claude`  | ウォームセッション用 claude バイナリ |
| `BARNOWL_CODEX_BIN`       | （自動）  | codex バイナリのパス            |
| `BARNOWL_CODEX_EFFORT`    | （未設定）| Codex 系のデフォルト effort     |
| `BARNOWL_CODEX_SANDBOX`   | `read-only` | チャット時の codex サンドボックス |
| `BARNOWL_CODEX_TIMEOUT_MS`| `300000`  | Codex チャットのリクエスト kill |
| `BARNOWL_IMAGE_TIMEOUT_MS`| `600000`  | 画像生成 1 枚あたりの kill      |
| `BARNOWL_MESSAGES_OAUTH`  | （無効）  | `1` で `/v1/messages` をローカル Claude Code ログインで認証 |

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
