"""エージェント用ツール群。ワークスペース限定の read 系 + PrayLight（Copilot）相談。

セキュリティ方針: 書き込み系ツールは登録しない。エディタへの反映は従来どおり
```apply ブロック → ユーザーのクリックで行う（エージェントが取得、人間が反映）。
"""
from __future__ import annotations

import asyncio
from pathlib import Path

from . import files, search
from .config import settings

# OpenAI 互換 function calling スキーマ
TOOLS_SPEC: list[dict] = [
    {
        "type": "function",
        "function": {
            "name": "list_workspace",
            "description": "ワークスペース内のテキストファイル一覧（相対パスとサイズ）を取得する。どんなファイルがあるか分からないときに最初に使う。",
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "read_note",
            "description": "ワークスペース内のファイルの中身を読む。path には list_workspace や grep_workspace が返す相対パスを渡す。",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "ワークスペースからの相対パス（例: ideas/plot.md）"},
                },
                "required": ["path"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "grep_workspace",
            "description": "ワークスペースの全テキストファイルからキーワードを検索し、マッチした行を path:line: text 形式で返す。どのファイルに書いたか探すときに使う。",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "検索キーワード（大文字小文字は区別しない）"},
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "ask_copilot",
            "description": (
                "Microsoft Copilot（Web版）に1回質問して回答を得る。最新情報・外部知識・推敲の別視点が欲しいときだけ使う。"
                "応答に数十秒かかるので乱用しない。Copilot はこの会話もワークスペースも見えないため、"
                "必要な文脈・本文はすべて question に含めること。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "question": {"type": "string", "description": "Copilot への質問文（自己完結した文章にする）"},
                },
                "required": ["question"],
            },
        },
    },
]


def _truncate(text: str, limit: int | None = None) -> str:
    limit = limit or settings.tool_result_max_chars
    if len(text) <= limit:
        return text
    return text[:limit] + f"\n…（長いため以降 {len(text) - limit} 文字を省略）"


async def execute(name: str, args: dict) -> str:
    """ツールを実行して結果文字列を返す。失敗も例外でなく文字列で返し、LLM に自己修正させる。"""
    try:
        if name == "list_workspace":
            items = files.list_files()
            if not items:
                return "（ワークスペースは空です）"
            return _truncate("\n".join(f"{f['path']} ({f['size']} bytes)" for f in items))
        if name == "read_note":
            return _truncate(files.read_file(str(args["path"])))
        if name == "grep_workspace":
            # search.search は subprocess.run（ブロッキング）なのでスレッドへ逃がす
            hits = await asyncio.to_thread(search.search, str(args["query"]))
            if not hits:
                return "（マッチなし）"
            return _truncate("\n".join(f"{h['path']}:{h['line']}: {h['text']}" for h in hits))
        if name == "ask_copilot":
            return await _ask_copilot(str(args["question"]))
        return f"エラー: 不明なツール '{name}'"
    except FileNotFoundError as e:
        return f"エラー: ファイルが見つかりません: {e}。list_workspace で実在するパスを確認してください。"
    except KeyError as e:
        return f"エラー: 必須引数 {e} がありません。"
    except ValueError as e:
        return f"エラー: {e}"


# --- PrayLight（Copilot）連携 ---------------------------------------------------

def _praylight_paths() -> tuple[Path, Path]:
    root = Path(settings.praylight_dir).expanduser().resolve()
    py = (
        Path(settings.praylight_python).expanduser().resolve()
        if settings.praylight_python
        else root / ".venv" / "Scripts" / "python.exe"
    )
    return root / "copilot_ask.py", py


async def _ask_copilot(question: str) -> str:
    """PrayLight の copilot_ask.py を subprocess で呼ぶ。質問は stdin 渡し（引用符問題の回避）。"""
    script, py = _praylight_paths()
    if not script.exists():
        return f"エラー: PrayLight が見つかりません（{script}）。.env の NWP_PRAYLIGHT_DIR を確認してください。"
    if not py.exists():
        return f"エラー: PrayLight の Python が見つかりません（{py}）。NWP_PRAYLIGHT_PYTHON で指定してください。"

    proc = None
    try:
        proc = await asyncio.create_subprocess_exec(
            str(py), str(script), "--timeout", str(settings.copilot_timeout),
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=str(script.parent),
        )
        out, err = await asyncio.wait_for(
            proc.communicate(question.encode("utf-8")),
            timeout=settings.copilot_timeout + 30,  # スクリプト内タイムアウト + 起動猶予
        )
    except asyncio.TimeoutError:
        if proc is not None:
            proc.kill()
        return "エラー: Copilot の応答がタイムアウトしました。もう一度試すか、質問を短くしてください。"
    except OSError as e:
        return f"エラー: PrayLight を起動できません: {e}"

    answer = out.decode("utf-8", "replace").strip()
    if proc.returncode != 0 or not answer:
        stderr_lines = err.decode("utf-8", "replace").strip().splitlines()
        # copilot_ask.py は要因を「エラー: …」行で stderr に出す。それを優先して拾う。
        error_lines = [ln for ln in stderr_lines if ln.startswith("エラー")]
        detail = (error_lines or stderr_lines or ["詳細不明"])[-1]
        return (
            f"エラー: Copilot から回答を取得できませんでした（{detail}）。\n"
            "PrayLight 側で `python start_browser.py` を実行してブラウザを起動し、"
            "Copilot にログイン済みか確認してください。"
        )
    return _truncate(answer)
