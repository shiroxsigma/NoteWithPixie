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
- **関連ファイル参照**: 別ディレクトリの pptx/docx/xlsx/pdf をノートに紐付け、テキスト抽出して AI 文脈に流せる（Copilot への添付・既定アプリで開くも可）。
- **確実な差分反映**: AI は <code>```search</code>/<code>```replace</code> ペア（部分編集・複数箇所可）か <code>```apply</code>（全置換）で提案。適用前に Monaco DiffEditor の**差分プレビュー**（現在 vs 提案、右側は編集可）で確認してから反映。挨拶や解説がエディタに混入しない。
- **インライン付箋**: 行に📌メモを貼れる。ローカル JSON に永続化。
- **Markdown プレビュー**: 👁 ボタン / `Ctrl+Shift+P` でエディタ横に表示（既定はオフ、スクロール同期）。<code>```mermaid</code> フェンスは図として描画。AI の返信も同じレンダラで整形される。
- **失わない**: 2秒デバウンスの自動保存（切替・離脱の直前にも保存）、保存失敗の明示、未保存のままタブを閉じる際の警告。`Ctrl+S` はエディタ外でも効く。
- **会話履歴の永続化**: リロードしても復元。ワークスペースごとに分かれる（保存先を切り替えると履歴も切り替わる）。

## セットアップ
```bat
:: 1) 依存インストール（pipenv, in-project venv）
open_py312.bat            :: もしくは  python -m pipenv install

:: 2) （任意・推奨）Monaco をローカルに取り込みオフライン化
python -m pipenv run python scripts/fetch_monaco.py
python -m pipenv run python scripts/fetch_markdown_it.py   :: markdown-it も同様にローカル化
python -m pipenv run python scripts/fetch_mermaid.py       :: Mermaid（図表描画）も同様にローカル化

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
  patch.py      search/replace 提案の適用計算（AnythingWithPixie のファジーマッチを文字列ベースに移植）
  files.py      ワークスペース安全アクセス
  search.py     ripgrep ラッパ
  config.py     設定（NWP_* / .env）
static/         フロント（Monaco + Vanilla JS）
scripts/        fetch_monaco.py / fetch_markdown_it.py / fetch_mermaid.py（オフライン用ベンダリング）
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

## 設計メモ：反映フロー（ハイブリッド方式）
- モデルには unified diff を出させない（小型モデルでは記法が不安定・Markdown の `- ` と衝突）。
- 提案フォーマットは2つ: <code>```search</code>/<code>```replace</code> ペア（部分編集・複数箇所・長文に強い）と <code>```apply</code>（選択範囲の全置換）。
- search/replace の適用計算は `/api/patch` がサーバ側で行う（L1 完全一致 → L2 空白正規化 → L3 difflib ファジー。曖昧なら安全に失敗しヒントを返す）。**ファイルには書かない**。
- 適用はフロントの差分プレビュー（Monaco DiffEditor）で人間が確認・調整してからワンクリック。エージェントに書き込みツールを与えない原則はそのまま。
- `app/patch.py` は AnythingWithPixie の `_compute_search_and_replace_content` / `_fuzzy_apply` の文字列ベース移植。Phase 1 の pixie-core 切り出し候補。
