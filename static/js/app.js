// NoteWithPixie フロントエンド本体
import { ApiError, getJSON, jsonFetch, postJSON, tryJSON } from "./api.js";
import { available as mdAvailable, renderInto, renderPlain } from "./markdown.js";

const $ = (id) => document.getElementById(id);
const state = {
  editor: null,
  monaco: null,
  currentFile: null,
  dirty: false,
  savedVersionId: null,    // 保存時点の model.getAlternativeVersionId()。ダーティ判定の基準
  saving: false,           // 保存中フラグ（Ctrl+S 連打・自動保存との多重実行を防ぐ）
  saveError: null,         // 直近の保存失敗（ApiError）。成功でクリア
  noteDecorations: null,   // Monaco decorations collection
  notes: [],               // [{line, text}]
  history: [],             // chat history [{role, content}]
  streaming: false,
  abortCtrl: null,         // ストリーミング中の fetch を中断するための AbortController
  pendingTarget: null,     // 反映先として追跡中の選択範囲（1つだけ）
  fsEntries: [],           // /api/files の結果 [{path, type, size?}]
  collapsedDirs: new Set(),// 折りたたみ中のフォルダ
  checkedFiles: new Set(), // コンテキストに含めるファイル（再描画をまたいで保持）
  refs: [],                // 現在ノートの関連ファイル [{path, external, name}]
  checkedRefs: new Set(),  // AI コンテキストに含める関連ファイル（refKey で識別）
  copilotEnabled: true,    // Copilot モード（設定⚙️で切替、/api/settings で確定）
};

// ---- 起動 -------------------------------------------------------------------
window.__monacoReady.then((monaco) => {
  state.monaco = monaco;
  state.editor = monaco.editor.create($("editor"), {
    value: "# NoteWithPixie へようこそ\n\n右のファイル一覧からファイルを開くか、ここに書き始めましょう。\n",
    language: "markdown",
    theme: "vs-dark",
    wordWrap: "on",
    minimap: { enabled: false },
    glyphMargin: true,
    fontSize: 14,
    lineNumbers: "on",
    automaticLayout: true,
  });
  state.noteDecorations = state.editor.createDecorationsCollection();
  markClean();  // 初期バッファを基準にする

  state.editor.onDidChangeModelContent(() => { refreshDirty(); scheduleAutosave(); schedulePreview(); });
  state.editor.onDidChangeCursorSelection(updateSelectionChip);
  state.editor.onDidScrollChange(() => syncPreviewScroll());

  // Ctrl+S 保存。エディタ内は Monaco がキーを握るので addCommand が要る。
  // エディタ外（チャット入力・ツリー）は window の keydown 側が拾う（bindUI 参照）。
  state.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saveFile());
  // Ctrl+Shift+P も同様。Monaco の既定（コマンドパレット）を上書きするが、
  // Markdown ノートでパレットの出番は無く、必要なら F1 で従来どおり開ける。
  state.editor.addCommand(
    monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyP, () => togglePreview());
  // グリフ（付箋）クリックで編集
  state.editor.onMouseDown((e) => {
    if (e.target.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) {
      editNoteAt(e.target.position.lineNumber);
    }
  });

  init();
});

async function init() {
  await loadModel();
  await loadSettings();
  await loadFileList();
  await loadHistory();
  bindUI();
}

// ---- 会話履歴の永続化 ---------------------------------------------------------
// 履歴はワークスペース直下の .pixie_chat.json（サーバ側サイドカー）に置く。
// localStorage ではなくサーバに置くのは、付箋・関連ファイルと同じく
// 「ワークスペースを切り替えたら履歴も切り替わる」を自然に成立させるため。

/** サーバの履歴を state に読み込み、チャット欄に再描画する。 */
async function loadHistory() {
  state.history = [];
  $("messages").innerHTML = "";
  let r;
  try {
    r = await getJSON("/api/chat/history");
  } catch { return; }  // 履歴が読めなくてもチャット自体は使えるので黙って続行
  for (const m of r.messages || []) {
    state.history.push({ role: m.role, content: m.content });
    addMessage(m.role, m.content);
  }
}

/** state.history をサーバへ保存する。トリミングはサーバ側で行う。 */
async function saveHistory() {
  try {
    await postJSON("/api/chat/history", { messages: state.history });
  } catch { /* 保存できなくても進行中の会話は壊さない */ }
}

async function clearHistory() {
  if (!confirm("この保存先の会話履歴を消去しますか？")) return;
  try {
    await jsonFetch("/api/chat/history", { method: "DELETE" });
  } catch (e) {
    alert("⚠️ 履歴を消去できません: " + e.message);
    return;
  }
  state.history = [];
  $("messages").innerHTML = "";
}

// ---- モデル情報 -------------------------------------------------------------
async function loadModel() {
  try {
    const r = await getJSON("/api/models");
    $("model-name").textContent = r.current || "?";
  } catch { $("model-name").textContent = "未接続"; }
}

// ---- 設定（⚙️）: Copilot モードのオンオフ・モデル切替 --------------------------
async function loadSettings() {
  try {
    const s = await getJSON("/api/settings");
    state.copilotEnabled = !!s.copilot_enabled;
  } catch { /* 取得失敗時は既定（有効）のまま */ }
  applyCopilotVisibility();
}

// Copilot モードに応じて Copilot バーの表示を切り替える
function applyCopilotVisibility() {
  $("copilot-bar").classList.toggle("hidden", !state.copilotEnabled);
}

async function saveSettings(patch) {
  const r = await postJSON("/api/settings", patch);
  state.copilotEnabled = !!r.copilot_enabled;
  applyCopilotVisibility();
  if (r.chat_model) $("model-name").textContent = r.chat_model;
}

// 設定ダイアログのモデル選択肢を /api/models から埋める
async function loadModelOptions() {
  const sel = $("settings-model");
  sel.innerHTML = "";
  let models = [], current = "";
  try {
    const r = await (await fetch("/api/models")).json();
    models = r.models || [];
    current = r.current || "";
  } catch { /* バックエンド未接続 */ }
  if (current && !models.includes(current)) models = [current, ...models];
  if (!models.length) {
    const o = document.createElement("option");
    o.textContent = "（モデル未取得）"; o.disabled = true; o.selected = true;
    sel.appendChild(o);
    return;
  }
  for (const m of models) {
    const o = document.createElement("option");
    o.value = m; o.textContent = m;
    if (m === current) o.selected = true;
    sel.appendChild(o);
  }
}

function openSettingsModal() {
  $("settings-copilot").checked = state.copilotEnabled;
  $("settings-copilot-status").textContent = "";
  $("settings-modal").classList.remove("hidden");
  loadModelOptions();
}

function closeSettingsModal() { $("settings-modal").classList.add("hidden"); }

// ---- ファイル一覧（ツリー表示 + ファイル操作） --------------------------------
async function loadFileList() {
  const r = await tryJSON("/api/files");
  if (!r) return;
  const { files, root } = r;
  state.fsEntries = files;
  renderRootPath(root);
  // 消えたファイルはチェック集合からも掃除する
  const alive = new Set(files.filter((f) => f.type === "file").map((f) => f.path));
  for (const p of [...state.checkedFiles]) if (!alive.has(p)) state.checkedFiles.delete(p);
  renderFileTree();
}

// ---- 保存先ルートの表示と切り替え --------------------------------------------
function renderRootPath(root) {
  if (!root) return;
  const el = $("root-path");
  el.title = root;
  // 長いパスは末尾側（フォルダ名）を優先して見せる
  el.textContent = root.length > 48 ? "…" + root.slice(-46) : root;
}

