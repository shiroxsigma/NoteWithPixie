// Markdown 描画。チャットの返信とエディタのプレビューで同じレンダラを共有する。
//
// markdown-it は UMD ビルドなので index.html の <script> で window.markdownit に載る。
// scripts/fetch_markdown_it.py でベンダリングしていなければ undefined になるので、
// その場合は生テキストへ静かにフォールバックする（Monaco と違い、無くても編集はできる）。

const md = window.markdownit
  ? window.markdownit({
      // html: false が最大の防御。AI の生成物と /api/web2md で取り込んだ外部ページを
      // innerHTML に入れる以上、生 HTML を通すわけにはいかない（<script> はエスケープされる）。
      // ここを true にするなら DOMPurify のベンダリングが必須になる。
      html: false,
      linkify: true,
      breaks: false,
    })
  : null;

/** ベンダリング済みで Markdown 描画が使えるか。 */
export const available = () => md !== null;

if (md) {
  // リンクは既定のブラウザで新規タブに開く。ローカルアプリなので、
  // リンクを踏んでエディタのページ自体が遷移してしまうと編集中の内容を失う。
  const defaultLinkOpen =
    md.renderer.rules.link_open ||
    ((tokens, idx, opts, _env, self) => self.renderToken(tokens, idx, opts));
  md.renderer.rules.link_open = (tokens, idx, opts, env, self) => {
    tokens[idx].attrSet("target", "_blank");
    tokens[idx].attrSet("rel", "noopener noreferrer");
    return defaultLinkOpen(tokens, idx, opts, env, self);
  };
}

/**
 * text を Markdown として el に描画する。
 * ベンダリングが無ければ textContent に落とす（呼び出し側は分岐しなくてよい）。
 */
export function renderInto(el, text) {
  if (!md) {
    el.classList.remove("md");
    el.textContent = text;
    return;
  }
  el.classList.add("md");  // .md が付いた要素だけ pre-wrap をやめる（style.css 参照）
  el.innerHTML = md.render(text);
}

/** 生テキストとして描画する。ストリーミング中など、まだ Markdown が完成していない段階用。 */
export function renderPlain(el, text) {
  el.classList.remove("md");
  el.textContent = text;
}
