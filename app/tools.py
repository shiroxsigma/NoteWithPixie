"""エージェント用ツール群。ワークスペース限定の read 系 + PrayLight（Copilot）相談。

セキュリティ方針: 書き込み系ツールは登録しない。エディタへの反映は従来どおり
```apply ブロック → ユーザーのクリックで行う（エージェントが取得、人間が反映）。
"""
from __future__ import annotations

import asyncio
import subprocess
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
                "必要な文脈・本文はすべて question に含めるか、files でファイルごと添付すること。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "question": {"type": "string", "description": "Copilot への質問文（自己完結した文章にする）"},
                    "files": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": (
                            "Copilot に添付するファイルのパス（任意・複数可）。ワークスペース内は相対パス、"
                            "ユーザーが関連ファイルとして添付したものは提示された絶対パスをそのまま渡す。"
                            "長い文書やあなたが読めない形式を読ませたいときに使う。対応: md/txt/csv/pdf/docx/xlsx/pptx/画像等"
                        ),
                    },
                },
                "required": ["question"],
            },
        },
    },
]


def active_tools() -> list[dict]:
    """現在の設定で使えるツール定義を返す。Copilot モードがオフなら ask_copilot を外す。"""
    if settings.copilot_enabled:
        return TOOLS_SPEC
    return [t for t in TOOLS_SPEC if t["function"]["name"] != "ask_copilot"]


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
            if not settings.copilot_enabled:
                return "エラー: Copilot モードがオフです。設定（⚙️）でオンにしてください。"
            return await _ask_copilot(str(args["question"]), args.get("files") or [])
        return f"エラー: 不明なツール '{name}'"
    except FileNotFoundError as e:
        return f"エラー: ファイルが見つかりません: {e}。list_workspace で実在するパスを確認してください。"
    except KeyError as e:
        return f"エラー: 必須引数 {e} がありません。"
    except ValueError as e:
        return f"エラー: {e}"


# --- PrayLight（Copilot）連携 ---------------------------------------------------

def _praylight_paths(script_name: str = "copilot_ask.py") -> tuple[Path, Path]:
    root = Path(settings.praylight_dir).expanduser().resolve()
    py = (
        Path(settings.praylight_python).expanduser().resolve()
        if settings.praylight_python
        else root / ".venv" / "Scripts" / "python.exe"
    )
    return root / "src" / script_name, py


async def _run_praylight(script: Path, py: Path, *args: str,
                         stdin_text: str | None = None,
                         timeout: float = 60) -> subprocess.CompletedProcess:
    """PrayLight スクリプトを実行する。同期 subprocess.run をスレッドに逃がす。

    asyncio.create_subprocess_exec は使わない: uvicorn の reload モードは
    Windows で SelectorEventLoop になり、asyncio の subprocess API が
    NotImplementedError を投げるため（同期 API はループ非依存）。
    timeout 超過時は subprocess.run が子プロセスを kill して TimeoutExpired を投げる。"""
    return await asyncio.to_thread(
        subprocess.run,
        [str(py), str(script), *args],
        input=stdin_text.encode("utf-8") if stdin_text is not None else None,
        capture_output=True,
        cwd=str(script.parent),
        timeout=timeout,
    )


def _last_error_line(stderr: bytes, fallback: str) -> str:
    lines = stderr.decode("utf-8", "replace").strip().splitlines()
    error_lines = [ln for ln in lines if ln.startswith("エラー")]
    return (error_lines or lines or [fallback])[-1]


async def _ask_copilot(question: str, file_rels: list | None = None) -> str:
    """PrayLight の copilot_ask.py を subprocess で呼ぶ。質問は stdin 渡し（引用符問題の回避）。

    file_rels の各要素はワークスペース相対パス、またはユーザーが関連ファイルとして明示添付した
    絶対パス（.pptx 等、ワークスペース外可）。相対は safe_path、絶対は expanduser().resolve() で
    解決してから --file で渡す。"""
    script, py = _praylight_paths()
    if not script.exists():
        return f"エラー: PrayLight が見つかりません（{script}）。.env の NWP_PRAYLIGHT_DIR を確認してください。"
    if not py.exists():
        return f"エラー: PrayLight の Python が見つかりません（{py}）。NWP_PRAYLIGHT_PYTHON で指定してください。"

    file_args: list[str] = []
    for rel in file_rels or []:
        # 絶対パスはユーザーが添付した関連ファイルとしてそのまま許可。相対は safe_path でサンドボックス。
        p = files.resolve_ref(str(rel), external=Path(str(rel)).is_absolute())
        if not p.is_file():
            return f"エラー: 添付ファイルが見つかりません: {rel}。list_workspace で実在するパスを確認してください。"
        file_args += ["--file", str(p)]

    upload_grace = 120 if file_args else 0  # アップロード完了待ちのぶん長めに待つ
    try:
        proc = await _run_praylight(
            script, py, "--timeout", str(settings.copilot_timeout), *file_args,
            stdin_text=question,
            timeout=settings.copilot_timeout + 30 + upload_grace,  # スクリプト内タイムアウト + 起動猶予
        )
    except subprocess.TimeoutExpired:
        return "エラー: Copilot の応答がタイムアウトしました。もう一度試すか、質問を短くしてください。"
    except OSError as e:
        return f"エラー: PrayLight を起動できません: {e}"

    answer = proc.stdout.decode("utf-8", "replace").strip()
    if proc.returncode != 0 or not answer:
        # copilot_ask.py は要因を「エラー: …」行で stderr に出す。それを優先して拾う。
        detail = _last_error_line(proc.stderr, "詳細不明")
        return (
            f"エラー: Copilot から回答を取得できませんでした（{detail}）。\n"
            "PrayLight 側で `python start_browser.py` を実行してブラウザを起動し、"
            "Copilot にログイン済みか確認してください。"
        )
    return _truncate(answer)


