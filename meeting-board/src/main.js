import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { BoardEditor } from './BoardEditor.jsx';
import { extractFrontMatter, patchMarkdownBlocks } from './markdownBlockPatch.js';
import { resolveExternalFileChange, sourceContentFingerprint } from './lib/externalRefresh.js';
import './theme/common/style.css';
import './theme/frame/style.css';
import './themes/crepe-paper.css';
import './themes/markdown-fidelity.css';
import './style.css';

// 白板是外部人工智能的文档展示层：应用不调用人工智能，只把结果整理成可编辑 Markdown。
const API = location.protocol === 'http:' || location.protocol === 'https:' ? '' : 'http://127.0.0.1:8931';
const api = (path) => API + path;
const $ = (id) => document.getElementById(id);
// 编辑器、状态条、提示条都是 init() 注入到 #app 里的，模块顶层这个时刻 #app 还是空的，
// 在这里取会拿到 null，后面任何一次 statusEl.textContent 都会抛错、整页白掉。
// 所以先占位，等 init() 把结构写进去之后再取。
let editorEl = null;
let statusEl = null;
let toastEl = null;

let editorRoot = null;
let editorGeneration = 0;
let doc = '';           // 编辑器里的当前内容（用的是编辑器自己的写法）
let rawDoc = '';        // 磁盘上的原文：保存时靠它把没改过的块原样填回去
let baselineDoc = null; // 编辑器就绪时的序列化；null = 还没取到基线
let editorReady = false;
let def = { background: '', expectedOutput: '', roles: '', boundary: '' };
let analysis = null;
let sessions = [];
let selectedSessionId = '';
let pollTimer = null;
let saveTimer = null;
let seedDocument = false;
let switchingSession = false;
let refreshingDocument = false;
let lastConflictFingerprint = '';

function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastEl._t);
  toastEl._t = setTimeout(() => toastEl.classList.remove('show'), 2500);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function readForm() {
  return {
    background: $('fBg').value.trim(),
    expectedOutput: $('fOut').value.trim(),
    roles: $('fRoles').value.trim(),
    boundary: $('fBound').value.trim(),
  };
}

function fillForm() {
  $('fBg').value = def.background || '';
  $('fOut').value = def.expectedOutput || '';
  $('fRoles').value = def.roles || '';
  $('fBound').value = def.boundary || '';
}

// 外部分析结果第一次进入某场会议时，确定性地转换成文档正文。
// 之后正文由用户直接编辑，不再由应用自动覆盖。
function analysisToMarkdown(value) {
  if (!value) return '';
  const list = (title, items) => Array.isArray(items) && items.length ? `\n## ${title}\n\n${items.map((item) => `- ${typeof item === 'string' ? item : JSON.stringify(item)}`).join('\n')}\n` : '';
  const s = value.alignmentStatus || {};
  return `# ${value.title || value.currentTopic || '会议记录'}\n\n## 当前话题\n\n${value.currentTopic || '待补充'}\n${list('已形成结论', value.decisionsReached)}${list('待决问题', value.openQuestions)}${list('行动项', value.actionItems)}\n## 对齐状态\n\n- 背景覆盖：${s.backgroundCovered ? '是' : '否'}\n- 讨论边界遵守：${s.boundaryRespected ? '是' : '否'}\n- 角色分工清晰：${s.roleClarity ? '是' : '否'}\n- 预期产出进展：${s.expectedOutputProgress || '待补充'}\n\n${value.summary ? `> ${value.summary}\n` : ''}`.trim();
}

async function fetchSessions() {
  const date = new Date().toISOString().slice(0, 10);
  const response = await fetch(api(`/api/meeting-board/sessions?date=${date}`), { cache: 'no-store' });
  const data = await response.json();
  if (!response.ok || !data?.ok) throw new Error(data?.error || `HTTP ${response.status}`);
  return data.sessions || [];
}

async function fetchBoard() {
  const suffix = selectedSessionId ? `?sessionId=${encodeURIComponent(selectedSessionId)}` : '';
  const response = await fetch(api(`/api/meeting-board/definition${suffix}`), { cache: 'no-store' });
  const data = await response.json();
  if (!response.ok || !data?.ok) throw new Error(data?.error || `HTTP ${response.status}`);
  return data;
}

function applyBoard(data, initial = false) {
  def = data.definition || def;
  analysis = data.analysis || null;
  const savedDoc = typeof data.document === 'string' ? data.document : '';
  const generated = !savedDoc.trim() && analysis ? analysisToMarkdown(analysis) : '';
  doc = savedDoc || generated;
  rawDoc = savedDoc;
  baselineDoc = null; // 换了一份文档，旧基线作废，等编辑器重挂完重新取
  seedDocument = !!generated;
  if (initial) fillForm();
}

