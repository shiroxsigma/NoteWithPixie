"""FastAPI アプリ本体。静的フロントの配信と API を提供。"""
from __future__ import annotations

import json
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import agent, files, llm, search
from .config import WORKSPACE, settings

BASE = Path(__file__).resolve().parent.parent
STATIC = BASE / "static"
NOTES_FILE = WORKSPACE / ".pixie_notes.json"

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


class SaveReq(BaseModel):
    path: str
    content: str


# --- ファイル API -------------------------------------------------------------
@app.get("/api/files")
def api_files():
    return {"files": files.list_files(), "root": str(WORKSPACE)}


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


@app.get("/api/search")
def api_search(q: str):
    return {"results": search.search(q)}


# --- 付箋（インラインコメント）の永続化 ---------------------------------------
@app.get("/api/notes")
def api_notes_get(path: str):
    if not NOTES_FILE.exists():
        return {"notes": []}
    data = json.loads(NOTES_FILE.read_text(encoding="utf-8"))
    return {"notes": data.get(path, [])}


@app.post("/api/notes")
def api_notes_set(path: str, notes: list[dict]):
    data = {}
    if NOTES_FILE.exists():
        data = json.loads(NOTES_FILE.read_text(encoding="utf-8"))
    data[path] = notes
    NOTES_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    return {"ok": True}


# --- LLM API ------------------------------------------------------------------
@app.get("/api/models")
async def api_models():
    return {"models": await llm.list_models(), "current": settings.chat_model}


@app.post("/api/chat")
async def api_chat(req: ChatReq):
    context = [{"path": c.path, "content": c.content} for c in req.context_files]

    async def gen():
        # SSE: {"t": 本文トークン} / {"s": ツール実行ステータス} を JSON でくるんで送る
        if settings.agent_mode:
            async for ev in agent.run_agent(req.message, req.selection, context, req.history):
                yield f"data: {json.dumps(ev, ensure_ascii=False)}\n\n"
        else:
            messages = llm.build_messages(req.message, req.selection, context, req.history)
            async for tok in llm.stream_chat(messages):
                yield f"data: {json.dumps({'t': tok}, ensure_ascii=False)}\n\n"
        yield "data: [DONE]\n\n"

    return StreamingResponse(gen(), media_type="text/event-stream")


# --- 静的フロント -------------------------------------------------------------
@app.get("/")
def index():
    return FileResponse(STATIC / "index.html")


app.mount("/static", StaticFiles(directory=STATIC), name="static")


def run() -> None:
    import uvicorn

    print(f"NoteWithPixie -> http://{settings.host}:{settings.port}  (workspace: {WORKSPACE})")
    uvicorn.run(app, host=settings.host, port=settings.port)


if __name__ == "__main__":
    run()