async function browseDirs(path) {
  const resp = await fetch("/api/workspace/dirs?path=" + encodeURIComponent(path || ""));
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    alert("⚠️ " + (err.detail || resp.statusText));
    return;
  }
  const r = await resp.json();
  $("root-input").value = r.path;

  // ドライブボタン（Windows）
  const drives = $("root-drives");
  drives.innerHTML = "";
  for (const d of r.drives) {
    const b = document.createElement("button");
    b.textContent = d;
    b.classList.toggle("active", r.path.toLowerCase().startsWith(d.toLowerCase().slice(0, 2)));
    b.addEventListener("click", () => browseDirs(d));
    drives.appendChild(b);
  }

  // サブフォルダ一覧（先頭に「.. 上へ」）
  const ul = $("root-dirlist");
  ul.innerHTML = "";
  if (r.parent) {
    const li = document.createElement("li");
    li.textContent = "⬆ ..（上のフォルダへ）";
    li.addEventListener("click", () => browseDirs(r.parent));
    ul.appendChild(li);
  }
  for (const name of r.dirs) {
    const li = document.createElement("li");
    li.textContent = "📁 " + name;
    li.addEventListener("click", () => browseDirs(r.path.replace(/[\\/]$/, "") + "/" + name));
    ul.appendChild(li);
  }
}

function openRootModal() {
  $("root-modal").classList.remove("hidden");
  browseDirs("");  // 現在のワークスペースから開始
}

function closeRootModal() { $("root-modal").classList.add("hidden"); }

async function applyRootChange() {
  const root = $("root-input").value.trim();
  if (!root) return;
  await flushAutosave();
  if (state.dirty && !confirm("未保存の変更を保存できていません。破棄して保存先を切り替えますか？")) return;
  const resp = await fetch("/api/workspace", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ root }),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    alert("⚠️ " + (err.detail || resp.statusText));
    return;
  }
  closeRootModal();
  // 前のワークスペースに紐づく状態をリセットする
  state.currentFile = null;
  state.checkedFiles.clear();
  state.collapsedDirs.clear();
  state.notes = [];
  state.refs = [];
  state.checkedRefs.clear();
  state.pendingTarget = null;  // 前のファイルを指したままの反映先を持ち越さない
  renderRefList();
  state.noteDecorations?.clear();
  state.editor.setValue("# NoteWithPixie へようこそ\n\n右のファイル一覧からファイルを開くか、ここに書き始めましょう。\n");
  state.saveError = null;
  markClean();
  renderSaveState();
  $("current-file").textContent = "（ファイル未選択）";
  await loadFileList();
  await loadHistory();  // 履歴もワークスペースに紐づく。切替先のものを読み直す
}

// 祖先フォルダのどれかが折りたたまれていたら非表示
function isHiddenByCollapse(parentPath) {
  if (!parentPath) return false;
  let cur = "";
  for (const part of parentPath.split("/")) {
    cur = cur ? cur + "/" + part : part;
    if (state.collapsedDirs.has(cur)) return true;
  }
  return false;
}

function renderFileTree() {
  const ul = $("file-list");
  ul.innerHTML = "";
  for (const f of state.fsEntries) {
    const parts = f.path.split("/");
    if (isHiddenByCollapse(parts.slice(0, -1).join("/"))) continue;

    const li = document.createElement("li");
    li.dataset.path = f.path;
    li.dataset.type = f.type;
    li.style.paddingLeft = 8 + (parts.length - 1) * 16 + "px";
    setupDragDrop(li, f);

    if (f.type === "dir") {
      li.classList.add("dir");
      const icon = document.createElement("span");
      icon.textContent = state.collapsedDirs.has(f.path) ? "📁" : "📂";
      const name = document.createElement("span");
      name.className = "fname";
      name.textContent = parts[parts.length - 1];
      li.append(icon, name);
      li.addEventListener("click", () => {
        if (state.collapsedDirs.has(f.path)) state.collapsedDirs.delete(f.path);
        else state.collapsedDirs.add(f.path);
        renderFileTree();
      });
    } else {
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.title = "チャットのコンテキストに含める";
      cb.checked = state.checkedFiles.has(f.path);
      cb.addEventListener("click", (e) => e.stopPropagation());
      cb.addEventListener("change", () => {
        if (cb.checked) state.checkedFiles.add(f.path);
        else state.checkedFiles.delete(f.path);
      });
      const name = document.createElement("span");
      name.className = "fname";
      name.textContent = parts[parts.length - 1];
      name.title = f.path;
      li.append(cb, name);
      li.classList.toggle("active", f.path === state.currentFile);
      li.addEventListener("click", () => openFile(f.path));
    }
    li.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      openFsMenu(e, f);
    });
    ul.appendChild(li);
  }
}

// ドラッグ&ドロップ: ファイル/フォルダをフォルダへ移動。ルート（一覧の余白）へ落とすと最上位へ。
function setupDragDrop(li, entry) {
  li.draggable = true;
  li.addEventListener("dragstart", (e) => {
    _dragging = entry.path;
    e.dataTransfer.setData("text/plain", entry.path);
    e.dataTransfer.effectAllowed = "move";
    li.classList.add("dragging");
  });
  li.addEventListener("dragend", () => {
    _dragging = null;
    li.classList.remove("dragging");
    document.querySelectorAll("#file-list li.drop-target").forEach((x) => x.classList.remove("drop-target"));
  });

  if (entry.type !== "dir") return;  // ドロップ先はフォルダのみ（ルートは ul が受ける）
  li.addEventListener("dragover", (e) => {
    const src = _dragging;
    if (src === null || src === entry.path) return;
    if (entry.path.startsWith(src + "/")) return;  // 自分の子孫の中へは不可
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    li.classList.add("drop-target");
  });
  li.addEventListener("dragleave", () => li.classList.remove("drop-target"));
  li.addEventListener("drop", (e) => {
    e.preventDefault();
    e.stopPropagation();
    li.classList.remove("drop-target");
    const src = e.dataTransfer.getData("text/plain") || _dragging;
    if (src && src !== entry.path) moveIntoDir(src, entry.path);
  });
}

// dragover 中は getData が空になるブラウザがあるため、進行中パスを保持しておく。
let _dragging = null;

// 一覧の余白（ul）へのドロップ = 最上位フォルダへ移動。一度だけ結線する。
function setupRootDrop() {
  const ul = $("file-list");
  ul.addEventListener("dragover", (e) => {
    if (_dragging === null) return;
    if (e.target.closest("li")) return;  // li 上は各 li のハンドラに任せる
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    ul.classList.add("drop-root");
  });
  ul.addEventListener("dragleave", (e) => {
    if (!ul.contains(e.relatedTarget)) ul.classList.remove("drop-root");
  });
  ul.addEventListener("drop", (e) => {
    ul.classList.remove("drop-root");
    if (e.target.closest("li")) return;
    e.preventDefault();
    const src = e.dataTransfer.getData("text/plain") || _dragging;
    if (src) moveIntoDir(src, "");  // ルートへ
  });
}

// --- 右クリックメニュー ---
function closeFsMenu() { document.getElementById("fs-menu")?.remove(); }

function openFsMenu(e, entry) {
  closeFsMenu();
  const menu = document.createElement("div");
  menu.id = "fs-menu";
  const add = (label, fn) => {
    const it = document.createElement("div");
    it.className = "fs-menu-item";
    it.textContent = label;
    it.addEventListener("click", () => { closeFsMenu(); fn(); });
    menu.appendChild(it);
  };
  if (entry.type === "dir") {
    add("📄 中に新規ファイル", () => createEntry("file", entry.path + "/"));
    add("📁 中に新規フォルダ", () => createEntry("dir", entry.path + "/"));
  }
  add("✏️ 名前変更・移動", () => renameEntry(entry));
  add("🗑️ 削除", () => deleteEntry(entry));
  menu.style.left = e.pageX + "px";
  menu.style.top = e.pageY + "px";
  document.body.appendChild(menu);
}

// --- ファイル操作 ---
async function fsPost(url, body) {
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    alert("⚠️ " + (err.detail || resp.statusText));
    return false;
  }
  return true;
}

