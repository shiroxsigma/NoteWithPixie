"""search/replace ブロック提案をテキストに適用する計算ロジック（ファイルには書かない）。

AnythingWithPixie/src/tools.py の _fuzzy_apply / _build_search_hint /
_compute_search_and_replace_content を文字列ベースに移植したもの。
将来 pixie-core として共有カーネル化する際の候補（Phase 1）。

レイヤードマッチ（安全な順）:
  L1 完全一致（一意のときのみ）
  L2 空白正規化ウィンドウ一致（各行 strip 後の完全一致が一意なら採用）
  L3 difflib ファジー（閾値以上かつ2位候補と十分離れていれば採用）
曖昧なら安全のため失敗させ、ヒントを返して自己修正を促す。
"""
from __future__ import annotations

import difflib

FUZZY_MATCH_THRESHOLD = 0.85


def apply_edits(base: str, edits: list[dict]) -> dict:
    """base テキストに search/replace 編集列を順に適用する。

    Args:
        base: 適用対象の元テキスト（エディタの現内容など）
        edits: [{"search": str, "replace": str}, ...]

    Returns:
        {
          "content": 適用後テキスト（成功した編集のみ反映）,
          "results": [{"ok": bool, "method": str} | {"ok": False, "error": str}, ...],
          "applied": 成功数,
        }
    """
    content = base
    results: list[dict] = []
    applied = 0
    for e in edits:
        outcome = _apply_one(content, e.get("search", ""), e.get("replace", ""))
        if outcome["ok"]:
            content = outcome["content"]
            applied += 1
            results.append({"ok": True, "method": outcome["method"]})
        else:
            results.append({"ok": False, "error": outcome["error"]})
    return {"content": content, "results": results, "applied": applied}


def _apply_one(content: str, search_block: str, replace_block: str) -> dict:
    if not search_block:
        return {"ok": False, "error": "search ブロックが空です。"}

    count = content.count(search_block)
    if count == 1:
        return {"ok": True, "content": content.replace(search_block, replace_block, 1), "method": "exact"}
    if count > 1:
        return {"ok": False, "error": f"search ブロックが {count} 箇所にマッチしました。前後の行を含めて一意にしてください。"}

    # count == 0: ファジーマッチで再挑戦
    new_content, method = _fuzzy_apply(content, search_block, replace_block)
    if new_content is not None:
        return {"ok": True, "content": new_content, "method": method}

    hint = _build_search_hint(search_block.splitlines(), content.splitlines())
    return {"ok": False, "error": "search ブロックが本文に見つかりませんでした。" + hint}


def _fuzzy_apply(content: str, search_block: str, replace_block: str,
                 threshold: float = FUZZY_MATCH_THRESHOLD):
    """完全一致が失敗した後のファジーマッチ（厳格モード）。

    窓は常に len(search_lines) 幅。曖昧（複数候補が同点など）なら失敗する。
    Returns: (new_content, method) 成功 / (None, None) 適用不可。
    """
    search_lines = search_block.splitlines()
    file_lines = content.splitlines()
    n = len(search_lines)
    if n == 0 or n > len(file_lines):
        return None, None

    norm_search = [s.strip() for s in search_lines]
    norm_file = [f.strip() for f in file_lines]

    # L2: 空白正規化ウィンドウ一致（一意位置のみ）
    l2 = [i for i in range(len(file_lines) - n + 1) if norm_file[i: i + n] == norm_search]
    if len(l2) == 1:
        actual = "\n".join(file_lines[l2[0]: l2[0] + n])
        new_content = content.replace(actual, replace_block, 1)
        if new_content != content:
            return new_content, "normalized"

    # L3: difflib ファジー（先頭行アンカーで候補を絞る）
    first = norm_search[0]
    scored = []
    for i in range(len(file_lines) - n + 1):
        if difflib.SequenceMatcher(None, norm_file[i], first).ratio() < 0.70:
            continue
        r = difflib.SequenceMatcher(None, norm_search, norm_file[i: i + n]).ratio()
        scored.append((r, i))
    scored.sort(reverse=True)
    if scored and scored[0][0] >= threshold:
        best_r, best_i = scored[0]
        second_r = scored[1][0] if len(scored) > 1 else 0.0
        if best_r - second_r >= 0.05 or second_r < threshold:
            actual = "\n".join(file_lines[best_i: best_i + n])
            new_content = content.replace(actual, replace_block, 1)
            if new_content != content:
                return new_content, f"fuzzy({best_r:.2f})"

    return None, None


def _build_search_hint(search_lines: list[str], content_lines: list[str], max_hints: int = 3) -> str:
    """search の先頭行に近い本文中の行をヒントとして返す（自己修正の材料）。"""
    if not search_lines:
        return ""
    first = search_lines[0].strip()
    if not first:
        return ""
    hints, seen = [], set()
    for i, line in enumerate(content_lines):
        stripped = line.strip()
        if first in stripped and stripped not in seen:
            hints.append(f"  行{i + 1}: {line}")
            seen.add(stripped)
            if len(hints) >= max_hints:
                break
    if not hints and len(first) >= 10:
        prefix = first[:15]
        for i, line in enumerate(content_lines):
            stripped = line.strip()
            if prefix in stripped and stripped not in seen:
                hints.append(f"  行{i + 1}: {line}")
                seen.add(stripped)
                if len(hints) >= max_hints:
                    break
    return "\n【ヒント: 本文中の類似行】\n" + "\n".join(hints) if hints else ""
