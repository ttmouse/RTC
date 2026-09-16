import { Crepe, CrepeFeature } from '@milkdown/crepe';
import { getMarkdown } from '@milkdown/kit/utils';
import { extractFrontMatter, patchMarkdownBlocks } from './markdownBlockPatch.js';
import './theme/common/style.css';
import './theme/frame/style.css';
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

let crepe = null;
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

async function loadSelectedSession() {
  if (switchingSession) return;
  switchingSession = true;
  renderSessionTitle();
  renderMenu();
  try {
    await loadBoard(true);
    // Milkdown 的文档值是初始化参数；切换场次时按 xiaoer-omia 的方式重挂编辑器，
    // 不在同一个实例里强行替换文档，避免点击后仍显示旧文档或出现空白。
    if (crepe) {
      await crepe.destroy();
      crepe = null;
      editorEl.innerHTML = '';
    }
    await initEditor();
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
  // 编辑器解析完原文后自己会 dispatch 一次变更（比如补上末尾的段落），那不是用户在改，
  // 所以拿到基线之前的序列化一律不触发保存。
  editorReady = false;
  crepe = new Crepe({
    root: editorEl,
    // front matter 编辑器不认（它会把 --- 当成分割线、把字段当正文，存回去就多出一份），
    // 所以只把正文交给编辑器，front matter 由保存时的 patch 从原文里原样接回。
    defaultValue: extractFrontMatter(doc).body || '',
    featureConfigs: { [CrepeFeature.Placeholder]: { text: '开始记录会议内容…' } },
  });
  crepe.on((listener) => listener.markdownUpdated((_ctx, markdown) => {
    doc = markdown;
    if (!editorReady) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void saveDoc(markdown), 400);
  }));
  await crepe.create();
  // 编辑器就绪后的写法 = 同一份文档的另一种排版，这就是分块保真要的基线。
  doc = crepe.editor.action(getMarkdown());
  baselineDoc = doc;
  editorReady = true;
  if (seedDocument) {
    // 这份正文是刚由外部分析结果整理出来的，磁盘上还没有对应原文，只能整篇落盘。
    seedDocument = false;
    rawDoc = doc;
    await saveDoc(doc, { force: true });
  }
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
  }, 2000);
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