async function createEntry(kind, prefix = "") {
  const label = kind === "dir" ? "新規フォルダ名（例: docs/資料）" : "新規ファイル名（例: docs/note.md）";
  const name = prompt(label, prefix);
  if (!name || !name.trim() || name.trim() === prefix.trim()) return;
  const path = name.trim().replace(/\\/g, "/");
  if (!(await fsPost("/api/fs/create", { path, kind }))) return;
  if (kind === "dir") state.collapsedDirs.delete(path);
  await loadFileList();
  if (kind === "file") await openFile(path);
}

async function renameEntry(entry) {
  const dst = prompt("新しいパス（フォルダに入れるには docs/名前.md のように）", entry.path);
  if (!dst || !dst.trim() || dst.trim() === entry.path) return;
  await moveEntry(entry, dst.trim().replace(/\\/g, "/"));
}

// entry を新パス dst へ移動/改名し、開いているファイル・チェック集合を追従させる。
// rename と drag&drop の共通処理。
async function moveEntry(entry, dst) {
  if (!dst || dst === entry.path) return;
  // フォルダを自分自身の中へは移動できない
  if (entry.type === "dir" && (dst === entry.path || dst.startsWith(entry.path + "/"))) {
    alert("⚠️ フォルダを自分自身の中へは移動できません。");
    return;
  }
  if (!(await fsPost("/api/fs/rename", { src: entry.path, dst }))) return;
  const remap = (p) => {
    if (p === entry.path) return dst;
    if (entry.type === "dir" && p.startsWith(entry.path + "/")) return dst + p.slice(entry.path.length);
    return p;
  };
  if (state.currentFile) {
    const np = remap(state.currentFile);
    if (np !== state.currentFile) { state.currentFile = np; $("current-file").textContent = np; }
  }
  state.checkedFiles = new Set([...state.checkedFiles].map(remap));
  await loadFileList();
}

// ドロップ先フォルダ（空文字＝ルート）へ entry を移動する。
async function moveIntoDir(srcPath, dstDir) {
  const entry = state.fsEntries.find((f) => f.path === srcPath);
  if (!entry) return;
  const base = srcPath.split("/").pop();
  const dst = dstDir ? dstDir + "/" + base : base;
  if (dst === srcPath) return;                    // 既に同じ場所
  if (srcPath.split("/").slice(0, -1).join("/") === dstDir) return;  // 親が変わらない
  await moveEntry(entry, dst);
}

async function deleteEntry(entry) {
  if (!confirm(`「${entry.path}」を削除しますか？`)) return;
  if (!(await fsPost("/api/fs/delete", { path: entry.path }))) return;
  if (state.currentFile === entry.path) {
    state.currentFile = null;
    $("current-file").textContent = "（ファイル未選択）";
  }
  state.checkedFiles.delete(entry.path);
  await loadFileList();
}

async function openFile(path) {
  await flushAutosave();
  // flush しても dirty なら保存に失敗している。そのときだけ破棄の確認を出す。
  if (state.dirty && !confirm("未保存の変更を保存できていません。破棄して開きますか？")) return;
  const r = await tryJSON("/api/file?path=" + encodeURIComponent(path));
  if (!r) return;  // 読めなかったら現在の内容を壊さずに留まる
  state.currentFile = path;
  state.editor.setValue(r.content);
  state.saveError = null;
  markClean();
  renderSaveState();
  $("current-file").textContent = path;
  renderPreview();  // setValue は onDidChangeModelContent を通らない経路があるので明示的に
  renderFileTree();
  await loadNotes();
  await loadRefs();
}

/**
 * 現在のバッファを保存する。
 * opts.silent: ファイル未選択でも名前を尋ねない（自動保存用。打鍵2秒後に prompt が
 *   飛び出すのを防ぐ）。未選択なら何もせず false を返す。
 * 戻り値: 保存できたら true。
 */
async function saveFile(opts = {}) {
  if (state.saving) return false;          // 多重実行を防ぐ（Ctrl+S 連打・自動保存との競合）
  clearTimeout(autosaveTimer);             // 今保存するので、予約済みの自動保存は用済み
  if (!state.currentFile) {
    if (opts.silent) return false;
    const name = prompt("保存するファイル名（例: note.md）");
    if (!name) return false;
    state.currentFile = name;
    $("current-file").textContent = name;
  }
  const isNew = !state.fsEntries.some((f) => f.path === state.currentFile);
  // 保存する内容のバージョンを先に採る。POST 中の編集を「保存済」に含めないため。
  const versionAtSave = state.editor.getModel().getAlternativeVersionId();

  state.saving = true;
  renderSaveState("saving");
  try {
    await postJSON("/api/file", {
      path: state.currentFile,
      content: state.editor.getValue(),
    });
    await persistNotes();  // 本文編集で移動した付箋位置も保存に反映する
    state.saveError = null;
    state.savedVersionId = versionAtSave;
    refreshDirty();        // 保存中に編集されていれば、ここで未保存へ戻る
    renderSaveState("saved");
    // 新規ファイルのときだけツリーを取り直す。自動保存のたびに叩くのは過剰。
    if (isNew) await loadFileList();
    return true;
  } catch (e) {
    // 失敗したらダーティのまま残す。ここで clean にすると変更が消えたことに気付けない。
    state.saveError = e instanceof ApiError ? e : new ApiError(String(e), 0);
    renderSaveState();
    return false;
  } finally {
    state.saving = false;
  }
}

// ---- 関連ファイル参照（別ディレクトリの .pptx 等をノートに紐付ける）------------
// テキストとして AI 文脈に流せる拡張子（バックエンド files.TEXT_EXTS と揃える）
const REF_TEXT_EXTS = new Set(
  ["md", "markdown", "txt", "py", "json", "yaml", "yml", "toml", "csv", "html", "css", "js", "ts"]
);
const refKey = (r) => (r.external ? "E:" : "I:") + r.path;
const baseName = (p) => p.split(/[\\/]/).pop();
function isTextRef(r) {
  return REF_TEXT_EXTS.has((r.path.split(".").pop() || "").toLowerCase());
}

async function loadRefs() {
  if (!state.currentFile) { state.refs = []; renderRefList(); return; }
  const r = await tryJSON("/api/refs?path=" + encodeURIComponent(state.currentFile));
  if (!r) return;
  state.refs = r.refs || [];
  const alive = new Set(state.refs.map(refKey));  // 消えた参照のチェックを掃除
  for (const k of [...state.checkedRefs]) if (!alive.has(k)) state.checkedRefs.delete(k);
  renderRefList();
}

async function saveRefs() {
  if (!state.currentFile) return;
  await tryJSON("/api/refs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: state.currentFile, refs: state.refs }),
  });
}

async function addRef(ref) {
  if (!state.currentFile) { alert("先にノートを開いてください。"); return; }
  if (state.refs.some((r) => refKey(r) === refKey(ref))) return;  // 重複は無視
  state.refs.push(ref);
  await saveRefs();
  renderRefList();
}

async function removeRef(i) {
  const [r] = state.refs.splice(i, 1);
  if (r) state.checkedRefs.delete(refKey(r));
  await saveRefs();
  renderRefList();
}

async function openRef(r) {
  const resp = await fetch("/api/refs/open", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ note: state.currentFile, path: r.path, external: !!r.external }),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    alert("⚠️ 開けませんでした: " + (err.detail || resp.statusText));
  }
}

