# 🧚 NoteWithPixie

ローカル環境で完結する、Web ベースの AI マークダウンエディタ。
左ペインで執筆（Monaco Editor）、右ペインでファイル参照＋AI チャット。
AI の修正案をワンクリックでエディタの選択範囲へ差分反映できる。

## 特徴
- **完全ローカル / セキュア**: `127.0.0.1` バインド、ワークスペース外のファイルには一切触れない。
- **エージェントモード**: チャットが必要に応じて自分でツールを使う（ワークスペースの一覧・全文検索・ファイル読取、Copilot 相談）。ツールは **read 系のみ** — エディタへの反映は従来どおり人間がクリックで行う。
- **Copilot 相談（`ask_copilot`）**: [PrayLight](../PrayLight) 経由で Microsoft Copilot（Web版）に単発質問し、回答をチャットに取り込める（要: PrayLight 側でブラウザ起動＋ログイン）。
- **OpenAI 互換バックエンド**: Ollama / LM Studio / llama.cpp server を `.env` の URL 切替だけで利用。
- **爆速ファイル参照**: ripgrep によるワークスペース全文検索（rg 未導入時は Python でフォールバック）。
- **確実な差分反映**: AI 応答内の <code>```apply</code> ブロックのみを抽出して選択範囲へ適用するため、挨拶や解説がエディタに混入しない。
- **インライン付箋**: 行に📌メモを貼れる。ローカル JSON に永続化。

## セットアップ
```bat
:: 1) 依存インストール（pipenv, in-project venv）
open_py312.bat            :: もしくは  python -m pipenv install

:: 2) （任意・推奨）Monaco をローカルに取り込みオフライン化
python -m pipenv run python scripts/fetch_monaco.py

:: 3) 設定
copy .env.example .env    :: 使う LLM に合わせて編集

:: 4) 起動
run.bat                   :: -> http://127.0.0.1:8765
```

Ollama を使う場合の例:
```
ollama pull qwen2.5:7b-instruct
```
`.env` の `NWP_CHAT_MODEL` を pull したモデル名に合わせる。

## 構成
```
app/            FastAPI バックエンド
  main.py       ルーティング（files/search/notes/chat/models）
  agent.py      軽量エージェントループ（function calling / SSE イベント）
  tools.py      エージェント用ツール（read系 + ask_copilot）
  llm.py        OpenAI 互換ストリーミング + プロンプト設計（非エージェント時）
  files.py      ワークスペース安全アクセス
  search.py     ripgrep ラッパ
  config.py     設定（NWP_* / .env）
static/         フロント（Monaco + Vanilla JS）
scripts/        fetch_monaco.py（オフライン用ベンダリング）
workspace/      編集対象ファイル置き場（この外は触れない）
```

## エージェントモード
`.env` の `NWP_AGENT_MODE=true`（既定）でチャットがツールを自律的に使う。

| ツール | 動作 |
|---|---|
| `list_workspace` | ワークスペースのファイル一覧 |
| `grep_workspace` | ripgrep 全文検索 |
| `read_note` | ファイル読取（ワークスペース外は拒否） |
| `ask_copilot` | PrayLight subprocess 経由で Copilot に単発質問（数十秒かかる） |

- 書き込みツールは意図的に無い。反映は <code>```apply</code> ブロック → ユーザーのクリック。
- ツール実行の様子はチャット内にステータス行（🔧/✅/⚠️）として流れる（本文・履歴には含めない）。
- `ask_copilot` を使うには、先に PrayLight 側で `python start_browser.py` を実行して Copilot にログインしておく（[PrayLight README](../PrayLight/README.md) 参照）。
- モデルは **function calling 対応のもの**を使うこと（例: qwen3-coder 系。ツール非対応モデルだと空応答→ツール無し再生成のフォールバックが働く）。
- 関連設定: `NWP_AGENT_MAX_STEPS`（ツール往復上限・既定6）、`NWP_PRAYLIGHT_DIR` / `NWP_PRAYLIGHT_PYTHON` / `NWP_COPILOT_TIMEOUT`。

### 設計メモ：3プロジェクトの関係
- **AnythingWithPixie** = エージェント CLI（Core）。将来ここからループ骨格を `pixie-core` として切り出し、本アプリの `agent.py` を置き換える構想（Phase 1）。現状の `agent.py` はその場つなぎの最小実装（Phase 0）。
- **PrayLight** = Copilot 単発取得 CLI。本アプリからは subprocess として利用するだけで、リポジトリは独立。

## 設計メモ：モードA/B の統合
元案の「反映時に軽量モデルが選択テキストを再生成（モードB）」は廃止した。
モードA が生成した確定テキストを <code>```apply</code> フェンスで構造化して返し、
フロントがそれを厳密抽出して置換するため、2 回目の LLM 呼び出しが不要になり
**高速・決定的・幻覚なし**になる。全文書の複数箇所編集が必要になったら
検索/置換ブロック方式へ拡張するのが次の一手。
```
