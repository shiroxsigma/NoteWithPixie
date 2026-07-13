"""ワークスペース内のファイル操作。ルート外アクセスを厳格に禁止する。"""
from __future__ import annotations

from pathlib import Path

from . import config  # WORKSPACE は実行中に切り替わるため動的に参照する

# コンテキストとして扱える拡張子とマネージャに表示する拡張子
TEXT_EXTS = {".md", ".markdown", ".txt", ".py", ".json", ".yaml", ".yml", ".toml", ".csv", ".html", ".css", ".js", ".ts"}
IGNORE_DIRS = {".git", ".venv", "__pycache__", "node_modules", ".idea", ".vscode"}
MAX_BYTES = 1_000_000  # 1MB を超えるファイルは丸ごと読まない


def safe_path(rel: str) -> Path:
    """相対パスを WORKSPACE 内の絶対パスに解決。外に出ようとしたら ValueError。"""
    root = config.WORKSPACE
    p = (root / rel).resolve()
    if p != root and root not in p.parents:
        raise ValueError(f"path escapes workspace: {rel}")
    return p


def _hidden(parts: tuple[str, ...]) -> bool:
    """無視ディレクトリ配下、またはドット始まり（.pixie_notes.json 等）を隠す。"""
    return any(part in IGNORE_DIRS or part.startswith(".") for part in parts)


def list_files() -> list[dict]:
    """ワークスペース内のファイルとフォルダをフラットリストで返す（type 付き）。"""
    root = config.WORKSPACE
    out: list[dict] = []
    for p in sorted(root.rglob("*")):
        rel_parts = p.relative_to(root).parts
        if _hidden(rel_parts):
            continue
        rel = p.relative_to(root).as_posix()
        if p.is_dir():
            out.append({"path": rel, "type": "dir"})
        elif p.is_file() and p.suffix.lower() in TEXT_EXTS:
            out.append({"path": rel, "type": "file", "size": p.stat().st_size})
    return out


def create(rel: str, kind: str) -> None:
    """空ファイルまたはフォルダを作成する。既存なら ValueError。"""
    p = safe_path(rel)
    if p.exists():
        raise ValueError(f"既に存在します: {rel}")
    if kind == "dir":
        p.mkdir(parents=True)
    else:
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text("", encoding="utf-8")


def rename(src: str, dst: str) -> None:
    """ファイル/フォルダの改名・移動（ワークスペース内のみ）。"""
    ps, pd = safe_path(src), safe_path(dst)
    if not ps.exists():
        raise FileNotFoundError(src)
    if pd.exists():
        raise ValueError(f"移動先が既に存在します: {dst}")
    pd.parent.mkdir(parents=True, exist_ok=True)
    ps.rename(pd)


def delete(rel: str) -> None:
    """ファイルを削除。フォルダは空の場合のみ削除（誤爆防止）。"""
    p = safe_path(rel)
    if not p.exists():
        raise FileNotFoundError(rel)
    if p.is_dir():
        if any(p.iterdir()):
            raise ValueError("フォルダが空ではありません。中のファイルを先に削除・移動してください。")
        p.rmdir()
    else:
        p.unlink()


def read_file(rel: str) -> str:
    p = safe_path(rel)
    if not p.is_file():
        raise FileNotFoundError(rel)
    if p.stat().st_size > MAX_BYTES:
        raise ValueError("file too large")
    return p.read_text(encoding="utf-8", errors="replace")


def write_file(rel: str, content: str) -> None:
    p = safe_path(rel)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(content, encoding="utf-8")