function renderRefList() {
  const ul = $("ref-list");
  const empty = $("ref-empty");
  ul.innerHTML = "";
  if (!state.currentFile) {
    empty.textContent = "ファイルを開くと関連ファイルを紐付けられます。";
    empty.classList.remove("hidden");
    return;
  }
  if (!state.refs.length) {
    empty.textContent = "ここにファイルをドラッグ、または「＋参照を追加」で紐付けます。";
    empty.classList.remove("hidden");
    return;
  }
  empty.classList.add("hidden");
  state.refs.forEach((r, i) => {
    const li = document.createElement("li");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.title = isTextRef(r)
      ? "AIコンテキストに含める"
      : "AIコンテキストに含める（.pptx等はエージェント/Copilot経路のみ有効）";
    cb.checked = state.checkedRefs.has(refKey(r));
    cb.addEventListener("click", (e) => e.stopPropagation());
    cb.addEventListener("change", () => {
      if (cb.checked) state.checkedRefs.add(refKey(r));
      else state.checkedRefs.delete(refKey(r));
    });
    const icon = document.createElement("span");
    icon.textContent = r.external ? "🔗" : "📄";  // 外部=🔗 / ワークスペース内=📄
    const name = document.createElement("span");
    name.className = "fname";
    name.textContent = r.name || baseName(r.path);
    name.title = r.path + "（クリックで既定アプリで開く）";
    name.addEventListener("click", () => openRef(r));
    const del = document.createElement("button");
    del.className = "ref-del";
    del.textContent = "×";
    del.title = "参照を外す";
    del.addEventListener("click", (e) => { e.stopPropagation(); removeRef(i); });
    li.append(cb, icon, name, del);
    ul.appendChild(li);
  });
}

// file:///C:/a/b.pptx → C:/a/b.pptx（OS ドラッグで uri-list が取れた場合のみ）
function fileUriToPath(uriList) {
  const line = (uriList || "").split(/\r?\n/).find((l) => l && !l.startsWith("#"));
  if (!line || !/^file:/i.test(line)) return null;
  let u = decodeURIComponent(line.replace(/^file:\/\//i, ""));
  if (/^\/[A-Za-z]:/.test(u)) u = u.slice(1);  // Windows: /C:/… → C:/…
  return u.replace(/\\/g, "/");
}

function setupRefDrop() {
  const zone = $("refmgr");
  zone.addEventListener("dragover", (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    zone.classList.add("ref-drop");
  });
  zone.addEventListener("dragleave", (e) => {
    if (!zone.contains(e.relatedTarget)) zone.classList.remove("ref-drop");
  });
  zone.addEventListener("drop", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    zone.classList.remove("ref-drop");
    if (!state.currentFile) { alert("先にノートを開いてください。"); return; }

    // 1) アプリ内ファイルツリーからのドラッグ（ワークスペース相対パスが確実に取れる）
    if (_dragging) {
      const ent = state.fsEntries.find((f) => f.path === _dragging);
      if (ent && ent.type === "file") {
        await addRef({ path: _dragging, external: false, name: baseName(_dragging) });
      } else {
        alert("フォルダは参照に追加できません。ファイルをドラッグしてください。");
      }
      return;
    }
    // 2) OS エクスプローラからのドラッグ（絶対パスが取れる場合のみ）
    const p = fileUriToPath(e.dataTransfer.getData("text/uri-list") ||
                            e.dataTransfer.getData("text/plain"));
    if (p) {
      await addRef({ path: p, external: true, name: baseName(p) });
      return;
    }
    if (e.dataTransfer.files && e.dataTransfer.files.length) {
      alert("ブラウザの制限でドラッグしたファイルの絶対パスを取得できません。\n" +
            "外部ファイルは「＋参照を追加」から選んでください。");
    }
  });
}

// ---- 関連ファイル選択ダイアログ（任意ディレクトリのファイルを参照に追加）--------
async function browsePick(path) {
  const resp = await fetch("/api/workspace/dirs?files=true&path=" + encodeURIComponent(path || ""));
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    alert("⚠️ " + (err.detail || resp.statusText));
    return;
  }
  const r = await resp.json();
  $("pick-input").value = r.path;

  const drives = $("pick-drives");
  drives.innerHTML = "";
  for (const d of r.drives) {
    const b = document.createElement("button");
    b.textContent = d;
    b.classList.toggle("active", r.path.toLowerCase().startsWith(d.toLowerCase().slice(0, 2)));
    b.addEventListener("click", () => browsePick(d));
    drives.appendChild(b);
  }

  const ul = $("pick-list");
  ul.innerHTML = "";
  if (r.parent) {
    const li = document.createElement("li");
    li.textContent = "⬆ ..（上のフォルダへ）";
    li.addEventListener("click", () => browsePick(r.parent));
    ul.appendChild(li);
  }
  for (const name of r.dirs) {
    const li = document.createElement("li");
    li.textContent = "📁 " + name;
    li.addEventListener("click", () => browsePick(r.path.replace(/[\\/]$/, "") + "/" + name));
    ul.appendChild(li);
  }
  for (const name of (r.files || [])) {
    const li = document.createElement("li");
    li.className = "pick-file";
    li.textContent = "📄 " + name;
    li.addEventListener("click", async () => {
      const abs = (r.path.replace(/[\\/]$/, "") + "/" + name).replace(/\\/g, "/");
      await addRef({ path: abs, external: true, name });
      closePickModal();
    });
    ul.appendChild(li);
  }
}

function openPickModal() {
  if (!state.currentFile) { alert("先にノートを開いてください。"); return; }
  $("pick-modal").classList.remove("hidden");
  browsePick("");  // 現在のワークスペースから開始
}

function closePickModal() { $("pick-modal").classList.add("hidden"); }

// ---- 保存状態 ---------------------------------------------------------------
// ダーティ判定は Monaco の alternativeVersionId を基準にする。単なる「編集された」
// フラグだと Undo で内容を戻しても未保存のままになるが、この ID は Undo/Redo で
// 元の値に戻るので「保存時と同じ内容か」を正しく表せる。
let saveStateTimer = null;

function markClean() {
  state.savedVersionId = state.editor.getModel().getAlternativeVersionId();
  state.dirty = false;
}

function refreshDirty() {
  const now = state.editor.getModel().getAlternativeVersionId();
  state.dirty = now !== state.savedVersionId;
  renderSaveState();
}

/** 保存インジケータの唯一の描画点。state から表示を決める。 */
function renderSaveState(transient) {
  const el = $("save-state");
  clearTimeout(saveStateTimer);
  el.classList.remove("save-error");
  el.title = "";

  if (transient === "saving") { el.textContent = "保存中…"; return; }
  if (transient === "saved") {
    el.textContent = "保存済";
    saveStateTimer = setTimeout(renderSaveState, 1500);  // 1.5秒で状態表示へ戻す
    return;
  }
  if (state.saveError) {
    el.textContent = "⚠️ 保存失敗";
    el.classList.add("save-error");
    el.title = state.saveError.message;
    return;
  }
  el.textContent = state.dirty ? "● 未保存" : "";
}

// ---- Markdown プレビュー -----------------------------------------------------
// 既定は非表示（従来の見た目を変えない）。表示中はエディタと横半分ずつ。
// 差分プレビュー（#diff-overlay）は #left-pane を覆うので、こちらは何もしなくてよい。
const PREVIEW_DEBOUNCE_MS = 150;  // 自動保存の2秒とは別物。プレビューは即応が要る
let previewTimer = null;

function isPreviewOpen() { return !$("preview").classList.contains("hidden"); }

function renderPreview() {
  if (!isPreviewOpen()) return;
  renderInto($("preview"), state.editor.getValue());
  syncPreviewScroll();
}

function schedulePreview() {
  if (!isPreviewOpen()) return;
  clearTimeout(previewTimer);
  previewTimer = setTimeout(renderPreview, PREVIEW_DEBOUNCE_MS);
}

// エディタのスクロール位置に比率で追従させる。行単位の対応付け（source map）は
// markdown-it のプラグインが要るうえ重いので、まず比率で足りるかを見る。
function syncPreviewScroll() {
  if (!isPreviewOpen()) return;
  const ed = state.editor;
  const max = ed.getScrollHeight() - ed.getLayoutInfo().height;
  const ratio = max > 0 ? ed.getScrollTop() / max : 0;
  const pv = $("preview");
  pv.scrollTop = ratio * (pv.scrollHeight - pv.clientHeight);
}