// 顶部不再常驻状态：「已连接 · 文档自动保存」这类字既是噪音，也让人意识到软件的存在。
// 只有真的读不到文件时才冒出来一行，避免把失败静默掉。
function showStatus(message) { statusEl.textContent = message; statusEl.hidden = false; }
function hideStatus() { statusEl.hidden = true; }

async function loadBoard(initial = false) {
  try {
    applyBoard(await fetchBoard(), initial);
    hideStatus();
    return true;
  } catch (error) {
    showStatus('暂时无法读取白板');
    if (initial) toast('白板文件暂时无法读取');
    console.warn('[board] load:', error);
    return false;
  }
}

// 外部（外部 AI / 命令行）改完白板后，面板得自己变回来——不能要求用户切一下会议、或重开窗口。
// 判定用 Omia 那套三分支（见 lib/externalRefresh.js）：指纹一样就不动，变了且本地干净就重读，
// 变了但本地有改动就不覆盖。没有第一分支，这个 2 秒轮询会把正在看的文档每轮重挂一次；
// 没有第三分支，用户正在输字的时候会被外部写入截断。
async function refreshDocument() {
  if (switchingSession || refreshingDocument || !editorReady) return;
  refreshingDocument = true;
  try {
    const board = await fetchBoard();
    const decision = resolveExternalFileChange({
      dirty: doc !== rawDoc,
      baseFingerprint: sourceContentFingerprint(rawDoc),
      diskFingerprint: sourceContentFingerprint(typeof board.document === 'string' ? board.document : ''),
    });
    if (decision.outcome === 'reload') {
      applyBoard(board);
      lastConflictFingerprint = '';
      await remountEditor();
      hideStatus();
      toast('白板已更新');
    } else if (decision.outcome === 'conflict') {
      // 同一个冲突不反复弹：轮询是 2 秒一次，不挡一下会一直刷屏。
      const key = sourceContentFingerprint(typeof board.document === 'string' ? board.document : '');
      if (key !== lastConflictFingerprint) {
        lastConflictFingerprint = key;
        showStatus('白板在外部更新了；你这边有还没保存的改动，先保留你的版本');
      }
    } else {
      // 读到就能读，上次的冲突提示自然过期。
      hideStatus();
    }
  } catch (error) {
    console.warn('[board] poll document:', error);
  } finally { refreshingDocument = false; }
}

// 写盘前先过一道「分块保真」：用户没碰过的块原样用磁盘上的原文，只有真改过的块才用编辑器的写法。
// 还没拿到基线时（编辑器刚重挂、或这份内容是刚生成出来的）没有可对比的参照，只能整篇写。
async function saveDoc(text, { force = false } = {}) {
  const payload = baselineDoc === null
    ? text
    : patchMarkdownBlocks({ original: rawDoc, baseline: baselineDoc, edited: text }).markdown;
  // 编辑器自己吐出来的归一化写法也算「没改」——这种时候没必要去写一次盘。
  if (!force && payload === rawDoc) return;
  try {
    const suffix = selectedSessionId ? `?sessionId=${encodeURIComponent(selectedSessionId)}` : '';
    const response = await fetch(api(`/api/meeting-board/document${suffix}`), {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ document: payload }),
    });
    // 只有真的写进去了才更新「磁盘原文」；否则下次会拿一份并不存在的底本去回填。
    if (response.ok) rawDoc = payload;
  } catch (error) { console.warn('[board] save document:', error); }
}

async function saveDef(value) {
  try {
    const suffix = selectedSessionId ? `?sessionId=${encodeURIComponent(selectedSessionId)}` : '';
    const response = await fetch(api(`/api/meeting-board/definition${suffix}`), {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value),
    });
    return response.ok && (await response.json()).ok;
  } catch (error) { return false; }
}

function currentSession() {
  return sessions.find((session) => session.id === selectedSessionId) || null;
}

// 顶部只留一行「当前会议名」。白板是要投给会议室里所有人看的：常驻的标题、状态、
// 按钮和横排场次卡片会把文档挤下去，也让人一直意识到「这是某个软件的窗口」。
function renderSessionTitle() {
  const session = currentSession();
  $('sessionName').textContent = session ? session.title : '今天还没有识别出的会议';
}

