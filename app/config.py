"""アプリ設定。config.json、環境変数 (NWP_*)、.env で上書き可能。

優先順位: 環境変数 > .env > config.json > デフォルト値。
config.json はプロジェクトルート（この app/ の親）に置き、キーはフィールド名そのまま
（プレフィックスなし）。例:
    { "workspace_root": "C:/Users/xxx/OneDrive - Honda/NoteWithPixie" }
"""
import json
from pathlib import Path

from pydantic_settings import (
    BaseSettings,
    JsonConfigSettingsSource,
    PydanticBaseSettingsSource,
    SettingsConfigDict,
)

PROJECT_ROOT = Path(__file__).resolve().parent.parent
CONFIG_JSON = PROJECT_ROOT / "config.json"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_prefix="NWP_",
        json_file=CONFIG_JSON,
        json_file_encoding="utf-8-sig",  # メモ帳保存の BOM 付き UTF-8 も許容
        extra="ignore",
    )

    @classmethod
    def settings_customise_sources(
        cls,
        settings_cls: type[BaseSettings],
        init_settings: PydanticBaseSettingsSource,
        env_settings: PydanticBaseSettingsSource,
        dotenv_settings: PydanticBaseSettingsSource,
        file_secret_settings: PydanticBaseSettingsSource,
    ) -> tuple[PydanticBaseSettingsSource, ...]:
        return (
            init_settings,
            env_settings,
            dotenv_settings,
            JsonConfigSettingsSource(settings_cls),
            file_secret_settings,
        )

    # LLM バックエンド（OpenAI 互換エンドポイント）
    # Ollama:   http://localhost:11434/v1
    # LM Studio: http://localhost:1234/v1
    llm_base_url: str = "http://localhost:8080/v1"
    llm_api_key: str = "not-needed"  # ローカルサーバは無視するが SDK 互換のため送る
    chat_model: str = "qwen3.6"

    # ファイル参照のルート（このディレクトリ外は一切触れない）。
    # config.json で OneDrive 等の任意フォルダに変更できる。
    # 相対パスはプロジェクトルート基準で解決する。
    workspace_root: str = "./workspace"

    # サーバ（ローカル専用にバインド）
    host: str = "127.0.0.1"
    port: int = 8765
    reload: bool = False  # True でコード変更時に自動再起動（開発用。NWP_RELOAD=1）

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
    # copilot_enabled=False で Copilot 連携（ask_copilot ツール・/copilot 直接質問・
    # Copilot バー）をまとめて無効化する。GUI の設定（⚙️）から切り替え・永続化できる。
    copilot_enabled: bool = True
    praylight_dir: str = "../AskCopilot"
    praylight_python: str = ""         # 空なら {praylight_dir}/.venv/Scripts/python.exe
    copilot_timeout: float = 120.0     # Copilot 応答待ちの上限秒数


settings = Settings()

def _resolve_root(raw: str) -> Path:
    p = Path(raw).expanduser()
    return (p if p.is_absolute() else PROJECT_ROOT / p).resolve()


# 実行中に GUI から切り替わるため、参照側は値を import せず
# `from . import config` して config.WORKSPACE を毎回読むこと。
WORKSPACE = _resolve_root(settings.workspace_root)
WORKSPACE.mkdir(parents=True, exist_ok=True)


def _read_config_json() -> dict:
    if CONFIG_JSON.exists():
        try:
            return json.loads(CONFIG_JSON.read_text(encoding="utf-8-sig"))
        except json.JSONDecodeError:
            return {}  # 壊れた config.json は無視して作り直す
    return {}


def _write_config_json(data: dict) -> None:
    CONFIG_JSON.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def set_config(**kwargs) -> None:
    """任意の設定キーを config.json に永続化し、稼働中の settings にも反映する。
    GUI（⚙️ 設定）からの copilot_enabled / chat_model などの切り替えに使う。"""
    data = _read_config_json()
    for key, value in kwargs.items():
        setattr(settings, key, value)
        data[key] = value
    _write_config_json(data)


def set_workspace(raw: str) -> Path:
    """ワークスペースルートを切り替え、config.json に永続化する（再起動後も有効）。"""
    global WORKSPACE
    raw = (raw or "").strip()
    if not raw:
        raise ValueError("パスを指定してください。")
    p = _resolve_root(raw)
    if p.is_file():
        raise ValueError(f"ファイルが指定されました。フォルダを指定してください: {p}")
    p.mkdir(parents=True, exist_ok=True)  # 無ければ作る（OneDrive 配下の新規フォルダ等）

    data: dict = {}
    if CONFIG_JSON.exists():
        try:
            data = json.loads(CONFIG_JSON.read_text(encoding="utf-8-sig"))
        except json.JSONDecodeError:
            data = {}  # 壊れた config.json は workspace_root だけで作り直す
    data["workspace_root"] = str(p)
    CONFIG_JSON.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    settings.workspace_root = str(p)
    WORKSPACE = p
    return p