function togglePreview() {
  if (!mdAvailable()) {
    alert("⚠️ Markdown プレビューを使うには、先に次を実行してください:\n"
          + "python -m pipenv run python scripts/fetch_markdown_it.py");
    return;
  }
  const open = !isPreviewOpen();
  $("preview").classList.toggle("hidden", !open);
  $("preview-btn").classList.toggle("active", open);
  if (open) renderPreview();
  // automaticLayout: true なので Monaco 側の再計算は自動で追従する
}

// ---- 自動保存 ---------------------------------------------------------------
// 打鍵が落ち着いてから保存する。ファイル未選択のときは silent で抜けるので、
// 「書き始めて2秒後にファイル名の prompt が飛び出す」ことはない。
const AUTOSAVE_DELAY_MS = 2000;
let autosaveTimer = null;

function scheduleAutosave() {
  clearTimeout(autosaveTimer);
  if (!state.currentFile || !state.dirty) return;
  autosaveTimer = setTimeout(() => {
    if (!state.dirty) return;              // 2秒の間に Ctrl+S で保存済みかもしれない
    if (state.saving) { scheduleAutosave(); return; }  // 保存中なら捨てずに予約し直す
    saveFile({ silent: true });
  }, AUTOSAVE_DELAY_MS);
}

/** 保留中の自動保存を今すぐ実行する。ファイル切替・ルート変更・タブ離脱の直前に呼ぶ。 */
async function flushAutosave() {
  clearTimeout(autosaveTimer);
  if (state.currentFile && state.dirty) await saveFile({ silent: true });
}

// ---- 選択テキスト -----------------------------------------------------------
function getSelection() {
  const sel = state.editor.getSelection();
  return state.editor.getModel().getValueInRange(sel);
}
function updateSelectionChip() {
  const has = getSelection().trim().length > 0;
  $("sel-chip").classList.toggle("hidden", !has);
  $("sel-info").textContent = has ? "選択中：AIに送れます" : "テキストを選択してAIに送れます";
}

// ---- 付箋（インラインコメント） ---------------------------------------------
async function loadNotes() {
  if (!state.currentFile) { state.notes = []; renderNotes(); return; }
  const r = await tryJSON("/api/notes?path=" + encodeURIComponent(state.currentFile));
  if (!r) return;
  state.notes = r.notes || [];
  renderNotes();
}
async function persistNotes() {
  if (!state.currentFile) return;
  syncNotesFromDecorations();
  // 付箋の保存失敗は saveFile 側の状態表示に載せたいので、ここでは投げっぱなしにせず伝播させる。
  await jsonFetch("/api/notes?path=" + encodeURIComponent(state.currentFile), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(state.notes),
  });
}
// Monaco は編集に合わせてデコレーションを自動で移動する。その現在位置を
// state.notes に読み戻すことで、行の挿入・削除に付箋を追従させる。
// state.notes[i] とデコレーション collection の index は同順で対応する。
function syncNotesFromDecorations() {
  if (!state.noteDecorations) return;
  state.notes.forEach((n, i) => {
    const r = state.noteDecorations.getRange(i);
    if (r) n.line = r.startLineNumber;
  });
}
function renderNotes() {
  const m = state.monaco;
  const decos = state.notes.map((n) => ({
    range: new m.Range(n.line, 1, n.line, 1),
    options: {
      isWholeLine: true,
      glyphMarginClassName: "pixie-note-glyph",
      className: "pixie-note-line",
      glyphMarginHoverMessage: { value: "📌 " + n.text },
    },
  }));
  state.noteDecorations.set(decos);
}
function addNote() {
  syncNotesFromDecorations();  // 既存付箋の現在位置を確定してから追加する
  const line = state.editor.getPosition().lineNumber;
  const text = prompt("付箋メモ（例: ここをAIに膨らませてもらう）");
  if (!text) return;
  state.notes = state.notes.filter((n) => n.line !== line);
  state.notes.push({ line, text });
  renderNotes();
  persistNotes().catch((e) => alert("⚠️ 付箋の保存に失敗しました: " + e.message));
}
function editNoteAt(line) {
  syncNotesFromDecorations();  // クリック行と付箋の現在位置を一致させてから照合
  const existing = state.notes.find((n) => n.line === line);
  const text = prompt("付箋メモ（空で削除）", existing ? existing.text : "");
  if (text === null) return;   // キャンセル時は変更しない
  state.notes = state.notes.filter((n) => n.line !== line);
  if (text.trim()) state.notes.push({ line, text });
  renderNotes();
  persistNotes().catch((e) => alert("⚠️ 付箋の保存に失敗しました: " + e.message));
}

// ---- 全文検索 ---------------------------------------------------------------
let searchTimer = null;
async function runSearch(q) {
  const box = $("search-results");
  const list = $("file-list");
  if (!q.trim()) { box.classList.add("hidden"); list.classList.remove("hidden"); return; }
  const r = await tryJSON("/api/search?q=" + encodeURIComponent(q));
  if (!r) return;
  const { results } = r;
  box.innerHTML = "";
  for (const hit of results) {
    const div = document.createElement("div");
    div.className = "search-hit";
    div.innerHTML =
      `<span class="loc">${escapeHtml(hit.path)}:${hit.line}</span> ${escapeHtml(hit.text)}`;
    div.addEventListener("click", async () => {
      await openFile(hit.path);
      state.editor.revealLineInCenter(hit.line);
      state.editor.setPosition({ lineNumber: hit.line, column: 1 });
    });
    box.appendChild(div);
  }
  list.classList.add("hidden");
  box.classList.remove("hidden");
}

// ---- チャット ---------------------------------------------------------------
function collectContext() {
  return [...state.checkedFiles];
}

// ---- Copilot 連携（人がブラウザで対話 → 会話を取り込んでまとめる）------------
function setCopilotStatus(text) { $("copilot-status").textContent = text; }

async function openCopilot() {
  setCopilotStatus("ブラウザを起動中…");
  try {
    const r = await (await fetch("/api/copilot/open", { method: "POST" })).json();
    setCopilotStatus(r.ok ? "Copilot を開きました。ブラウザで対話してください。" : r.error);
  } catch (e) {
    setCopilotStatus("エラー: " + e.message);
  }
}

// 設定モーダル内の「Copilot を開く」。状態はモーダル内に表示する（バーは隠れているため）。
async function openCopilotFromSettings() {
  const s = $("settings-copilot-status");
  s.textContent = "ブラウザを起動中…";
  try {
    const r = await (await fetch("/api/copilot/open", { method: "POST" })).json();
    s.textContent = r.ok ? "Copilot を開きました。ブラウザでログイン/対話してください。" : r.error;
  } catch (e) {
    s.textContent = "エラー: " + e.message;
  }
}

async function importCopilotChat() {
  if (state.streaming) return;
  const btn = $("copilot-import-btn");
  btn.disabled = true;
  setCopilotStatus("会話を取得中…");
  let r;
  try {
    r = await (await fetch("/api/copilot/read", { method: "POST" })).json();
  } catch (e) {
    setCopilotStatus("エラー: " + e.message);
    btn.disabled = false;
    return;
  }
  btn.disabled = false;
  if (!r.ok) { setCopilotStatus(r.error); return; }
  setCopilotStatus("");

  // 入力欄に指示があればそれを優先。無ければ既定の「まとめて」指示。
  const input = $("chat-input");
  const instruction = input.value.trim()
    || "以下は私が Microsoft Copilot と交わした会話ログです。内容を整理して、ノートとして残せる Markdown のまとめを作ってください。";
  input.value = "";
  sendChat(instruction + "\n\n---\n\n# Copilot 会話ログ\n\n" + r.transcript);
}

// URL のページを Markdown 化して web/ に保存し、エディタで開く
async function importUrlAsMarkdown() {
  const url = prompt("Markdown にする URL（ログインが必要なページはブラウザで手動ログイン）");
  if (!url || !url.trim()) return;
  const btn = $("web2md-btn");
  btn.disabled = true;
  btn.textContent = "⏳";
  try {
    const r = await (await fetch("/api/web2md", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: url.trim() }),
    })).json();
    if (!r.ok) { alert(r.error); return; }
    await loadFileList();
    await openFile(r.path);
  } catch (e) {
    alert("エラー: " + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "🌐+";
  }
}

