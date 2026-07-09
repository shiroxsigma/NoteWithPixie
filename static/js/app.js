// NoteWithPixie フロントエンド本体
const $ = (id) => document.getElementById(id);
const state = {
  editor: null,
  monaco: null,
  currentFile: null,
  dirty: false,
  noteDecorations: null,   // Monaco decorations collection
  notes: [],               // [{line, text}]
  history: [],             // chat history [{role, content}]
  streaming: false,
  pendingTarget: null,     // 反映先として追跡中の選択範囲（1つだけ）
  fsEntries: [],           // /api/files の結果 [{path, type, size?}]
  collapsedDirs: new Set(),// 折りたたみ中のフォルダ
  checkedFiles: new Set(), // コンテキストに含めるファイル（再描画をまたいで保持）
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

  state.editor.onDidChangeModelContent(() => setDirty(true));
  state.editor.onDidChangeCursorSelection(updateSelectionChip);

  // Ctrl+S 保存
  state.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, saveFile);
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
  await loadFileList();
  bindUI();
}

// ---- モデル情報 -------------------------------------------------------------
async function loadModel() {
  try {
    const r = await (await fetch("/api/models")).json();
    $("model-name").textContent = r.current || "?";
  } catch { $("model-name").textContent = "未接続"; }
}

// ---- ファイル一覧（ツリー表示 + ファイル操作） --------------------------------
async function loadFileList() {
  const { files } = await (await fetch("/api/files")).json();
  state.fsEntries = files;
  // 消えたファイルはチェック集合からも掃除する
  const alive = new Set(files.filter((f) => f.type === "file").map((f) => f.path));
  for (const p of [...state.checkedFiles]) if (!alive.has(p)) state.checkedFiles.delete(p);
  renderFileTree();
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
  if (state.dirty && !confirm("未保存の変更があります。破棄して開きますか？")) return;
  const r = await (await fetch("/api/file?path=" + encodeURIComponent(path))).json();
  state.currentFile = path;
  state.editor.setValue(r.content);
  setDirty(false);
  $("current-file").textContent = path;
  renderFileTree();
  await loadNotes();
}

async function saveFile() {
  if (!state.currentFile) {
    const name = prompt("保存するファイル名（例: note.md）");
    if (!name) return;
    state.currentFile = name;
    $("current-file").textContent = name;
  }
  await fetch("/api/file", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: state.currentFile, content: state.editor.getValue() }),
  });
  await persistNotes();  // 本文編集で移動した付箋位置も保存に反映する
  setDirty(false);
  $("save-state").textContent = "保存済";
  setTimeout(() => ($("save-state").textContent = ""), 1500);
  await loadFileList();
}

