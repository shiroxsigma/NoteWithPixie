"""ツールを自律的に使う軽量エージェントループ（Phase 0 自前実装）。

AnythingWithPixie のエンジンは持ち込まず、OpenAI 互換 function calling の
最小ループだけをここに置く。将来 pixie-core（共有カーネル）に差し替える想定。

イベントは dict で yield する:
  {"t": str}  本文トークン（チャット本文・履歴に含める）
  {"s": str}  ツール実行などのステータス行（表示のみ、本文には含めない）
"""
from __future__ import annotations

import json
from typing import AsyncGenerator

import httpx

from . import llm, tools
from .config import settings

# ベースの執筆支援プロンプト（apply ブロック規約）にツール指針を足す
AGENT_SYSTEM_PROMPT = llm.SYSTEM_PROMPT + """
ツールの使い方:
- 依頼に必要な資料が手元に無ければ、list_workspace / grep_workspace で探し、read_note で読む。
- 最新情報・外部知識・推敲の別視点が必要なときだけ ask_copilot を使う（遅いので1依頼につき原則1回まで）。
- 必要な情報が揃ったら、ツールを呼ばずに最終回答を書く。ツール結果の丸写しではなく、依頼に沿って整理する。
- 推測でパスを書かない。実在確認できたファイルだけを参照する。
"""


async def run_agent(
    user_msg: str,
    selection: str,
    context_files: list[dict],
    history: list[dict],
) -> AsyncGenerator[dict, None]:
    """ツール往復つきでチャット1ターンを実行する非同期イベントジェネレータ。"""
    # メッセージ組み立ては llm.build_messages を再利用し、システムだけ差し替える
    messages = llm.build_messages(user_msg, selection, context_files, history)
    messages[0] = {"role": "system", "content": AGENT_SYSTEM_PROMPT}

    for _step in range(settings.agent_max_steps):
        tool_calls: list[dict] = []
        content = ""
        async for tok in _stream_step(messages, tool_calls, use_tools=True):
            content += tok
            yield {"t": tok}

        if not tool_calls:
            if content.strip():
                return  # ツール要求なし＝最終回答が出た
            # 本文もツールコールも空（モデルのツールテンプレート不整合などで起きる）
            # → ツール無しで回答を強制再生成する
            yield {"s": "⚠️ モデルの応答が空でした。ツール無しで回答を再生成します"}
            messages.append({
                "role": "user",
                "content": "（システム: 応答が空でした。ツールを使わず、これまでの情報で回答してください）",
            })
            retry_sink: list[dict] = []
            async for tok in _stream_step(messages, retry_sink, use_tools=False):
                yield {"t": tok}
            return

        messages.append({"role": "assistant", "content": content, "tool_calls": tool_calls})
        for tc in tool_calls:
            name = tc["function"]["name"]
            try:
                args = json.loads(tc["function"]["arguments"] or "{}")
            except json.JSONDecodeError:
                args = None

            yield {"s": f"🔧 {name}({_fmt_args(args)})"}
            if name == "ask_copilot":
                yield {"s": "🕊️ Copilot に相談中…（数十秒かかります）"}

            if args is None:
                result = "エラー: 引数が JSON として解釈できません。正しい JSON で再試行してください。"
            else:
                result = await tools.execute(name, args)

            if result.startswith("エラー"):
                yield {"s": f"⚠️ {result.splitlines()[0][:160]}"}
            else:
                yield {"s": f"✅ {name} 完了（{len(result)} 文字）"}
            messages.append({"role": "tool", "tool_call_id": tc["id"], "content": result})

    # 往復上限に達した → ツール無しで最終回答を強制する
    yield {"s": f"⚠️ ツール往復の上限（{settings.agent_max_steps}回）に達しました。ここまでの情報で回答します"}
    messages.append({
        "role": "user",
        "content": "（システム: ツール使用の上限に達しました。ここまでに得た情報だけで最終回答をまとめてください）",
    })
    final_sink: list[dict] = []
    async for tok in _stream_step(messages, final_sink, use_tools=False):
        yield {"t": tok}


def _fmt_args(args: dict | None) -> str:
    """ステータス行用に引数を短く整形する。"""
    if not args:
        return ""
    parts = []
    for k, v in args.items():
        s = str(v).replace("\n", " ")
        if len(s) > 60:
            s = s[:60] + "…"
        parts.append(f"{k}={s}")
    return ", ".join(parts)


async def _stream_step(
    messages: list[dict],
    tool_sink: list[dict],
    use_tools: bool,
) -> AsyncGenerator[str, None]:
    """chat/completions を1回ストリーミング実行。本文トークンを yield し、
    tool_calls は delta を index ごとに組み立てて tool_sink に格納する。"""
    url = settings.llm_base_url.rstrip("/") + "/chat/completions"
    payload: dict = {
        "model": settings.chat_model,
        "messages": messages,
        "stream": True,
        "temperature": 0.4,
    }
    if use_tools:
        payload["tools"] = tools.TOOLS_SPEC
    headers = {"Authorization": f"Bearer {settings.llm_api_key}"}

    acc: dict[int, dict] = {}  # index -> {id, name, arguments}
    try:
        async with httpx.AsyncClient(timeout=None) as client:
            async with client.stream("POST", url, json=payload, headers=headers) as resp:
                if resp.status_code != 200:
                    body = (await resp.aread()).decode("utf-8", "replace")
                    yield f"\n\n> ⚠️ LLM エラー ({resp.status_code}): {body[:300]}"
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
                    tok = delta.get("content")
                    if tok:
                        yield tok
                    for tc in delta.get("tool_calls") or []:
                        slot = acc.setdefault(
                            tc.get("index", 0), {"id": "", "name": "", "arguments": ""}
                        )
                        if tc.get("id"):
                            slot["id"] = tc["id"]
                        fn = tc.get("function") or {}
                        if fn.get("name"):
                            slot["name"] += fn["name"]
                        if fn.get("arguments"):
                            slot["arguments"] += fn["arguments"]
    except httpx.HTTPError as e:
        yield (
            f"\n\n> ⚠️ LLM バックエンドに接続できません（{url}）。\n"
            f"> Ollama / LM Studio が起動しているか、.env の NWP_LLM_BASE_URL を確認してください。\n"
            f"> 詳細: {type(e).__name__}: {e}"
        )
        return

    # OpenAI 互換の tool_calls 形式へ整形（id 欠落バックエンドには合成 id を振る）
    for i in sorted(acc):
        slot = acc[i]
        if not slot["name"]:
            continue
        tool_sink.append({
            "id": slot["id"] or f"call_{i}",
            "type": "function",
            "function": {"name": slot["name"], "arguments": slot["arguments"]},
        })
