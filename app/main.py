"""FastAPI アプリ本体。静的フロントの配信と API を提供。"""
from __future__ import annotations

import json
import os
import re
import string
from pathlib import Path
from urllib.parse import urlparse

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import agent, config, files, llm, patch, search, tools
from .config import settings

BASE = Path(__file__).resolve().parent.parent
STATIC = BASE / "static"


def _notes_file() -> Path:
    """付箋JSONの置き場所。ワークスペースと一緒に切り替わる。"""
    return config.WORKSPACE / ".pixie_notes.json"


def _refs_file() -> Path:
    """関連ファイル参照JSONの置き場所。ワークスペースと一緒に切り替わる。"""
    return config.WORKSPACE / ".pixie_refs.json"

app = FastAPI(title="NoteWithPixie")

ALLOWED_HOSTS = {"127.0.0.1", "localhost", settings.host}


@app.middleware("http")
async def verify_host(request: Request, call_next):
    """DNS リバインディング対策: ローカル以外の Host ヘッダを拒否する。"""
    host = request.headers.get("host", "").split(":")[0].lower()
    if host not in ALLOWED_HOSTS:
        return JSONResponse({"detail": "forbidden host"}, status_code=403)
    return await call_next(request)


# --- モデル -------------------------------------------------------------------
class ContextFile(BaseModel):
    path: str
    content: str


class ChatReq(BaseModel):
    message: str
    selection: str = ""
    context_files: list[ContextFile] = []
    history: list[dict] = []
    current_file: str = ""     # エディタで開いているファイル（「このファイル」の指示先）
    current_content: str = ""  # その内容（未保存の編集を含むエディタバッファ）
    ref_texts: list[ContextFile] = []  # 関連ファイル（テキスト）: context_files と同じ扱い
    attach_files: list[str] = []       # 関連ファイル（バイナリ/外部）の絶対パス: Copilot 添付用


class FileRef(BaseModel):
    path: str            # external=false ならワークスペース相対、true なら OS 絶対パス
    external: bool = False
    name: str = ""       # 表示名（既定はファイル名）


class RefsSaveReq(BaseModel):
    path: str            # 対象ノートの相対パス
    refs: list[FileRef] = []


class RefOpenReq(BaseModel):
    note: str            # 参照が登録されているノート（認可のため）
    path: str
    external: bool = False


class SaveReq(BaseModel):
    path: str
    content: str


class FsCreateReq(BaseModel):
    path: str
    kind: str = "file"  # "file" | "dir"


class FsRenameReq(BaseModel):
    src: str
    dst: str


class FsDeleteReq(BaseModel):
    path: str


class PatchEdit(BaseModel):
    search: str
    replace: str


class PatchReq(BaseModel):
    base: str
    edits: list[PatchEdit]


# --- ファイル API -------------------------------------------------------------
@app.get("/api/files")
def api_files():
    return {"files": files.list_files(), "root": str(config.WORKSPACE)}


@app.get("/api/file")
def api_read(path: str):
    try:
        return {"path": path, "content": files.read_file(path)}
    except FileNotFoundError:
        raise HTTPException(404, "not found")
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.post("/api/file")
def api_write(req: SaveReq):
    try:
        files.write_file(req.path, req.content)
        return {"ok": True}
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.post("/api/fs/create")
def api_fs_create(req: FsCreateReq):
    try:
        files.create(req.path, req.kind)
        return {"ok": True}
    except (ValueError, OSError) as e:
        raise HTTPException(400, str(e))


@app.post("/api/fs/rename")
def api_fs_rename(req: FsRenameReq):
    try:
        files.rename(req.src, req.dst)
    except FileNotFoundError:
        raise HTTPException(404, "not found")
    except (ValueError, OSError) as e:
        raise HTTPException(400, str(e))
    _rewrite_notes_on_rename(req.src, req.dst)
    _rewrite_refs_on_rename(req.src, req.dst)
    return {"ok": True}


@app.post("/api/fs/delete")
def api_fs_delete(req: FsDeleteReq):
    try:
        files.delete(req.path)
        return {"ok": True}
    except FileNotFoundError:
        raise HTTPException(404, "not found")
    except (ValueError, OSError) as e:
        raise HTTPException(400, str(e))


