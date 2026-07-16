"""markdown-it を npm レジストリから取得し static/vendor へ配置する。

完全オフライン動作のためのベンダリング。初回に一度だけ実行すればよい。
    python scripts/fetch_markdown_it.py
tarball 内の dist/markdown-it.min.js（UMD ビルド・依存ゼロ）1ファイルだけを取り出す。
"""
from __future__ import annotations

import io
import sys
import tarfile
import urllib.request
from pathlib import Path

VERSION = "14.3.0"
URL = f"https://registry.npmjs.org/markdown-it/-/markdown-it-{VERSION}.tgz"
MEMBER = "package/dist/markdown-it.min.js"
DEST = Path(__file__).resolve().parent.parent / "static" / "vendor" / "markdown-it"


def main() -> int:
    print(f"downloading markdown-it {VERSION} …")
    try:
        raw = urllib.request.urlopen(URL, timeout=60).read()
    except Exception as e:  # noqa: BLE001
        print(f"取得失敗: {e}", file=sys.stderr)
        return 1

    DEST.mkdir(parents=True, exist_ok=True)
    target = DEST / "markdown-it.min.js"
    with tarfile.open(fileobj=io.BytesIO(raw), mode="r:gz") as tf:
        # tarball 内は package/dist/... 。UMD の min ビルド1ファイルだけあればよい。
        try:
            member = tf.getmember(MEMBER)
        except KeyError:
            print(f"展開失敗: tarball 内に {MEMBER} が見つかりません。", file=sys.stderr)
            return 1
        if not member.isfile():
            print(f"展開失敗: {MEMBER} がファイルではありません。", file=sys.stderr)
            return 1
        with tf.extractfile(member) as src:
            target.write_bytes(src.read())
    print(f"完了: {target}（{target.stat().st_size:,} bytes）を配置しました。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
