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

### MCP プロファイル（サーバーサイドツール）

MCP は**デフォルトでオフ**です（それが速さの源）。使うときはプロファイル単位で
明示的にオプトインします。`--mcp <name>` は `config/mcp/<name>.json` **だけ** を
読み込みます（CLI の `--strict-mcp-config --mcp-config` 経由）。otterly が起動する
`claude` がその MCP サーバーを保持し、**ツールを自分で実行**するので、
プレーンなチャットリクエスト（OpenAI の `tools` 配列なし）で駆動できます:

```bash
curl http://localhost:11435/v1/chat/completions -H "Content-Type: application/json" -d '{
  "model":"sonnet",
  "messages":[{"role":"user","content":"スプレッドシート <ID> のワークシート一覧とタイトルを報告して。"}]
}'
```

プロファイルは標準の `mcpServers` マップ（Claude Code と同じ形式）です。
例: HTTP の MCP ゲートウェイを指す場合:
```json
{ "mcpServers": { "sheet": { "type": "http", "url": "http://localhost:8080/mcp" } } }
```
プロファイルは `config/mcp/` に置き、**gitignore 対象**です（プライベートな
URL やキーを含みがちなため）。HTTP/SSE サーバーは接続が速い（サブプロセス起動が
ない）ので、1〜2個なら高速なままです（ツール往復込みで約10〜15秒）。

**詳細ガイド — [docs/mcp.md](docs/mcp.md):** Claude Code に登録済みのサーバー
（`~/.claude.json`、プラグイン、claude.ai コネクタ）の移行方法、パフォーマンス
指針、トラブルシューティング。

**実行モデルは2種類 — ツールの種類で選ぶ:**
| | ツールを実行するのは | 必要なバックエンド |
| --- | --- | --- |
| サーバーサイド（この `--mcp` モード） | otterly の `claude` | barnowl — `tools` 配列なしの**プレーン**リクエストを送る |
| クライアントサイド（OpenAI function-calling） | あなたのアプリ | **ネイティブ**な tool-use バックエンド（例: Anthropic API）— otterly のプロンプト注入型ツール呼び出しは system プロンプト併用時に拒否される |

ページ内で動く必要があるブラウザ系ツールはクライアントサイドのみ対応で、
ネイティブバックエンドが必要です。どこでも実行できる MCP ツール
（Sheets・DB・HTTP）は `--mcp` のサーバーサイドが最適です。

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