// 送信ボタンを「送信 ⇔ 停止」で切り替える
function setSendButtonMode(mode) {
  const btn = $("send-btn");
  if (mode === "stop") {
    btn.textContent = "⏹ 停止";
    btn.classList.add("stop");
    btn.title = "応答の生成を中断する";
  } else {
    btn.textContent = "送信";
    btn.classList.remove("stop");
    btn.title = "";
  }
}

// ストリーミング中の応答を中断する（途中までの本文は残る）
function cancelChat() {
  if (state.abortCtrl) state.abortCtrl.abort();
}

async function sendChat(presetMessage) {
  if (state.streaming) return;
  const input = $("chat-input");
  const fromInput = typeof presetMessage !== "string";
  const message = (fromInput ? input.value : presetMessage).trim();
  if (!message) return;
  if (fromInput) input.value = "";

  const selection = getSelection();
  const applyTarget = trackApplyTarget();  // 送信時の選択範囲を追跡（編集してもズレない）
  const contextPaths = collectContext();
  const context_files = [];
  for (const p of contextPaths) {
    const r = await (await fetch("/api/file?path=" + encodeURIComponent(p))).json();
    context_files.push({ path: p, content: r.content });
  }

  // チェック済みの関連ファイル: テキストは内容を文脈へ、バイナリ/外部は絶対パスを Copilot 添付へ
  const ref_texts = [];
  const attach_files = [];
  if (state.currentFile) {
    for (let i = 0; i < state.refs.length; i++) {
      const r = state.refs[i];
      if (!state.checkedRefs.has(refKey(r))) continue;
      if (isTextRef(r)) {
        const rr = await (await fetch(
          `/api/refs/read?note=${encodeURIComponent(state.currentFile)}&idx=${i}`)).json();
        if (rr && rr.content != null) ref_texts.push({ path: r.path, content: rr.content });
      } else {
        attach_files.push(r.path);
      }
    }
  }

  addMessage("user", message);
  const assistantEl = addMessage("assistant", "");
  const ui = beginAssistantStream(assistantEl);  // 応答待ちインジケータ + 思考ボックス
  state.streaming = true;
  state.abortCtrl = new AbortController();
  setSendButtonMode("stop");
  let cancelled = false;

  try {
    const resp = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: state.abortCtrl.signal,
      body: JSON.stringify({
        message, selection, context_files, history: state.history,
        // 「このファイル」が指せるよう、開いているファイルを常に添える。
        // 未保存の編集も含めたいのでディスクではなくエディタの内容を送る。
        current_file: state.currentFile || "",
        current_content: state.currentFile ? state.editor.getModel().getValue() : "",
        ref_texts, attach_files,  // チェック済みの関連ファイル
      }),
    });
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const events = buf.split("\n\n");
      buf = events.pop();
      for (const ev of events) {
        const line = ev.replace(/^data:\s*/, "");
        if (line === "[DONE]") continue;
        try {
          const ev = JSON.parse(line);
          if (ev.t) ui.onToken(ev.t);
          if (ev.r) ui.onReason(ev.r);
          if (ev.s) addToolStatus(assistantEl, ev.s);  // ツール実行ログ（本文・履歴には含めない）
        } catch {}
      }
    }
  } catch (e) {
    if (e.name === "AbortError") {
      cancelled = true;  // ユーザーによる停止。途中までの本文はそのまま残す
    } else {
      ui.onToken("\n\n> ⚠️ 接続エラー: " + e.message);
    }
  }
  const visible = ui.finish();  // 思考部分を除いた本文（履歴・反映の対象）
  state.streaming = false;
  state.abortCtrl = null;
  setSendButtonMode("send");
  if (cancelled) addToolStatus(assistantEl, "⏹ キャンセルしました" + (visible.trim() ? "（途中までの応答を表示しています）" : ""));

  state.history.push({ role: "user", content: message });
  // キャンセル直後で本文が空なら、空のアシスタント発言を履歴に残さない
  if (visible.trim() || !cancelled) state.history.push({ role: "assistant", content: visible });
  saveHistory();  // 1往復ぶんが確定したところで永続化（ストリーミング中は書かない）

  // トリガー優先順: search/replace ペア（部分編集）→ ```apply（全置換）→ 汎用挿入
  const edits = extractEdits(visible);
  if (edits.length) {
    renderPatchAction(assistantEl, visible, edits);
  } else {
    const hasApply = renderApplyBlock(assistantEl, visible, applyTarget);
    if (!hasApply && visible.trim()) addInsertAction(assistantEl, visible, applyTarget);
  }
}

// 本文先頭の <think>...</think>（qwen 系が content に混ぜる形式）を分離する。
function splitThink(s) {
  const m = s.match(/^\s*<think>([\s\S]*?)(?:<\/think>\s*([\s\S]*))?$/);
  if (m) return { think: m[1], visible: m[2] ?? "" };
  return { think: "", visible: s };
}

// 応答ストリームの表示管理。prefill 待ち → 思考中 → 本文、の3段階で反応を出す。
function beginAssistantStream(el) {
  const startedAt = performance.now();
  let raw = "";      // content トークンの生蓄積（<think> を含みうる）
  let reason = "";   // reasoning トークンの蓄積
  let thinkBox = null, thinkBody = null, thinkSummary = null;

  // 待機インジケータ（送信直後から表示）
  const wait = document.createElement("div");
  wait.className = "wait-indicator";
  wait.innerHTML = `<span class="dots"><i></i><i></i><i></i></span><span class="wait-text"></span>`;
  el.insertBefore(wait, el.querySelector(".body"));
  const waitText = wait.querySelector(".wait-text");
  let phase = "prefill";  // prefill -> thinking -> (removed)
  const timer = setInterval(() => {
    const sec = ((performance.now() - startedAt) / 1000).toFixed(1);
    waitText.textContent = phase === "prefill"
      ? `応答を待っています（prefill 中… ${sec}s）`
      : `思考中… ${sec}s`;
    scrollMessages();
  }, 200);
  waitText.textContent = "応答を待っています（prefill 中…）";

  function ensureThinkBox() {
    if (thinkBox) return;
    thinkBox = document.createElement("details");
    thinkBox.className = "think-box";
    thinkBox.open = true;
    thinkSummary = document.createElement("summary");
    thinkSummary.textContent = "💭 思考中…";
    thinkBody = document.createElement("div");
    thinkBody.className = "think-body";
    thinkBox.append(thinkSummary, thinkBody);
    el.insertBefore(thinkBox, el.querySelector(".body"));
  }

  function render() {
    const { think, visible } = splitThink(raw);
    const allThink = (reason + think).trim();
    if (allThink) { ensureThinkBox(); thinkBody.textContent = allThink; }
    if (visible.trim()) {
      if (wait.isConnected) wait.remove();   // 本文が出始めたら待機表示は不要
      // ストリーミング中は生テキストのまま。トークンごとに Markdown を組み直すと
      // 重いうえ、閉じていないフェンスが崩れて見える。整形は finish() で一度だけ行う。
      renderPlain(el.querySelector(".body"), visible);
    } else if (allThink && phase === "prefill") {
      phase = "thinking";                     // 思考だけ流れている段階
    }
    scrollMessages();
  }

  return {
    onToken(t) { raw += t; render(); },
    onReason(r) { reason += r; render(); },
    finish() {
      clearInterval(timer);
      if (wait.isConnected) wait.remove();
      const { think, visible } = splitThink(raw);
      const allThink = (reason + think).trim();
      if (thinkBox) {
        const sec = ((performance.now() - startedAt) / 1000).toFixed(1);
        thinkSummary.textContent = `💭 思考ログ（${allThink.length}文字・${sec}s）`;
        thinkBox.open = false;               // 完了したら折りたたむ（クリックで展開）
        // 思考ログは Markdown 化しない。整形せず「モデルが吐いたまま」を見せたい。
      }
      // 本文が出揃ったのでここで一度だけ Markdown へ。search/replace 提案があれば
      // このあと renderPatchAction がフェンスを置換して描き直す。
      if (visible.trim()) renderInto(el.querySelector(".body"), visible);
      return visible;
    },
  };
}