function renderMenu() {
  const menu = $('sessionMenu');
  menu.innerHTML = sessions.length
    ? sessions.map((session) => `<button class="menu-item ${session.id === selectedSessionId ? 'active' : ''}" data-session-id="${escapeHtml(session.id)}"><span>${escapeHtml(session.title)}</span><span class="menu-meta">${session.count} 条记录 · ${session.hasDocument ? '可编辑' : '待整理'}</span></button>`).join('')
    : '<div class="menu-empty">今天还没有识别出的会议</div>';
  menu.querySelectorAll('.menu-item').forEach((button) => {
    button.onclick = () => { closeMenu(); selectedSessionId = button.dataset.sessionId; void loadSelectedSession(); };
  });
}

// 下拉要能纯键盘用：展开后光标落在当前会议，上下键逐行移，回车即选中并收起。
function menuItems() {
  return Array.from($('sessionMenu').querySelectorAll('.menu-item'));
}

function focusMenuItem(target) {
  const items = menuItems();
  if (!items.length) return;
  const index = typeof target === 'number' ? Math.max(0, Math.min(items.length - 1, target)) : items.findIndex((item) => item.classList.contains('active'));
  items[index === -1 ? 0 : index].focus();
}

function moveMenuFocus(step) {
  const items = menuItems();
  if (!items.length) return;
  const current = items.indexOf(document.activeElement);
  focusMenuItem(current === -1 ? 0 : current + step);
}

// Milkdown 的文档值是初始化参数；换文档只能整只换掉，不能在一个实例里强行替换文档，
// 不然点击后仍显示旧文档或出现空白（做法同 xiaoer-omia）。
async function remountEditor() {
  if (editorRoot) {
    editorRoot.unmount();
    editorRoot = null;
    editorEl.innerHTML = '';
    // 上游编辑器的清理会异步销毁 Milkdown；等它完成后再复用同一个宿主节点，
    // 否则旧实例可能在新实例挂载后继续清空 DOM，表现就是切换后白板空白。
    await new Promise((resolve) => setTimeout(resolve, 180));
  }
  await initEditor();
}

async function loadSelectedSession() {
  if (switchingSession) return;
  switchingSession = true;
  clearTimeout(saveTimer);
  renderSessionTitle();
  renderMenu();
  try {
    await loadBoard(true);
    await remountEditor();
    toast('已切换会议文档');
  } finally { switchingSession = false; }
}

// 场次列表在每次展开下拉时才去拉一次，所以不再需要「重新整理场次」这个按钮。
// 这里只更新列表，不顺带重新加载文档——否则用户一展开下拉，正在看的内容就被刷掉了。
async function refreshSessions() {
  try {
    const latest = await fetchSessions();
    if (JSON.stringify(latest) === JSON.stringify(sessions)) return;
    sessions = latest;
    if (selectedSessionId && !sessions.some((session) => session.id === selectedSessionId)) selectedSessionId = sessions.at(-1)?.id || '';
    if (!selectedSessionId && sessions.length) selectedSessionId = sessions.at(-1).id;
    renderSessionTitle();
    renderMenu();
    if (!$('sessionMenu').hidden) focusMenuItem(menuItems().findIndex((item) => item.classList.contains('active')));
  } catch (error) { console.warn('[board] refresh sessions:', error); }
}

function openMenu() {
  renderMenu();
  $('sessionMenu').hidden = false;
  $('sessionBtn').setAttribute('aria-expanded', 'true');
  focusMenuItem(menuItems().findIndex((item) => item.classList.contains('active')));
  void refreshSessions();
}

function closeMenu() {
  $('sessionMenu').hidden = true;
  $('sessionBtn').setAttribute('aria-expanded', 'false');
}

async function initEditor() {
  // 上游编辑器是非受控组件：初始内容只在挂载时读取，切换会议时由调用方卸载并重建。
  editorReady = false;
  const generation = ++editorGeneration;
  const sessionAtInit = selectedSessionId;
  const initialValue = extractFrontMatter(doc).body || '';
  // 上游编辑器只接收正文，Front Matter 仍由外层分块保存逻辑负责回填。
  doc = initialValue;
  editorRoot = createRoot(editorEl);
  await new Promise((resolve, reject) => {
    editorRoot.render(createElement(BoardEditor, {
      value: initialValue,
      onChange: (markdown) => {
        if (generation !== editorGeneration || sessionAtInit !== selectedSessionId) return;
        doc = markdown;
        if (!editorReady) return;
        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
          if (generation === editorGeneration && sessionAtInit === selectedSessionId) void saveDoc(markdown);
        }, 400);
      },
      onReady: () => {
        if (generation !== editorGeneration || sessionAtInit !== selectedSessionId) return resolve();
        // React 编辑器就绪后会给出已归一化的 Markdown；当前值作为分块保真的基线。
        baselineDoc = doc;
        editorReady = true;
        if (seedDocument) {
          seedDocument = false;
          rawDoc = doc;
          void saveDoc(doc, { force: true });
        }
        resolve();
      },
      onError: (reason) => {
        if (generation !== editorGeneration) return resolve();
        showStatus(reason || '编辑器初始化失败');
        reject(new Error(reason || '编辑器初始化失败'));
      },
    }));
  });
}

