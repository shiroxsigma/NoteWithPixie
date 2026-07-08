"""アプリ設定。環境変数 (NWP_*) または .env で上書き可能。"""
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_prefix="NWP_", extra="ignore")

    # LLM バックエンド（OpenAI 互換エンドポイント）
    # Ollama:   http://localhost:11434/v1
    # LM Studio: http://localhost:1234/v1
    llm_base_url: str = "http://localhost:11434/v1"
    llm_api_key: str = "not-needed"  # ローカルサーバは無視するが SDK 互換のため送る
    chat_model: str = "qwen2.5:7b-instruct"

    # ファイル参照のルート（このディレクトリ外は一切触れない）
    workspace_root: str = "./workspace"

    # サーバ（ローカル専用にバインド）
    host: str = "127.0.0.1"
    port: int = 8765

    # ripgrep のパス（PATH にあれば "rg" のままでよい）
    rg_path: str = "rg"

    # --- エージェントモード ---
    # True: チャットがツール（ワークスペース参照・Copilot 相談）を自律的に使う。
    # False: 従来のチェックボックス添付方式のみ。
    agent_mode: bool = True
    agent_max_steps: int = 6          # 1回の依頼で許すツール往復の上限
    tool_result_max_chars: int = 8000  # ツール結果の切り詰め上限（コンテキスト保護）

    # --- PrayLight（Copilot 相談ツール）---
    # ask_copilot ツールが subprocess で PrayLight/copilot_ask.py を呼ぶ。
    praylight_dir: str = "../PrayLight"
    praylight_python: str = ""         # 空なら {praylight_dir}/.venv/Scripts/python.exe
    copilot_timeout: float = 120.0     # Copilot 応答待ちの上限秒数


settings = Settings()

WORKSPACE = Path(settings.workspace_root).expanduser().resolve()
WORKSPACE.mkdir(parents=True, exist_ok=True)
