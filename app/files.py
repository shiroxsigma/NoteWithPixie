"""ワークスペース内のファイル操作。ルート外アクセスを厳格に禁止する。"""
from __future__ import annotations

from pathlib import Path

from .config import WORKSPACE

# コンテキストとして扱える拡張子とマネージャに表示する拡張子
TEXT_EXTS = {".md", ".markdown", ".txt", ".py", ".json", ".yaml", ".yml", ".toml", ".csv", ".html", ".css", ".js", ".ts"}
IGNORE_DIRS = {".git", ".venv", "__pycache__", "node_modules", ".idea", ".vscode"}
MAX_BYTES = 1_000_000  # 1MB を超えるファイルは丸ごと読まない


def safe_path(rel: str) -> Path:
    """相対パスを WORKSPACE 内の絶対パスに解決。外に出ようとしたら ValueError。"""
    p = (WORKSPACE / rel).resolve()
    if p != WORKSPACE and WORKSPACE not in p.parents:
        raise ValueError(f"path escapes workspace: {rel}")
    return p


def list_files() -> list[dict]:
    """ワークスペース内のテキストファイルをツリー用のフラットリストで返す。"""
    out: list[dict] = []
    for p in sorted(WORKSPACE.rglob("*")):
        if any(part in IGNORE_DIRS for part in p.relative_to(WORKSPACE).parts):
            continue
        if p.is_file() and p.suffix.lower() in TEXT_EXTS:
            rel = p.relative_to(WORKSPACE).as_posix()
            out.append({"path": rel, "size": p.stat().st_size})
    return out


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