async function init() {
  document.getElementById('app').innerHTML = `
    <div class="board-wrap">
      <div class="board-bar">
        <button class="board-session" id="sessionBtn" aria-haspopup="true" aria-expanded="false">
          <span id="sessionName">加载中…</span>
          <svg class="board-caret" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>
        </button>
        <span class="board-status" id="status" hidden></span>
        <div class="board-menu" id="sessionMenu" hidden></div>
      </div>
      <div class="editor-wrap"><div id="editor"></div></div>
      <!-- 会议定义的入口暂时收起（顶部只留会议名）。字段和保存动作都留着，接回入口时只需再摆一个按钮；
           删掉这段会让 fillForm / readForm 取不到元素而报错。 -->
      <div class="def-panel" id="defPanel">
        <div class="def-desc">会议定义也是当前文档的一部分，可以随时修改。</div>
        <div class="def-grid">
          <div><div class="def-label">讨论背景</div><textarea id="fBg" rows="2"></textarea></div>
          <div><div class="def-label">预期产出</div><textarea id="fOut" rows="2"></textarea></div>
          <div><div class="def-label">参与角色</div><textarea id="fRoles" rows="2"></textarea></div>
          <div><div class="def-label">讨论边界</div><textarea id="fBound" rows="2"></textarea></div>
        </div>
        <div class="def-actions"><button class="btn primary" id="saveDefBtn">保存定义</button></div>
      </div>
    </div>
    <div class="toast" id="toast"></div>`;
  editorEl = $('editor');
  statusEl = $('status');
  toastEl = $('toast');
  sessions = await fetchSessions();
  selectedSessionId = sessions.at(-1)?.id || '';
  renderSessionTitle();
  renderMenu();
  await loadBoard(true);
  await initEditor();
  $('sessionBtn').onclick = (event) => { event.stopPropagation(); if ($('sessionMenu').hidden) openMenu(); else closeMenu(); };
  $('saveDefBtn').onclick = async () => toast((await saveDef(readForm())) ? '定义已保存' : '保存失败');
  document.addEventListener('click', (event) => { if (!event.target.closest('.board-bar')) closeMenu(); });
  pollTimer = setInterval(async () => {
    try {
      const latest = await fetchSessions();
      if (JSON.stringify(latest) !== JSON.stringify(sessions)) {
        sessions = latest;
        if (selectedSessionId && !sessions.some((session) => session.id === selectedSessionId)) selectedSessionId = sessions.at(-1)?.id || '';
        renderSessionTitle();
        renderMenu();
      }
    } catch (error) { console.warn('[board] poll sessions:', error); }
    await refreshDocument();
  }, 2000);
  // 窗口重新拿回焦点时也重读一次（做法同 xiaoer-omia）。切窗口回来就该看到最新的，
  // 而不是再等一个轮询周期。
  window.addEventListener('focus', () => { void refreshDocument(); });
  document.addEventListener('keydown', (event) => {
    if (!$('sessionMenu').hidden) {
      if (event.key === 'ArrowDown') { event.preventDefault(); moveMenuFocus(1); return; }
      if (event.key === 'ArrowUp') { event.preventDefault(); moveMenuFocus(-1); return; }
      if (event.key === 'Home') { event.preventDefault(); focusMenuItem(0); return; }
      if (event.key === 'End') { event.preventDefault(); focusMenuItem(menuItems().length - 1); return; }
      // 下拉展开时 Esc 先收起下拉（回车选中的是按钮本身的默认行为，不用额外处理），
      // 否则这个键会直接把白板窗口关掉。
      if (event.key === 'Escape') { closeMenu(); $('sessionBtn').focus(); return; }
    }
    if (event.key === 'Escape') window.close();
  });
}

window.addEventListener('beforeunload', () => { clearInterval(pollTimer); clearTimeout(saveTimer); });
init().catch((error) => { console.error(error); if (statusEl) showStatus('初始化失败'); });
