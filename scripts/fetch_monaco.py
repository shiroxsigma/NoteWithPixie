"""Monaco Editor を npm レジストリから取得し static/vendor へ展開する。

完全オフライン動作のためのベンダリング。初回に一度だけ実行すればよい。
    python scripts/fetch_monaco.py
実行しなくても app は CDN にフォールバックして動く（その場合はネット接続が必要）。
"""
from __future__ import annotations

import io
import sys
import tarfile
import urllib.request
from pathlib import Path

VERSION = "0.45.0"
URL = f"https://registry.npmjs.org/monaco-editor/-/monaco-editor-{VERSION}.tgz"
DEST = Path(__file__).resolve().parent.parent / "static" / "vendor" / "monaco"


def main() -> int:
    print(f"downloading monaco-editor {VERSION} …")
    try:
        raw = urllib.request.urlopen(URL, timeout=60).read()
    except Exception as e:  # noqa: BLE001
        print(f"取得失敗: {e}", file=sys.stderr)
        return 1

    DEST.mkdir(parents=True, exist_ok=True)
    count = 0
    with tarfile.open(fileobj=io.BytesIO(raw), mode="r:gz") as tf:
        for member in tf.getmembers():
            # tarball 内は package/min/vs/... 。min/ 配下だけを取り出す。
            name = member.name
            prefix = "package/min/"
            if not name.startswith(prefix) or not member.isfile():
                continue
            rel = name[len("package/"):]  # -> min/vs/...
            target = DEST / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            with tf.extractfile(member) as src:
                target.write_bytes(src.read())
            count += 1
    print(f"完了: {count} ファイルを {DEST} へ展開しました。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