def _rewrite_notes_on_rename(src: str, dst: str) -> None:
    """改名・移動に合わせて付箋JSONのキー（ファイルパス）を追従させる。
    フォルダ改名なら配下ファイルのキーもプレフィックス書き換え。"""
    notes_file = _notes_file()
    if not notes_file.exists():
        return
    data = json.loads(notes_file.read_text(encoding="utf-8"))
    changed = False
    for key in list(data.keys()):
        if key == src:
            data[dst] = data.pop(key)
            changed = True
        elif key.startswith(src + "/"):
            data[dst + key[len(src):]] = data.pop(key)
            changed = True
    if changed:
        notes_file.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def _rewrite_refs_on_rename(src: str, dst: str) -> None:
    """ノートの改名・移動に合わせて関連ファイルJSONのキー（ノートパス）を追従させる。
    フォルダ改名なら配下ノートのキーもプレフィックス書き換え（付箋と同じ扱い）。
    参照先ファイル自体のパスは書き換えない（スコープ外）。"""
    refs_file = _refs_file()
    if not refs_file.exists():
        return
    data = json.loads(refs_file.read_text(encoding="utf-8"))
    changed = False
    for key in list(data.keys()):
        if key == src:
            data[dst] = data.pop(key)
            changed = True
        elif key.startswith(src + "/"):
            data[dst + key[len(src):]] = data.pop(key)
            changed = True
    if changed:
        refs_file.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


# --- 関連ファイル参照（別ディレクトリの .pptx 等をノートに紐付ける）-------------
def _load_refs(note: str) -> list[dict]:
    refs_file = _refs_file()
    if not refs_file.exists():
        return []
    data = json.loads(refs_file.read_text(encoding="utf-8"))
    return data.get(note, [])


@app.get("/api/refs")
def api_refs_get(path: str):
    return {"refs": _load_refs(path)}


@app.post("/api/refs")
def api_refs_set(req: RefsSaveReq):
    refs_file = _refs_file()
    data = {}
    if refs_file.exists():
        data = json.loads(refs_file.read_text(encoding="utf-8"))
    payload = [r.model_dump() for r in req.refs]
    if payload:
        data[req.path] = payload
    else:
        data.pop(req.path, None)  # 空になったらキーごと消す
    refs_file.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    return {"ok": True}


def _authorized_ref(note: str, path: str, external: bool) -> Path:
    """note の refs サイドカーに登録済みの参照だけを解決する。未登録なら拒否。"""
    for r in _load_refs(note):
        if r.get("path") == path and bool(r.get("external")) == external:
            return files.resolve_ref(path, external)
    raise HTTPException(403, "参照が登録されていません")


@app.post("/api/refs/open")
def api_refs_open(req: RefOpenReq):
    """関連ファイルを OS の既定アプリで開く。認可済み（登録済み）パスのみ。"""
    try:
        p = _authorized_ref(req.note, req.path, req.external)
    except ValueError as e:
        raise HTTPException(400, str(e))
    if not p.exists():
        raise HTTPException(404, f"ファイルが見つかりません: {p}")
    if os.name == "nt":
        os.startfile(str(p))  # noqa: S606 — ローカル専用アプリ、ユーザー起点、登録済みに限定
    else:
        # 他OS対応が必要なら xdg-open / open へフォールバックする
        import subprocess
        subprocess.Popen(["xdg-open", str(p)])
    return {"ok": True}


@app.get("/api/refs/read")
def api_refs_read(note: str, idx: int):
    """関連ファイル（テキスト）の内容を返す。AI 文脈同梱用。登録済みのみ許可。"""
    refs = _load_refs(note)
    if idx < 0 or idx >= len(refs):
        raise HTTPException(404, "参照が見つかりません")
    r = refs[idx]
    p = files.resolve_ref(r["path"], bool(r.get("external")))
    if not p.is_file():
        raise HTTPException(404, f"ファイルが見つかりません: {p}")
    if p.stat().st_size > files.MAX_BYTES:
        raise HTTPException(400, "file too large")
    return {"path": r["path"], "content": p.read_text(encoding="utf-8", errors="replace")}


# --- ワークスペース（保存先ルート）の切り替え -----------------------------------
class WorkspaceReq(BaseModel):
    root: str