async def open_copilot_browser() -> str:
    """PrayLight のデバッグ用ブラウザを起動して Copilot を開く。成功なら空文字、失敗ならエラー文。"""
    script, py = _praylight_paths("start_browser.py")
    if not script.exists():
        return f"エラー: PrayLight が見つかりません（{script}）。.env の NWP_PRAYLIGHT_DIR を確認してください。"
    if not py.exists():
        return f"エラー: PrayLight の Python が見つかりません（{py}）。NWP_PRAYLIGHT_PYTHON で指定してください。"
    try:
        # start_browser.py はブラウザを Popen して即終了する
        proc = await _run_praylight(script, py, timeout=30)
    except subprocess.TimeoutExpired:
        return "エラー: ブラウザの起動がタイムアウトしました。"
    except OSError as e:
        return f"エラー: PrayLight を起動できません: {e}"
    if proc.returncode != 0:
        return f"エラー: ブラウザを起動できませんでした（{_last_error_line(proc.stderr, '詳細不明')}）。"

    # Cookie 肥大による「Header Field Too Long (400)」の予防掃除。
    # 失敗しても起動自体は成功として扱う（掃除はベストエフォート）。
    hygiene, _ = _praylight_paths("cookie_hygiene.py")
    if hygiene.exists():
        try:
            await _run_praylight(hygiene, py, timeout=45)
        except (subprocess.TimeoutExpired, OSError):
            pass
    return ""


async def _run_praylight_reader(script_name: str) -> str:
    """PrayLight の読み取り系スクリプトを実行して stdout を返す。失敗は「エラー: …」。"""
    script, py = _praylight_paths(script_name)
    if not script.exists():
        return f"エラー: スクリプトが見つかりません（{script}）。"
    if not py.exists():
        return f"エラー: PrayLight の Python が見つかりません（{py}）。"
    try:
        proc = await _run_praylight(script, py, timeout=60)
    except subprocess.TimeoutExpired:
        return "エラー: 読み取りがタイムアウトしました。"
    except OSError as e:
        return f"エラー: PrayLight を起動できません: {e}"

    transcript = proc.stdout.decode("utf-8", "replace").strip()
    if proc.returncode != 0 or not transcript:
        return _last_error_line(proc.stderr, "エラー: 会話を取得できませんでした。")
    return _truncate(transcript)


async def url_to_markdown(url: str) -> str:
    """URL のページを PrayLight 環境の url2md.py で Markdown 化する。
    ログインが必要なページでは表示中のブラウザで手動ログインを待つため、
    タイムアウトは長め（5分強）に取る。成功なら Markdown、失敗なら「エラー: …」。"""
    script, py = _praylight_paths("url2md.py")
    if not script.exists():
        return f"エラー: url2md.py が見つかりません（{script}）。"
    if not py.exists():
        return f"エラー: PrayLight の Python が見つかりません（{py}）。"
    try:
        proc = await _run_praylight(script, py, url, timeout=330)
    except subprocess.TimeoutExpired:
        return "エラー: 変換がタイムアウトしました（ログイン待ちを含め5分超）。"
    except OSError as e:
        return f"エラー: PrayLight を起動できません: {e}"

    markdown = proc.stdout.decode("utf-8", "replace").strip()
    if proc.returncode != 0 or not markdown:
        return _last_error_line(proc.stderr, "エラー: 変換に失敗しました。")
    # ここでは切り詰めない: LLM コンテキストでなくファイル保存が目的のため全文を返す
    return markdown


async def read_copilot_conversation() -> str:
    """開いている Copilot の会話ログ（Markdown）を取得する。
    1) UIA: 普段のブラウザの Copilot タブをアクセシビリティ API で読む（前面タブ必須）
    2) CDP: PrayLight の専用ブラウザから読む（フォールバック）
    成功なら本文、両方失敗なら「エラー: …」を返す。"""
    uia = await _run_praylight_reader("copilot_read_uia.py")
    if not uia.startswith("エラー"):
        return uia
    cdp = await _run_praylight_reader("copilot_read.py")
    if not cdp.startswith("エラー"):
        return cdp
    return (
        "エラー: 会話を取得できませんでした。\n"
        f"・通常ブラウザ(UIA): {uia.split(chr(10))[0]}\n"
        f"・専用ブラウザ(CDP): {cdp.split(chr(10))[0]}\n"
        "Copilot のタブをウィンドウの前面タブにしてから再試行してください。"
    )