function setDirty(v) {
  state.dirty = v;
  if (v) $("save-state").textContent = "● 未保存";
  else if ($("save-state").textContent === "● 未保存") $("save-state").textContent = "";
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
  const r = await (await fetch("/api/notes?path=" + encodeURIComponent(state.currentFile))).json();
  state.notes = r.notes || [];
  renderNotes();
}
async function persistNotes() {
  if (!state.currentFile) return;
  syncNotesFromDecorations();
  await fetch("/api/notes?path=" + encodeURIComponent(state.currentFile), {
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
  persistNotes();
}
function editNoteAt(line) {
  syncNotesFromDecorations();  // クリック行と付箋の現在位置を一致させてから照合
  const existing = state.notes.find((n) => n.line === line);
  const text = prompt("付箋メモ（空で削除）", existing ? existing.text : "");
  if (text === null) return;   // キャンセル時は変更しない
  state.notes = state.notes.filter((n) => n.line !== line);
  if (text.trim()) state.notes.push({ line, text });
  renderNotes();
  persistNotes();
}

// ---- 全文検索 ---------------------------------------------------------------
let searchTimer = null;
async function runSearch(q) {
  const box = $("search-results");
  const list = $("file-list");
  if (!q.trim()) { box.classList.add("hidden"); list.classList.remove("hidden"); return; }
  const { results } = await (await fetch("/api/search?q=" + encodeURIComponent(q))).json();
  box.innerHTML = "";
  for (const hit of results) {
    const div = document.createElement("div");
    div.className = "search-hit";
    div.innerHTML = `<span class="loc">${hit.path}:${hit.line}</span> ${escapeHtml(hit.text)}`;
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

async function sendChat() {
  if (state.streaming) return;
  const input = $("chat-input");
  const message = input.value.trim();
  if (!message) return;
  input.value = "";

  const selection = getSelection();
  const applyTarget = trackApplyTarget();  // 送信時の選択範囲を追跡（編集してもズレない）
  const contextPaths = collectContext();
  const context_files = [];
  for (const p of contextPaths) {
    const r = await (await fetch("/api/file?path=" + encodeURIComponent(p))).json();
    context_files.push({ path: p, content: r.content });
  }

  addMessage("user", message);
  const assistantEl = addMessage("assistant", "");
  const ui = beginAssistantStream(assistantEl);  // 応答待ちインジケータ + 思考ボックス
  state.streaming = true;
  $("send-btn").disabled = true;

  try {
    const resp = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, selection, context_files, history: state.history }),
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
    ui.onToken("\n\n> ⚠️ 接続エラー: " + e.message);
  }
  const visible = ui.finish();  // 思考部分を除いた本文（履歴・反映の対象）
  state.streaming = false;
  $("send-btn").disabled = false;

  state.history.push({ role: "user", content: message });
  state.history.push({ role: "assistant", content: visible });

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
      el.querySelector(".body").textContent = visible;
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
      }
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
  el.querySelector(".body").textContent =
    text.replace(/```search\s*\n[\s\S]*?```\s*\n\s*```replace\s*\n[\s\S]*?```/g, "📝 修正案（差分で確認）");
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
    setDirty(true);
    state.editor.focus();
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
// 優先: ```apply → diff以外の一般フェンス → ```diff を復元 → 本文そのまま。
function extractProposed(text) {
  const apply = [...text.matchAll(/```apply\s*\n([\s\S]*?)```/g)];
  if (apply.length) return apply[apply.length - 1][1].replace(/\n$/, "");
  const fence = [...text.matchAll(/```(?!diff\b|search\b|replace\b)[a-zA-Z]*\s*\n([\s\S]*?)```/g)];
  if (fence.length) return fence[fence.length - 1][1].replace(/\n$/, "");
  const diff = [...text.matchAll(/```diff\s*\n([\s\S]*?)```/g)];
  if (diff.length) return diffToAfter(diff[diff.length - 1][1]);
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
    setDirty(true);
    state.editor.focus();
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
  body.textContent = text;
  el.appendChild(body);
  $("messages").appendChild(el);
  scrollMessages();
  return el;
}
function scrollMessages() { const m = $("messages"); m.scrollTop = m.scrollHeight; }
function escapeHtml(s) { return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])); }

// ---- UI バインド ------------------------------------------------------------
function bindUI() {
  $("save-btn").addEventListener("click", saveFile);
  $("note-btn").addEventListener("click", addNote);
  $("send-btn").addEventListener("click", sendChat);
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
  document.addEventListener("click", closeFsMenu);
  setupRootDrop();
  // 差分プレビューの確定/キャンセル（Esc でもキャンセル）
  $("diff-apply").addEventListener("click", () => { if (diffApplyFn) diffApplyFn(); });
  $("diff-cancel").addEventListener("click", closeDiffPreview);
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("diff-overlay").classList.contains("hidden")) closeDiffPreview();
  });
  setupDivider();

  // E2E テスト用の内部フック（module スコープのため明示的に公開）
  window.__pixie = { state, extractEdits, extractProposed, reflectViaPatch, reflectViaDiff, openDiffPreview, splitThink, moveIntoDir, moveEntry };
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