@app.post("/api/workspace")
def api_workspace_set(req: WorkspaceReq):
    """保存先ルートを切り替えて config.json に永続化する。無いフォルダは作る。"""
    try:
        p = config.set_workspace(req.root)
    except (ValueError, OSError) as e:
        raise HTTPException(400, str(e))
    return {"ok": True, "root": str(p)}


@app.get("/api/workspace/dirs")
def api_workspace_dirs(path: str = "", files: bool = False):
    """フォルダ選択ダイアログ用: 指定パス直下のサブフォルダ一覧を返す。
    path 省略時は現在のワークスペース。ローカル専用アプリなので全ドライブを見せてよい。
    files=true のとき、関連ファイル参照ピッカー用に配下ファイル（拡張子フィルタ無し）も返す。"""
    base = Path(path).expanduser() if path.strip() else config.WORKSPACE
    try:
        base = base.resolve()
    except OSError as e:
        raise HTTPException(400, str(e))
    if not base.is_dir():
        raise HTTPException(400, f"フォルダが見つかりません: {base}")
    try:
        entries = list(base.iterdir())
    except PermissionError:
        entries = []
    dirs = sorted(
        (d.name for d in entries if d.is_dir() and not d.name.startswith(".")),
        key=str.lower,
    )
    file_list = []
    if files:
        file_list = sorted(
            (f.name for f in entries if f.is_file() and not f.name.startswith(".")),
            key=str.lower,
        )
    parent = str(base.parent) if base.parent != base else None
    drives = []
    if os.name == "nt":
        drives = [f"{c}:/" for c in string.ascii_uppercase if Path(f"{c}:/").exists()]
    return {"path": str(base), "parent": parent, "dirs": dirs, "files": file_list, "drives": drives}


@app.get("/api/search")
def api_search(q: str):
    return {"results": search.search(q)}


@app.post("/api/patch")
def api_patch(req: PatchReq):
    """search/replace 提案を base テキストへ適用した結果を計算して返す。
    ファイルには一切書かない — 適用はフロントの差分プレビュー確認後。"""
    return patch.apply_edits(req.base, [e.model_dump() for e in req.edits])


# --- 付箋（インラインコメント）の永続化 ---------------------------------------
@app.get("/api/notes")
def api_notes_get(path: str):
    notes_file = _notes_file()
    if not notes_file.exists():
        return {"notes": []}
    data = json.loads(notes_file.read_text(encoding="utf-8"))
    return {"notes": data.get(path, [])}


@app.post("/api/notes")
def api_notes_set(path: str, notes: list[dict]):
    notes_file = _notes_file()
    data = {}
    if notes_file.exists():
        data = json.loads(notes_file.read_text(encoding="utf-8"))
    data[path] = notes
    notes_file.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    return {"ok": True}


# --- 設定（⚙️ GUI から切り替え・永続化）---------------------------------------
class SettingsReq(BaseModel):
    copilot_enabled: bool | None = None
    chat_model: str | None = None


@app.get("/api/settings")
def api_settings_get():
    return {
        "copilot_enabled": settings.copilot_enabled,
        "chat_model": settings.chat_model,
        "agent_mode": settings.agent_mode,
    }


@app.post("/api/settings")
def api_settings_set(req: SettingsReq):
    changes: dict = {}
    if req.copilot_enabled is not None:
        changes["copilot_enabled"] = req.copilot_enabled
    if req.chat_model is not None and req.chat_model.strip():
        changes["chat_model"] = req.chat_model.strip()
    if changes:
        config.set_config(**changes)
    return {
        "ok": True,
        "copilot_enabled": settings.copilot_enabled,
        "chat_model": settings.chat_model,
    }


# --- LLM API ------------------------------------------------------------------
@app.get("/api/models")
async def api_models():
    return {"models": await llm.list_models(), "current": settings.chat_model}


