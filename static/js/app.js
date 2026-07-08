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

// ---- ファイル一覧 -----------------------------------------------------------
async function loadFileList() {
  const { files } = await (await fetch("/api/files")).json();
  const ul = $("file-list");
  ul.innerHTML = "";
  for (const f of files) {
    const li = document.createElement("li");
    li.dataset.path = f.path;
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.title = "チャットのコンテキストに含める";
    cb.addEventListener("click", (e) => e.stopPropagation());
    const name = document.createElement("span");
    name.className = "fname";
    name.textContent = f.path;
    li.append(cb, name);
    li.addEventListener("click", () => openFile(f.path));
    ul.appendChild(li);
  }
}

async function openFile(path) {
  if (state.dirty && !confirm("未保存の変更があります。破棄して開きますか？")) return;
  const r = await (await fetch("/api/file?path=" + encodeURIComponent(path))).json();
  state.currentFile = path;
  state.editor.setValue(r.content);
  setDirty(false);
  $("current-file").textContent = path;
  document.querySelectorAll("#file-list li").forEach((li) =>
    li.classList.toggle("active", li.dataset.path === path));
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
  document.querySelectorAll("#file-list li").forEach((li) =>
    li.classList.toggle("active", li.dataset.path === state.currentFile));
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
  const files = [];
  document.querySelectorAll("#file-list li").forEach((li) => {
    const cb = li.querySelector("input[type=checkbox]");
    if (cb.checked) files.push(li.dataset.path);
  });
  return files;
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
  state.streaming = true;

  let full = "";
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
          if (ev.t) { full += ev.t; assistantEl.querySelector(".body").textContent = full; scrollMessages(); }
          if (ev.s) addToolStatus(assistantEl, ev.s);  // ツール実行ログ（本文・履歴には含めない）
        } catch {}
      }
    }
  } catch (e) {
    full += "\n\n> ⚠️ 接続エラー: " + e.message;
    assistantEl.querySelector(".body").textContent = full;
  }
  state.streaming = false;

  state.history.push({ role: "user", content: message });
  state.history.push({ role: "assistant", content: full });
  renderApplyBlock(assistantEl, full, applyTarget);
  if (applyTarget && !assistantEl.querySelector(".apply-box")) applyTarget.coll.clear();
}

// 送信時の選択範囲をデコレーションとして記録。以降の編集に追随する。
function trackApplyTarget() {
  const sel = state.editor.getSelection();
  if (!sel || sel.isEmpty()) return null;
  const coll = state.editor.createDecorationsCollection([
    { range: sel, options: { className: "pixie-pending-target" } },
  ]);
  return { file: state.currentFile, coll };
}

// ```apply ブロックを抽出して「反映」ボタンを付ける
function renderApplyBlock(el, text, target) {
  const matches = [...text.matchAll(/```apply\s*\n([\s\S]*?)```/g)];
  if (!matches.length) return;
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
  btn.textContent = "▶ 選択範囲へ反映";
  btn.addEventListener("click", () => applyToEditor(replacement, target));
  actions.appendChild(btn);
  el.append(box, actions);
  scrollMessages();
}

// 反映：送信時に記録した範囲を優先して置換。無ければ現在の選択/カーソル位置。
function applyToEditor(text, target) {
  let range = state.editor.getSelection();
  if (target && target.coll) {
    const tracked = target.coll.getRange(0);
    if (tracked && target.file === state.currentFile) {
      range = tracked;
    } else if (target.file !== state.currentFile &&
               !confirm(`送信時と違うファイル（${state.currentFile ?? "未保存"}）が開いています。現在のカーソル位置に反映しますか？`)) {
      return;
    }
  }
  state.editor.executeEdits("pixie-apply", [{ range, text, forceMoveMarkers: true }]);
  if (target && target.coll) target.coll.clear();
  state.editor.focus();
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
  setupDivider();
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
