"""OpenAI 互換エンドポイント (Ollama / LM Studio / llama.cpp) へのストリーミングクライアント。"""
from __future__ import annotations

import json
from typing import AsyncGenerator

import httpx

from .config import settings

# --- プロンプト設計（モードA：チャット・推論） ---------------------------------
# 修正案は必ず ```apply フェンスで囲わせる。フロントはこのブロックだけを抽出して
# 選択範囲に適用するため、挨拶や解説がエディタへ混入しない。
SYSTEM_PROMPT = """あなたは Markdown エディタに常駐する執筆支援アシスタント（Pixie）です。
ユーザーはエディタで文章の一部を選択していることがあります。

回答のルール:
- まず日本語で、何をどう変えたか / 提案の意図を簡潔に説明する。
- 編集の提案は、次の2形式のどちらかで返す（説明文の中に混ぜない）:

【形式1: 部分編集（推奨・複数箇所可）】本文の変更したい箇所ごとにペアで書く:
```search
<本文中に実在するテキストを一字一句そのままコピー（省略・要約禁止）>
```
```replace
<その箇所の置換後テキスト>
```
- search には対象箇所を一意に特定できるだけの行を含める（前後の行を足してよい）。
- 削除は replace を空にする。複数箇所ならペアを複数並べる。

【形式2: 全置換】選択範囲が短い・全体を書き直す場合のみ:
```apply
<置換後の Markdown 本文のみ。挨拶・解説を含めない>
```

- 重要: unified diff（`+`/`-` 行、```diff）は絶対に出力しない。差分表示はアプリが行う。
- 「差分を出して」と言われても、説明は日本語の文で述べ、実体は上の2形式で返すこと。
- 純粋な相談・質問への回答なら、どのブロックも付けない。
- 参考ファイルが与えられたら内容を踏まえるが、無い情報を創作しない。
"""


# 参考ファイル1件あたりの上限文字数。ローカルモデルのコンテキスト長（~32k トークン）を
# 静かに溢れさせないための保険。超過分は切り詰めて明示する。
MAX_CONTEXT_CHARS_PER_FILE = 8000


def build_messages(user_msg: str, selection: str, context_files: list[dict], history: list[dict]) -> list[dict]:
    """フロントから来た素材を chat/completions の messages 配列に組み立てる。"""
    parts: list[str] = []
    if context_files:
        parts.append("# 参考ファイル")
        for f in context_files:
            content = f["content"]
            if len(content) > MAX_CONTEXT_CHARS_PER_FILE:
                content = content[:MAX_CONTEXT_CHARS_PER_FILE] + "\n…（長いため以降を省略）"
            parts.append(f"## {f['path']}\n```\n{content}\n```")
    if selection.strip():
        parts.append("# エディタで選択中のテキスト\n```markdown\n" + selection + "\n```")
    parts.append("# 指示\n" + user_msg)

    messages: list[dict] = [{"role": "system", "content": SYSTEM_PROMPT}]
    messages += history[-8:]  # 直近の履歴のみ（コンテキスト節約）
    messages.append({"role": "user", "content": "\n\n".join(parts)})
    return messages


def _delta_reasoning(delta: dict) -> str | None:
    """思考トークンをバックエンド差異を吸収して取り出す。
    LM Studio: reasoning_content / Ollama(OpenAI互換): reasoning / その他: thinking"""
    return delta.get("reasoning_content") or delta.get("reasoning") or delta.get("thinking")


async def stream_chat(messages: list[dict]) -> AsyncGenerator[dict, None]:
    """イベントを逐次 yield する非同期ジェネレータ。
    {"t": str} 本文トークン / {"r": str} 思考（reasoning）トークン"""
    url = settings.llm_base_url.rstrip("/") + "/chat/completions"
    payload = {"model": settings.chat_model, "messages": messages, "stream": True, "temperature": 0.4}
    headers = {"Authorization": f"Bearer {settings.llm_api_key}"}

    try:
        async with httpx.AsyncClient(timeout=None) as client:
            async with client.stream("POST", url, json=payload, headers=headers) as resp:
                if resp.status_code != 200:
                    body = (await resp.aread()).decode("utf-8", "replace")
                    yield {"t": f"\n\n> ⚠️ LLM エラー ({resp.status_code}): {body[:300]}"}
                    return
                async for line in resp.aiter_lines():
                    if not line.startswith("data:"):
                        continue
                    data = line[len("data:"):].strip()
                    if data == "[DONE]":
                        break
                    try:
                        delta = json.loads(data)["choices"][0]["delta"]
                    except (json.JSONDecodeError, KeyError, IndexError):
                        continue
                    r = _delta_reasoning(delta)
                    if r:
                        yield {"r": r}
                    if delta.get("content"):
                        yield {"t": delta["content"]}
    except httpx.HTTPError as e:
        yield {"t": (
            f"\n\n> ⚠️ LLM バックエンドに接続できません（{url}）。\n"
            f"> Ollama / LM Studio が起動しているか、.env の NWP_LLM_BASE_URL を確認してください。\n"
            f"> 詳細: {type(e).__name__}: {e}"
        )}


async def list_models() -> list[str]:
    url = settings.llm_base_url.rstrip("/") + "/models"
    headers = {"Authorization": f"Bearer {settings.llm_api_key}"}
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            resp = await client.get(url, headers=headers)
            resp.raise_for_status()
            return [m["id"] for m in resp.json().get("data", [])]
    except (httpx.HTTPError, KeyError):
        return []