@app.post("/api/chat")
async def api_chat(req: ChatReq):
    # チェック済みの参考ファイルと、関連ファイル（テキスト）を同じ文脈として扱う
    context = [{"path": c.path, "content": c.content}
               for c in req.context_files + req.ref_texts]

    # 先頭が "/copilot" なら、agent_mode に関係なく Copilot へ直接聞きに行く
    msg = req.message.strip()
    copilot_direct = msg.lower().startswith("/copilot")
    if copilot_direct:
        msg = msg[len("/copilot"):].strip()

    async def gen():
        # SSE: {"t": 本文} / {"r": 思考} / {"s": ツールステータス} を JSON でくるんで送る
        if copilot_direct and not settings.copilot_enabled:
            note = {"t": "> ⚠️ Copilot モードはオフです。右上の設定（⚙️）からオンにしてください。"}
            yield f"data: {json.dumps(note, ensure_ascii=False)}\n\n"
            yield "data: [DONE]\n\n"
            return
        if copilot_direct:
            source = agent.run_copilot_direct(msg, req.selection, context, req.attach_files)
        elif settings.agent_mode:
            source = agent.run_agent(req.message, req.selection, context, req.history,
                                     req.current_file, req.current_content, req.attach_files)
        else:
            messages = llm.build_messages(req.message, req.selection, context, req.history,
                                          req.current_file, req.current_content)
            source = llm.stream_chat(messages)
        async for ev in source:
            yield f"data: {json.dumps(ev, ensure_ascii=False)}\n\n"
        yield "data: [DONE]\n\n"

    return StreamingResponse(gen(), media_type="text/event-stream")


# --- URL → Markdown 取り込み ----------------------------------------------------
class Web2MdReq(BaseModel):
    url: str


def _unique_md_path(title: str, fallback: str) -> str:
    """タイトルからワークスペース内の未使用ファイル名（web/ 配下）を作る。"""
    cleaned = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", title).strip().rstrip(".") or fallback
    cleaned = cleaned[:80]  # 長すぎるタイトルはファイル名として切り詰める
    base = f"web/{cleaned}"
    rel = base + ".md"
    n = 2
    while files.safe_path(rel).exists():
        rel = f"{base}-{n}.md"
        n += 1
    return rel


@app.post("/api/web2md")
async def api_web2md(req: Web2MdReq):
    """URL を Markdown 化してワークスペース（web/）に保存し、パスを返す。"""
    url = req.url.strip()
    if not re.match(r"^https?://", url):
        return {"ok": False, "error": "http(s):// で始まる URL を指定してください。", "path": ""}
    markdown = await tools.url_to_markdown(url)
    if markdown.startswith("エラー"):
        return {"ok": False, "error": markdown, "path": ""}

    # 先頭の「# タイトル」行をファイル名に使う
    first = markdown.splitlines()[0] if markdown.splitlines() else ""
    title = first.lstrip("# ").strip() if first.startswith("#") else ""
    rel = _unique_md_path(title or urlparse(url).netloc, urlparse(url).netloc or "page")
    files.write_file(rel, markdown)
    return {"ok": True, "error": "", "path": rel}


# --- Copilot 連携（PrayLight のブラウザ経由）-----------------------------------
@app.post("/api/copilot/open")
async def api_copilot_open():
    """デバッグ用ブラウザを起動して Copilot を開く（人がそこで対話する）。"""
    if not settings.copilot_enabled:
        return {"ok": False, "error": "Copilot モードがオフです。設定（⚙️）でオンにしてください。"}
    error = await tools.open_copilot_browser()
    return {"ok": not error, "error": error}


@app.post("/api/copilot/read")
async def api_copilot_read():
    """開いている Copilot タブの会話ログを Markdown で取得する。"""
    if not settings.copilot_enabled:
        return {"ok": False, "error": "Copilot モードがオフです。設定（⚙️）でオンにしてください。", "transcript": ""}
    text = await tools.read_copilot_conversation()
    if text.startswith("エラー"):
        return {"ok": False, "error": text, "transcript": ""}
    return {"ok": True, "error": "", "transcript": text}


# --- 静的フロント -------------------------------------------------------------
@app.get("/")
def index():
    return FileResponse(STATIC / "index.html")


app.mount("/static", StaticFiles(directory=STATIC), name="static")


def run() -> None:
    import uvicorn

    print(f"NoteWithPixie -> http://{settings.host}:{settings.port}  (workspace: {config.WORKSPACE})")
    if settings.reload:
        # reload はアプリ実体でなく import 文字列が必要（ウォッチャが再importするため）
        uvicorn.run("app.main:app", host=settings.host, port=settings.port, reload=True)
    else:
        uvicorn.run(app, host=settings.host, port=settings.port)


if __name__ == "__main__":
    run()
