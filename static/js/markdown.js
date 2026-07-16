// Markdown 描画。チャットの返信とエディタのプレビューで同じレンダラを共有する。
//
// markdown-it / mermaid はどちらも UMD ビルドなので index.html の <script> で
// window に載る。scripts/fetch_*.py でベンダリングしていなければ undefined になるので、
// その場合は静かに機能を落とす（Monaco と違い、無くても編集はできる）。

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

const mermaid = window.mermaid || null;

/** ベンダリング済みで Markdown 描画が使えるか。 */
export const available = () => md !== null;

if (mermaid) {
  mermaid.initialize({
    startOnLoad: false,   // 描画のタイミングはこちらが握る（renderInto の後）
    theme: "dark",        // エディタが vs-dark なので図も暗色に揃える
    // securityLevel はラベルに埋め込まれた HTML の扱いを決める。strict なら
    // DOMPurify が onerror 等のハンドラを剥がす。AI の生成物を描く以上ここは緩められない。
    securityLevel: "strict",
  });
}

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

  // ```mermaid フェンスは図の器として出しておき、描画は renderInto の後で非同期に行う
  // （mermaid.render が Promise を返すため、markdown-it の同期レンダラ内では完結しない）。
  const defaultFence = md.renderer.rules.fence;
  md.renderer.rules.fence = (tokens, idx, opts, env, self) => {
    const token = tokens[idx];
    if (token.info.trim().toLowerCase() === "mermaid" && mermaid) {
      // 中身は escapeHtml 相当で入れる。描画失敗時はこのテキストがそのまま見える。
      return `<pre class="mermaid-src">${escapeHtml(token.content)}</pre>`;
    }
    return defaultFence(tokens, idx, opts, env, self);
  };
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// 図ごとに一意な id が要る（mermaid が SVG 内部の参照に使う）
let mermaidSeq = 0;

// ソース → SVG のキャッシュ。プレビューは打鍵のたびに描き直すので、
// 中身の変わっていない図まで mermaid.render に掛けるとちらつくうえ重い。
const svgCache = new Map();
const SVG_CACHE_MAX = 50;

// 要素ごとの描画世代。renderInto が呼ばれるたびに進める。非同期の描画が
// 戻ってきたとき世代が古ければ、既に作り直された DOM なので捨てる。
const generation = new WeakMap();

function putSvg(src, svg) {
  if (svgCache.size >= SVG_CACHE_MAX) svgCache.delete(svgCache.keys().next().value);
  svgCache.set(src, svg);
}

function toBox(svg) {
  const box = document.createElement("div");
  box.className = "mermaid-box";
  box.innerHTML = svg;  // mermaid が securityLevel:'strict' で生成した SVG

  // mermaid は svg に width="100%" と inline の max-width:<自然幅> を付ける。
  // その結果、狭い枠では図全体が縮尺され（1098px の図が 360px の枠で 1/3 に潰れる）、
  // ラベルが読めなくなる。自然幅を明示して縮小を止め、溢れる分は .mermaid-box 側で
  // 横スクロールさせる。CSS で width:auto にしてはいけない — viewBox しか持たない
  // SVG は幅 auto だと既定の 300px になり、かえって小さくなる。
  const el = box.querySelector("svg");
  const vb = el?.getAttribute("viewBox")?.trim().split(/[\s,]+/);
  if (vb?.length === 4 && Number.isFinite(parseFloat(vb[2]))) {
    el.style.width = `${parseFloat(vb[2])}px`;
    el.style.maxWidth = "none";
  }
  return box;
}

/**
 * el 配下の .mermaid-src を図に差し替える。非同期。
 * 失敗した図はソースのまま残し、理由を添える（黙って消さない）。
 */
async function renderMermaid(el, gen) {
  if (!mermaid) return;
  for (const block of el.querySelectorAll("pre.mermaid-src")) {
    const src = block.textContent;
    const cached = svgCache.get(src);
    if (cached) { block.replaceWith(toBox(cached)); continue; }

    let svg;
    try {
      ({ svg } = await mermaid.render(`pixie-mermaid-${mermaidSeq++}`, src));
    } catch (e) {
      // 書きかけ・構文エラーは普通に起きる。ソースを残したまま理由だけ出す。
      block.classList.add("mermaid-error");
      block.title = `Mermaid の構文エラー: ${e?.message || e}`;
      // mermaid は失敗時に一時 DOM を残すことがあるので掃除する
      document.getElementById(`dpixie-mermaid-${mermaidSeq - 1}`)?.remove();
      continue;
    }
    putSvg(src, svg);
    // await の間に描き直されていたら、この block は既に捨てられた DOM
    if (generation.get(el) !== gen) return;
    block.replaceWith(toBox(svg));
  }
}

/**
 * text を Markdown として el に描画する。
 * ベンダリングが無ければ textContent に落とす（呼び出し側は分岐しなくてよい）。
 * mermaid 図は描画が非同期なので、少し遅れて図に差し替わる。
 */
export function renderInto(el, text) {
  if (!md) {
    el.classList.remove("md");
    el.textContent = text;
    return;
  }
  el.classList.add("md");  // .md が付いた要素だけ pre-wrap をやめる（style.css 参照）
  el.innerHTML = md.render(text);
  const gen = (generation.get(el) || 0) + 1;
  generation.set(el, gen);
  renderMermaid(el, gen);
}

/** 生テキストとして描画する。ストリーミング中など、まだ Markdown が完成していない段階用。 */
export function renderPlain(el, text) {
  el.classList.remove("md");
  el.textContent = text;
}