// ```search / ```replace のペアを順に抽出する。
function extractEdits(text) {
  const edits = [];
  const re = /```search\s*\n([\s\S]*?)```\s*\n\s*```replace\s*\n([\s\S]*?)```/g;
  for (const m of text.matchAll(re)) {
    edits.push({ search: m[1].replace(/\n$/, ""), replace: m[2].replace(/\n$/, "") });
  }
  return edits;
}

// 部分編集の提案：ボタンを付け、押下でサーバ計算 → 差分プレビュー → 適用。
function renderPatchAction(el, text, edits) {
  // フェンスを畳んでから Markdown 化する。順序が逆だと search/replace の中身が
  // コードブロックとして本文に展開されてしまう。
  const folded =
    text.replace(/```search\s*\n[\s\S]*?```\s*\n\s*```replace\s*\n[\s\S]*?```/g, "📝 修正案（差分で確認）");
  renderInto(el.querySelector(".body"), folded);
  const actions = document.createElement("div");
  actions.className = "apply-actions";
  const btn = document.createElement("button");
  btn.className = "apply-btn";
  btn.textContent = `▶ 差分で反映（${edits.length}箇所）`;
  btn.addEventListener("click", () => reflectViaPatch(edits, el));
  actions.appendChild(btn);
  el.appendChild(actions);
  scrollMessages();
}

// search/replace 編集を文書全体に対してサーバで計算し、差分プレビューへ。
async function reflectViaPatch(edits, msgEl) {
  const base = state.editor.getModel().getValue();
  let r;
  try {
    const resp = await fetch("/api/patch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ base, edits }),
    });
    r = await resp.json();
  } catch (e) {
    addToolStatus(msgEl, "⚠️ 適用計算に失敗: " + e.message);
    return;
  }
  // 失敗した編集はステータス行で知らせる（ヒント付き）
  r.results.forEach((res, i) => {
    if (!res.ok) addToolStatus(msgEl, `⚠️ 修正${i + 1}: ${res.error.split("\n")[0]}`);
    else if (res.method !== "exact") addToolStatus(msgEl, `ℹ️ 修正${i + 1}: ${res.method} マッチで補正適用`);
  });
  if (r.applied === 0) {
    addToolStatus(msgEl, "⚠️ 適用できる修正がありませんでした。本文が変わっていないか確認してください。");
    return;
  }
  openDiffPreview(base, r.content, (finalText) => {
    const model = state.editor.getModel();
    state.editor.executeEdits("pixie-patch",
      [{ range: model.getFullModelRange(), text: finalText, forceMoveMarkers: true }]);
    state.editor.focus();  // ダーティ化は onDidChangeModelContent → refreshDirty が拾う
  }, `差分プレビュー：${r.applied}/${edits.length} 箇所を適用（右は編集して調整可）`);
}

// 送信時の選択範囲をデコレーションとして記録。以降の編集に追随する。
function trackApplyTarget() {
  if (state.pendingTarget?.coll) state.pendingTarget.coll.clear();  // 前回のハイライトを消す
  const sel = state.editor.getSelection();
  if (!sel || sel.isEmpty()) { state.pendingTarget = null; return null; }
  const coll = state.editor.createDecorationsCollection([
    { range: sel, options: { className: "pixie-pending-target" } },
  ]);
  state.pendingTarget = { file: state.currentFile, coll };
  return state.pendingTarget;
}

// 全アシスタントメッセージに付く汎用トリガー。本文を左エディタへ挿入/置換する。
function addInsertAction(el, text, target) {
  const actions = document.createElement("div");
  actions.className = "apply-actions";
  const btn = document.createElement("button");
  btn.className = "insert-btn";
  btn.textContent = "▶ エディタへ反映";
  btn.title = "このメッセージの提案を差分プレビューで確認してから反映する";
  btn.addEventListener("click", () => reflectViaDiff(extractProposed(text), target));
  actions.appendChild(btn);
  el.appendChild(actions);
  scrollMessages();
}

// ```apply ブロックを抽出して「反映」ボタンを付ける。付けたら true。
function renderApplyBlock(el, text, target) {
  const matches = [...text.matchAll(/```apply\s*\n([\s\S]*?)```/g)];
  if (!matches.length) return false;
  const replacement = matches[matches.length - 1][1].replace(/\n$/, "");

  // 本文中の apply フェンスは重複表示になるので置き換える
  el.querySelector(".body").textContent =
    text.replace(/```apply\s*\n[\s\S]*?```/g, "📝 修正案（下のボックス参照）");

  const box = document.createElement("div");
  box.className = "apply-box";
  box.textContent = replacement;
  const actions = document.createElement("div");
  actions.className = "apply-actions";
  const btn = document.createElement("button");
  btn.className = "apply-btn";
  btn.textContent = "▶ 差分で反映";
  btn.addEventListener("click", () => reflectViaDiff(replacement, target));
  actions.appendChild(btn);
  el.append(box, actions);
  scrollMessages();
  return true;
}

// メッセージ本文から「反映すべき提案テキスト」を取り出す。
// 優先: ```apply → 本文の大半を占める一般フェンス → ```diff を復元 → 本文そのまま。
function extractProposed(text) {
  const apply = [...text.matchAll(/```apply\s*\n([\s\S]*?)```/g)];
  if (apply.length) return apply[apply.length - 1][1].replace(/\n$/, "");
  // 「修正版はこちら: ```...```」のように、フェンスが実質メッセージ全体である場合のみ
  // 中身を提案として採用する。長い文書に埋め込まれた小さなコード片を拾うと
  // 文書全体が失われるため、占有率が低いフェンスは無視して本文全体を使う。
  const fence = [...text.matchAll(/```(?!diff\b|search\b|replace\b)[a-zA-Z]*\s*\n([\s\S]*?)```/g)];
  if (fence.length) {
    const last = fence[fence.length - 1][1].replace(/\n$/, "");
    if (last.length >= text.trim().length * 0.6) return last;
  }
  const diff = [...text.matchAll(/```diff\s*\n([\s\S]*?)```/g)];
  if (diff.length) {
    const last = diff[diff.length - 1][1];
    if (last.length >= text.trim().length * 0.6) return diffToAfter(last);
  }
  return text.trim();
}

// モデルが万一 unified diff を返した場合のベストエフォート復元（修正後テキスト）。
function diffToAfter(block) {
  return block.split("\n")
    .filter((l) => !/^(-|@@|---|\+\+\+)/.test(l))          // 削除行・ヘッダを落とす
    .map((l) => (l.startsWith("+") || l.startsWith(" ") ? l.slice(1) : l))
    .join("\n").replace(/\n$/, "");
}

// 反映の入口：差分プレビュー（現在 vs 提案）を開き、確認後に適用する。
function reflectViaDiff(proposed, target) {
  const range = resolveTargetRange(target);
  const base = state.editor.getModel().getValueInRange(range);
  openDiffPreview(base, proposed, (finalText) => {
    state.editor.executeEdits("pixie-apply", [{ range, text: finalText, forceMoveMarkers: true }]);
    if (target?.coll) target.coll.clear();
    state.editor.focus();  // ダーティ化は onDidChangeModelContent → refreshDirty が拾う
  });
}

// 反映先の範囲：送信時に選択があればその範囲、無ければ全文。
function resolveTargetRange(target) {
  const model = state.editor.getModel();
  if (target?.coll && target.file === state.currentFile) {
    const r = target.coll.getRange(0);
    if (r) return r;
  }
  return model.getFullModelRange();
}

