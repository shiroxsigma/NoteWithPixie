"""Mermaid を npm レジストリから取得し static/vendor へ配置する。

完全オフライン動作のためのベンダリング。初回に一度だけ実行すればよい。
    python scripts/fetch_mermaid.py
tarball 内の dist/mermaid.min.js（IIFE ビルド・依存ゼロ）1ファイルだけを取り出す。
mermaid 11 の package.json は module（ESM）しか公開しておらず、そちらの
dist/mermaid.esm.min.mjs は dist/chunks/ 配下の 500 以上の分割ファイルを
動的 import する。対して dist/mermaid.min.js は全部入りの単体ビルドで、
末尾で globalThis["mermaid"] を代入するので <script> 1本で window.mermaid が生える。

注意: mermaid.min.js は exports に載っていない（"./*" 経由で取れるだけの）非公表ビルド。
VERSION を上げるときは、まだ存在するか・単体で動くかを実ブラウザで確認すること。
"""
from __future__ import annotations

import io
import sys
import tarfile
import urllib.request
from pathlib import Path

VERSION = "11.16.0"
URL = f"https://registry.npmjs.org/mermaid/-/mermaid-{VERSION}.tgz"
MEMBER = "package/dist/mermaid.min.js"
DEST = Path(__file__).resolve().parent.parent / "static" / "vendor" / "mermaid"


def main() -> int:
    print(f"downloading mermaid {VERSION} …")
    try:
        raw = urllib.request.urlopen(URL, timeout=120).read()
    except Exception as e:  # noqa: BLE001
        print(f"取得失敗: {e}", file=sys.stderr)
        return 1

    DEST.mkdir(parents=True, exist_ok=True)
    target = DEST / "mermaid.min.js"
    with tarfile.open(fileobj=io.BytesIO(raw), mode="r:gz") as tf:
        # tarball 内は package/dist/... 。単体で動く IIFE ビルド1ファイルだけあればよい。
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
