"""ripgrep によるワークスペース内の高速全文検索。rg が無ければ Python でフォールバック。"""
from __future__ import annotations

import json
import shutil
import subprocess

from . import config  # WORKSPACE は実行中に切り替わるため動的に参照する
from .config import settings
from .files import IGNORE_DIRS, TEXT_EXTS


def _rg_available() -> bool:
    return shutil.which(settings.rg_path) is not None


def search(query: str, max_results: int = 50) -> list[dict]:
    """クエリにマッチした行を {path, line, text} のリストで返す。"""
    if not query.strip():
        return []
    if _rg_available():
        return _search_rg(query, max_results)
    return _search_python(query, max_results)


def _search_rg(query: str, max_results: int) -> list[dict]:
    globs: list[str] = []
    for ext in TEXT_EXTS:
        globs += ["-g", f"*{ext}"]
    for d in IGNORE_DIRS:
        globs += ["-g", f"!{d}/**"]
    cmd = [settings.rg_path, "--json", "-i", "--max-count", "5", *globs, query, str(config.WORKSPACE)]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=15)
    except (subprocess.TimeoutExpired, OSError):
        return _search_python(query, max_results)

    results: list[dict] = []
    for line in proc.stdout.splitlines():
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue
        if obj.get("type") != "match":
            continue
        data = obj["data"]
        path = data["path"]["text"]
        rel = _rel(path)
        results.append({
            "path": rel,
            "line": data["line_number"],
            "text": data["lines"]["text"].rstrip("\n")[:200],
        })
        if len(results) >= max_results:
            break
    return results


def _search_python(query: str, max_results: int) -> list[dict]:
    q = query.lower()
    root = config.WORKSPACE
    results: list[dict] = []
    for p in root.rglob("*"):
        if any(part in IGNORE_DIRS for part in p.relative_to(root).parts):
            continue
        if not (p.is_file() and p.suffix.lower() in TEXT_EXTS):
            continue
        try:
            for i, line in enumerate(p.read_text(encoding="utf-8", errors="replace").splitlines(), 1):
                if q in line.lower():
                    results.append({"path": p.relative_to(root).as_posix(), "line": i, "text": line[:200]})
                    if len(results) >= max_results:
                        return results
        except OSError:
            continue
    return results


def _rel(abs_path: str) -> str:
    from pathlib import Path

    try:
        return Path(abs_path).resolve().relative_to(config.WORKSPACE).as_posix()
    except ValueError:
        return abs_path