// --- 差分プレビュー オーバーレイ（Monaco DiffEditor）---
let diffEditor = null;
let diffApplyFn = null;

function openDiffPreview(base, proposed, onApply, label) {
  const m = state.monaco;
  $("diff-label").textContent = label || "差分プレビュー：左＝現在 ／ 右＝提案（右は編集して調整可）";
  $("diff-overlay").classList.remove("hidden");
  if (!diffEditor) {
    diffEditor = m.editor.createDiffEditor($("diff-editor"), {
      theme: "vs-dark", automaticLayout: true, renderSideBySide: true,
      originalEditable: false, readOnly: false,
      minimap: { enabled: false }, wordWrap: "on", fontSize: 14,
    });
  }
  const original = m.editor.createModel(base, "markdown");
  const modified = m.editor.createModel(proposed, "markdown");
  diffEditor.setModel({ original, modified });
  diffApplyFn = () => {
    const finalText = diffEditor.getModel().modified.getValue();
    closeDiffPreview();
    onApply(finalText);
  };
  diffEditor.focus();
}

function closeDiffPreview() {
  $("diff-overlay").classList.add("hidden");
  diffApplyFn = null;
  if (diffEditor) {
    const models = diffEditor.getModel();
    diffEditor.setModel(null);
    if (models) { models.original.dispose(); models.modified.dispose(); }
  }
}

// エージェントのツール実行ステータスを本文の上のログ枠に積む
function addToolStatus(el, text) {
  let log = el.querySelector(".tool-log");
  if (!log) {
    log = document.createElement("div");
    log.className = "tool-log";
    el.insertBefore(log, el.querySelector(".body"));
  }
  const line = document.createElement("div");
  line.className = "tool-status";
  line.textContent = text;
  log.appendChild(line);
  scrollMessages();
}

function addMessage(role, text) {
  const el = document.createElement("div");
  el.className = "msg " + role;
  const body = document.createElement("div");
  body.className = "body";
  // 自分の発言は打った通りに見せる。整形するのは AI の返信だけ。
  if (role === "assistant") renderInto(body, text);
  else renderPlain(body, text);
  el.appendChild(body);
  $("messages").appendChild(el);
  scrollMessages();
  return el;
}
function scrollMessages() { const m = $("messages"); m.scrollTop = m.scrollHeight; }
function escapeHtml(s) { return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])); }

// ---- UI バインド ------------------------------------------------------------
function bindUI() {
  $("save-btn").addEventListener("click", () => saveFile());  // MouseEvent を opts に渡さない
  $("note-btn").addEventListener("click", addNote);
  $("preview-btn").addEventListener("click", togglePreview);
  $("chat-clear-btn").addEventListener("click", clearHistory);
  $("send-btn").addEventListener("click", () => (state.streaming ? cancelChat() : sendChat()));
  $("copilot-open-btn").addEventListener("click", openCopilot);
  $("copilot-import-btn").addEventListener("click", importCopilotChat);
  $("chat-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendChat(); }
  });
  $("file-search").addEventListener("input", (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => runSearch(e.target.value), 250);
  });
  // ファイル操作
  $("new-file-btn").addEventListener("click", () => createEntry("file"));
  $("new-folder-btn").addEventListener("click", () => createEntry("dir"));
  $("web2md-btn").addEventListener("click", importUrlAsMarkdown);
  document.addEventListener("click", closeFsMenu);
  setupRootDrop();
  // 関連ファイル参照
  setupRefDrop();
  $("ref-add-btn").addEventListener("click", openPickModal);
  $("pick-cancel").addEventListener("click", closePickModal);
  $("pick-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); browsePick($("pick-input").value.trim()); }
  });
  $("pick-modal").addEventListener("click", (e) => {
    if (e.target === $("pick-modal")) closePickModal();  // 背景クリックで閉じる
  });
  // 設定（⚙️）
  $("settings-btn").addEventListener("click", openSettingsModal);
  $("settings-close").addEventListener("click", closeSettingsModal);
  $("settings-copilot-open").addEventListener("click", openCopilotFromSettings);
  $("settings-modal").addEventListener("click", (e) => {
    if (e.target === $("settings-modal")) closeSettingsModal();
  });
  // 保存に失敗したら UI を実際の状態へ戻す（設定できたように見せない）
  $("settings-copilot").addEventListener("change", async (e) => {
    try {
      await saveSettings({ copilot_enabled: e.target.checked });
    } catch (err) {
      alert("⚠️ 設定を保存できません: " + err.message);
      e.target.checked = state.copilotEnabled;
    }
  });
  $("settings-model").addEventListener("change", async (e) => {
    if (!e.target.value) return;
    try {
      await saveSettings({ chat_model: e.target.value });
    } catch (err) {
      alert("⚠️ 設定を保存できません: " + err.message);
      await loadModelOptions();
    }
  });
  // 保存先ルートの切り替えダイアログ
  $("root-btn").addEventListener("click", openRootModal);
  $("root-cancel").addEventListener("click", closeRootModal);
  $("root-ok").addEventListener("click", applyRootChange);
  $("root-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); browseDirs($("root-input").value.trim()); }
  });
  $("root-modal").addEventListener("click", (e) => {
    if (e.target === $("root-modal")) closeRootModal();  // 背景クリックで閉じる
  });
  // 差分プレビューの確定/キャンセル（Esc でもキャンセル）
  $("diff-apply").addEventListener("click", () => { if (diffApplyFn) diffApplyFn(); });
  $("diff-cancel").addEventListener("click", closeDiffPreview);
  window.addEventListener("keydown", (e) => {
    // Ctrl/Cmd+S はエディタ外（チャット入力・ツリー・モーダル）でも保存にする。
    // エディタ内は Monaco の addCommand が先に拾うのでここには来ない。
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "s") {
      e.preventDefault();  // ブラウザの「ページを保存」を止める
      saveFile();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "p") {
      e.preventDefault();
      togglePreview();
      return;
    }
    if (e.key === "Escape" && !$("root-modal").classList.contains("hidden")) closeRootModal();
    else if (e.key === "Escape" && !$("pick-modal").classList.contains("hidden")) closePickModal();
    else if (e.key === "Escape" && !$("settings-modal").classList.contains("hidden")) closeSettingsModal();
    else if (e.key === "Escape" && !$("diff-overlay").classList.contains("hidden")) closeDiffPreview();
  });

  // 別アプリへ切り替えた時点で保存しておく（デバウンス待ちのまま放置させない）
  window.addEventListener("blur", () => { flushAutosave(); });

  // 未保存のままタブを閉じる経路を塞ぐ。自動保存が効いていれば通常ここは発火しないが、
  // 保存に失敗したまま閉じようとした場合の最後の砦として残す。
  window.addEventListener("beforeunload", (e) => {
    if (!state.dirty) return;
    e.preventDefault();
    e.returnValue = "";  // 一部ブラウザは returnValue を見る
  });

  setupDivider();

  // E2E テスト用の内部フック（module スコープのため明示的に公開）
  window.__pixie = {
    state, extractEdits, extractProposed, reflectViaPatch, reflectViaDiff, openDiffPreview,
    splitThink, moveIntoDir, moveEntry,
    saveFile, openFile, refreshDirty, renderSaveState, scheduleAutosave, flushAutosave,
    loadHistory, saveHistory, clearHistory, AUTOSAVE_DELAY_MS,
    addMessage, renderPatchAction, togglePreview, isPreviewOpen, renderPreview,
  };
}

function setupDivider() {
  const divider = $("divider");
  const left = $("left-pane");
  let dragging = false;
  divider.addEventListener("mousedown", () => { dragging = true; document.body.style.cursor = "col-resize"; });
  window.addEventListener("mouseup", () => { dragging = false; document.body.style.cursor = ""; });
  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const total = $("split").clientWidth;
    const w = Math.max(320, Math.min(e.clientX, total - 320));
    left.style.flex = `0 0 ${w}px`;
    state.editor.layout();
  });
}
