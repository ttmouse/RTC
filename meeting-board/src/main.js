import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { BoardEditor } from './BoardEditor.jsx';
import { extractFrontMatter, patchMarkdownBlocks } from './markdownBlockPatch.js';
import { resolveExternalFileChange, sourceContentFingerprint } from './lib/externalRefresh.js';
import { localDateStamp, sessionDisplayTitle, sessionMetaLabel } from './lib/sessionSearch.js';
import { makeContext, resolveTabView, resolveTabs, resolveShownTab, resolveAiContent, preliminaryChanged, TAB_RAW, TAB_AI } from './lib/preliminaryPanel.js';
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
// 阅读 / 编辑（默认阅读态，见 setReading）。重渲染入口：换模式不重建编辑器，只改一个 prop。
let reading = true;
let renderBoardEditor = null;
let readHintShown = false;
let doc = '';           // 编辑器里的当前内容（用的是编辑器自己的写法）
let rawDoc = '';        // 磁盘上的原文：保存时靠它把没改过的块原样填回去
// 磁盘上已保存的白板正文（document 字段）。和 rawDoc 分开：rawDoc 是「回填用的底本」，
// 生成出来的内容也会写进它；判断「AI 那一档的内容是哪来的」必须看真正落盘的那份。
let savedDocText = '';
let baselineDoc = null; // 编辑器就绪时的序列化；null = 还没取到基线
let editorReady = false;
let def = { background: '', expectedOutput: '', roles: '', boundary: '' };
let analysis = null;
let preliminary = null;
// 逐字稿原文：AI 还没出结果时面板显示的就是它。它由服务端现读 events 得到，
// 是只读的展示材料，不进 document、不参与保存。
let transcript = '';
// 面板当前看哪一档：'raw'（原始逐字稿）或 'ai'（AI 会议内容）。
// 用户手动切过就记住（见 selectTab）；没切过则每场按「AI 优先、没有就逐字稿」自动定。
const PANEL_TAB_KEY = 'rtc.board.panelTab';
let panelTabChosen = false; // 这一档是用户手动选的，还是自动定的
let panelTab = (() => {
  try {
    const saved = localStorage.getItem(PANEL_TAB_KEY);
    if (saved === TAB_RAW || saved === TAB_AI) { panelTabChosen = true; return saved; }
  } catch { /* 隐私模式下读不了，用默认值 */ }
  return TAB_AI;
})();
let preliminaryPending = false;
let preliminaryTriggerKey = '';
// sessions 是「今天」的权威列表：轮询它才能知道今天有没有新场次、选中的场次还在不在。
// menuSessions 是下拉里真正显示的那一份（可能是跨天检索的结果）。两者必须分开：
// 拿检索结果去判断「今天的场次变了没有」会永远判成变了。
let sessions = [];
let menuSessions = [];
// 历史场次不在 sessions 里，选中后标题和文档路径都查不到——按下拉里给的那份记一份。
const knownSessions = new Map();
let selectedSessionId = '';
// 选中的场次属于哪一天。只有它还是今天时，「场次消失了就退回最新一场」才成立；
// 否则一看历史会议就会被这个自动跟随踢回今天。
let selectedDate = localDateStamp();
let menuQuery = '';
let searchTimer = null;
let searchSeq = 0;
let pollTimer = null;
let saveTimer = null;
let seedDocument = false;
let switchingSession = false;
let refreshingDocument = false;
let lastConflictFingerprint = '';
// 宽屏（≥1000px）时会议列表是常驻侧边栏，窄屏是浮层下拉。
// 这个数只允许有一份：JS 用它决定交互，style.css 的媒体查询用它决定形态，两处必须同时改。
const WIDE_MEDIA = '(min-width: 1000px)';
const wideMedia = window.matchMedia(WIDE_MEDIA);
// 用户是否刚刚在宽屏下主动收起了侧边栏。窗口变窄再变宽时，只有它还是 false 才恢复默认展开——
// 否则用户刚收起、随手拉一下窗口宽度，列表又自己跳回来。
let sidebarCollapsed = false;

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

// 白板上只有两档：`逐字稿`（原话，只读）和 `AI 会议内容`（白板正文本身，可编辑）。
// **没有第三个笔记区**——AI 那一档的正文就是编辑器，由模型生成：本地模型先垫一版，
// 更聪明的模型（或用户自己）整篇替换。
// 「这一档此刻该显示什么」全在 lib/preliminaryPanel.js 里（纯函数，有测试），
// 这里只负责把结果塞进 DOM 和切换面板。
function renderTabs() {
  const panel = $('preliminaryPanel');
  const text = $('preliminaryText');
  const note = $('preliminaryNote');
  const tabs = $('preliminaryTabs');
  if (!panel || !text) return;

  const ctx = makeContext({
    transcript,
    document: savedDocText,
    analysisText: analysis ? analysisToMarkdown(analysis) : '',
    preliminary,
    pending: preliminaryPending,
  });
  const options = { pending: preliminaryPending };
  // 自动决定时才允许回落到另一档；用户手动点过就照他选的显示（空的 AI 档也会说话）。
  const { tab: shownTab, active: activeTab } = resolveShownTab(panelTab, ctx, { auto: !panelTabChosen });

  const rawView = resolveTabView(TAB_RAW, ctx, options);
  const aiView = resolveTabView(TAB_AI, ctx, options);
  const view = shownTab === TAB_AI ? aiView : rawView;

  // 只有逐字稿的正文进 <pre>；AI 那一档的正文归编辑器管，这里一个字都不碰它。
  text.textContent = rawView.text;
  if (note) { note.textContent = rawView.note; note.hidden = !rawView.note; }
  const aiNote = $('aiNote');
  if (aiNote) { aiNote.textContent = aiView.note; aiNote.hidden = !aiView.note; }

  panel.dataset.state = view.state;
  panel.dataset.tab = shownTab;

  // 两档各占同一块位置，切换就是换当前档——不做成上下叠两块。
  // 用 data-active 而不是 hidden：编辑器在挂载时要量布局，display:none 里会量到零高度。
  const transcriptPane = $('transcriptPane');
  const aiPane = $('aiPane');
  if (transcriptPane) transcriptPane.dataset.active = String(shownTab === TAB_RAW);
  if (aiPane) aiPane.dataset.active = String(shownTab === TAB_AI);
  // 逐字稿是识别结果，改不了；编辑/阅读开关只对 AI 那一档有意义。
  const readToggle = $('readToggle');
  if (readToggle) readToggle.hidden = shownTab !== TAB_AI;
  const localAiButton = $('localAiButton');
  if (localAiButton) {
    localAiButton.hidden = shownTab !== TAB_AI;
    localAiButton.disabled = preliminaryPending || !transcript.trim();
    localAiButton.textContent = preliminaryPending ? '本地 AI 处理中…' : '本地 AI 处理';
    localAiButton.title = transcript.trim() ? '使用本地 MiniCPM5 重新处理当前逐字稿' : '当前会议还没有逐字稿';
    localAiButton.onclick = () => { void requestPreliminary(true); };
  }

  if (tabs) {
    tabs.innerHTML = resolveTabs(ctx).map((entry) => {
      const cls = `preliminary-tab${entry.tab === activeTab ? ' active' : ''}`;
      const count = entry.count ? `<span class="preliminary-tab-count">${entry.count}</span>` : '';
      return `<button type="button" class="${cls}" data-tab="${entry.tab}" data-has-content="${entry.hasContent}" role="tab" `
        + `aria-selected="${entry.tab === activeTab}">${entry.label}${count}</button>`;
    }).join('');
    tabs.querySelectorAll('.preliminary-tab').forEach((button) => {
      button.onclick = () => selectTab(button.dataset.tab);
    });
  }
}

// 手动切档。两档共用同一块位置，切换后不需要额外滚动。
function selectTab(tab) {
  if (tab !== TAB_RAW && tab !== TAB_AI) return;
  // 点已经选中的那一档也要重画：自动模式下面板可能正显示着另一档，
  // 此时「再点它一次」是用户唯一能表达「我就要看这一档」的动作。
  panelTab = tab;
  panelTabChosen = true;
  renderTabs();
  // 手动切过就记住，下次打开白板直接落在这一档。
  try { localStorage.setItem(PANEL_TAB_KEY, tab); } catch { /* 隐私模式下写不了，不影响功能 */ }
}

function applyPreliminary(value) {
  if (!value) return;
  preliminary = value;
  preliminaryPending = false;
  renderTabs();
}

async function requestPreliminary(force = false) {
  const session = currentSession();
  if (!session || switchingSession) return;
  const key = `${session.id}:${session.count}:${session.end}`;
  if (!force && key === preliminaryTriggerKey) return;
  preliminaryTriggerKey = key;
  preliminaryPending = true;
  renderTabs();
  try {
    const response = await fetch(api(`/api/meeting-board/preliminary?sessionId=${encodeURIComponent(session.id)}${force ? '&force=1' : ''}`), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data?.ok) throw new Error(data?.error || `HTTP ${response.status}`);
    // pending 返回的可能是旧缓存，只用于保持处理中状态，不能覆盖当前面板。
    if (data.preliminary && data.status !== 'pending' && session.id === selectedSessionId) applyPreliminary(data.preliminary);
    if (data.status !== 'pending') preliminaryPending = false;
    renderTabs();
  } catch (error) {
    preliminaryPending = false;
    renderTabs();
    console.warn('[board] preliminary:', error);
  }
}

async function fetchSessions() {
  // 事件按本地日期分文件；不能用 toISOString()，否则午夜附近会读到 UTC 的另一天。
  const date = localDateStamp();
  const response = await fetch(api(`/api/meeting-board/sessions?date=${date}`), { cache: 'no-store' });
  const data = await response.json();
  if (!response.ok || !data?.ok) throw new Error(data?.error || `HTTP ${response.status}`);
  return data.sessions || [];
}

// 跨天检索：不带关键词时它给的是「最近若干场」（跨天，最新在前），也就是下拉的默认列表。
// 历史会议就是从这里进来的——/sessions 只看今天。
async function fetchSessionSearch(query) {
  const params = new URLSearchParams({ limit: '60' });
  if (query) params.set('q', query);
  const response = await fetch(api(`/api/meeting-board/search?${params}`), { cache: 'no-store' });
  const data = await response.json();
  if (!response.ok || !data?.ok) throw new Error(data?.error || `HTTP ${response.status}`);
  return data.sessions || [];
}

function rememberSessions(list) {
  list.forEach((session) => { if (session?.id) knownSessions.set(session.id, session); });
}

// 慢响应回来时输入框里可能已经是别的词了，序号对不上就丢掉——否则旧结果会盖掉新结果。
async function runSearch(query) {
  const seq = ++searchSeq;
  try {
    const list = await fetchSessionSearch(query);
    if (seq !== searchSeq) return;
    menuSessions = list;
    rememberSessions(list);
    renderMenu();
  } catch (error) {
    if (seq !== searchSeq) return;
    console.warn('[board] search:', error);
    // 检索不可用时（老服务端 / 暂时读不到）退回今天的场次，降级成改动前的行为。
    if (!query && menuSessions.length === 0) { menuSessions = sessions; renderMenu(); }
  }
}

function scheduleSearch(query) {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => void runSearch(query), 180);
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
  preliminary = data.preliminary || null;
  transcript = typeof data.transcript === 'string' ? data.transcript : '';
  preliminaryPending = false;
  savedDocText = typeof data.document === 'string' ? data.document : '';
  // AI 那一档 = 白板正文。正文还没有时，依次拿「外部分析生成的」「本地模型整理的」垫上，
  // 保证切过去就有东西看，而不是一片空白。
  const ai = resolveAiContent({
    document: savedDocText,
    analysisText: analysis ? analysisToMarkdown(analysis) : '',
    preliminary,
  });
  doc = ai.text;
  // 生成出来的那版不是磁盘原文，别让「本地干净」的判定把它当成用户改动。
  rawDoc = ai.kind === 'document' ? savedDocText : ai.text;
  // 只有外部分析生成的整篇落盘；本地模型那版会随转写一直更新，写死反而会停在早期版本。
  seedDocument = ai.kind === 'analysis';
  baselineDoc = null; // 换了一份文档，旧基线作废，等编辑器重挂完重新取
  renderTabs();
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
    // 用 preliminaryChanged 而不是只比 sourceFingerprint：强制重跑时逐字稿没变、
    // 指纹也就没变，只比指纹会认不出新结果——按钮会一直卡在「本地 AI 处理中…」。
    if (board.preliminary && preliminaryChanged(board.preliminary, preliminary)) {
      applyPreliminary(board.preliminary);
    }
    // 逐字稿是「这场会还在开」时唯一会一直变的东西：不跟着刷新，面板会停在打开那一刻的旧内容。
    // 只在真的变了时重画，否则 2 秒一次会把面板里的选中和滚动位置反复打回顶部。
    const nextTranscript = typeof board.transcript === 'string' ? board.transcript : '';
    if (nextTranscript !== transcript) {
      transcript = nextTranscript;
      renderTabs();
    }
    // 本地模型那一版也会随转写更新，编辑器却是「初始化时读一次值」的非受控组件——不重挂就停在旧版。
    // 只在用户没动过、且白板正文还是空的时侯换：否则会把正在写的内容冲掉。
    const nextSaved = typeof board.document === 'string' ? board.document : '';
    if (doc === rawDoc && !nextSaved.trim()) {
      const nextAi = resolveAiContent({
        document: nextSaved,
        analysisText: analysis ? analysisToMarkdown(analysis) : '',
        preliminary: board.preliminary || preliminary,
      });
      if (nextAi.text !== doc) {
        doc = nextAi.text;
        rawDoc = nextAi.text;
        await remountEditor();
      }
    }
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
    if (response.ok) { rawDoc = payload; savedDocText = payload; }
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
  return knownSessions.get(selectedSessionId) || null;
}

// 顶部只留一行「当前会议名」。白板是要投给会议室里所有人看的：常驻的标题、状态、
// 按钮和横排场次卡片会把文档挤下去，也让人一直意识到「这是某个软件的窗口」。
// 但历史场次必须带上日期——「会议 11:41」跨天不再唯一，不带日期就看不出在看哪一天。
function renderSessionTitle() {
  const session = currentSession();
  $('sessionName').textContent = session ? sessionDisplayTitle(session) : '今天还没有识别出的会议';
  // 同步顶栏的复制按钮
  const copyBtn = $('boardCopyBtn');
  const docPath = (session && session.docPath) || '';
  if (docPath) {
    copyBtn.hidden = false;
    copyBtn.dataset.path = docPath;
  } else {
    copyBtn.hidden = true;
  }
}

/** 把关键词在已转义的片段里标出来。先转义再标：顺序反了就是一条注入路径。 */
function highlightMatches(text, query) {
  const safe = escapeHtml(text);
  const terms = String(query || '').trim().split(/\s+/)
    .filter((term) => term.length > 1)
    .map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!terms.length) return safe;
  return safe.replace(new RegExp(`(${terms.join('|')})`, 'gi'), '<mark>$1</mark>');
}

// 只重画列表，不碰输入框。整块 menu 重建的话，每 2 秒一次的轮询会把正在输入的字和
// 光标一起吃掉。
function renderMenu() {
  const list = $('sessionList');
  if (!list) return;
  list.innerHTML = menuSessions.length
    ? menuSessions.map((session) => `<button class="menu-item ${session.id === selectedSessionId ? 'active' : ''}" data-session-id="${escapeHtml(session.id)}"><span class="menu-title">${escapeHtml(sessionDisplayTitle(session))}</span><span class="menu-meta">${escapeHtml(sessionMetaLabel(session))}</span>${session.snippet ? `<span class="menu-snippet">${highlightMatches(session.snippet, menuQuery)}</span>` : ''}</button>`).join('')
    : `<div class="menu-empty">${menuQuery ? '没有匹配的会议' : '还没有可以打开的会议'}</div>`;
  list.querySelectorAll('.menu-item').forEach((button) => {
    button.onclick = () => { selectSession(button.dataset.sessionId); };
  });
}

// 下拉要能纯键盘用：展开后光标在输入框，向下键进列表，上键回到输入框，回车即选中。
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
    void requestPreliminary();
    toast('已切换会议文档');
  } finally { switchingSession = false; }
}

// 选中一场会议。场次可能来自历史日期，所以「选中的是哪一天」必须跟着一起记下来：
// 轮询只认今天，记错了日期就会被自动跟随踢回今天。
function selectSession(id) {
  const session = knownSessions.get(id);
  if (!session) return;
  // 宽屏的侧边栏是常驻工作区：挑下一场会议不该顺手把它收掉——想看下一场还得再点一次按钮。
  // 窄屏的下拉是浮层，必须收：留着它会盖在刚打开的文档上。
  if (!wideSidebar()) closeMenu();
  if (session.id === selectedSessionId) return;
  selectedSessionId = session.id;
  selectedDate = session.date || localDateStamp();
  preliminaryTriggerKey = '';
  void loadSelectedSession();
}

// 每 2 秒拉一次「今天」的场次列表（轮询主循环在 init 里）。变了才重画，
// 不顺带重新加载文档——否则看历史会议时，今天的场次一有风吹草动就把正在看的内容刷掉。
// 下拉里显示的那一份是 menuSessions（可能是跨天检索结果），和这里必须分开记。
async function refreshSessions() {
  try {
    const latest = await fetchSessions();
    if (JSON.stringify(latest) === JSON.stringify(sessions)) return;
    sessions = latest;
    rememberSessions(latest);
    // 「选中的场次不在今天的列表里就退回最新一场」只在看今天时成立。看历史会议时
    // 它当然不在今天的列表里，照旧执行就会每 2 秒把人踢回今天。
    if (selectedDate === localDateStamp()) {
      if (selectedSessionId && !sessions.some((session) => session.id === selectedSessionId)) selectedSessionId = sessions.at(-1)?.id || '';
      if (!selectedSessionId && sessions.length) selectedSessionId = sessions.at(-1).id;
    }
    renderSessionTitle();
    // 下拉默认列表（没输关键词）要跟着今天的场次走；正在检索时列表归检索结果管。
    if (!$('sessionMenu').hidden && !menuQuery) void runSearch('');
    renderMenu();
  } catch (error) { console.warn('[board] refresh sessions:', error); }
}

/** 宽屏侧边栏形态？判定只此一处，别在别处再写一遍 1000。 */
function wideSidebar() { return wideMedia.matches; }

/** 两侧的按钮状态一起改：形态变了但 aria 还停在旧值，读屏和样式就会互相矛盾。 */
function syncSessionToggle(open) {
  $('sessionBtn').setAttribute('aria-expanded', String(open));
  const toggle = $('sessionSidebarToggle');
  if (!toggle) return;
  toggle.setAttribute('aria-expanded', String(open));
  toggle.title = open ? '收起会议列表' : '打开会议列表';
  toggle.setAttribute('aria-label', toggle.title);
}

/**
 * 打开会议列表。
 *
 * focusSearch=false 只用于「打开白板时宽屏默认展示侧边栏」这一处：那不是用户点出来的，
 * 把光标抢进搜索框，接下来随便敲的字（投屏时主持人、或想按 ⌘E 的人）都会落进输入框。
 * 用户自己点开的（下拉或侧边栏按钮）仍然落在搜索框，保持「打字 → 上下挑 → 回车」这条路径。
 */
function openMenu({ focusSearch = true } = {}) {
  // 先拿今天已有的场次垫一下，避免下拉开出来先是空的、等网络回来才长出内容。
  if (!menuQuery && menuSessions.length === 0 && sessions.length) menuSessions = sessions;
  $('sessionMenu').hidden = false;
  $('board-wrap').classList.add('sidebar-open', 'menu-open');
  sidebarCollapsed = false;
  syncSessionToggle(true);
  renderMenu();
  const input = $('sessionSearch');
  if (input) { input.value = menuQuery; if (focusSearch) input.focus(); }
  void runSearch(menuQuery);
}

function closeMenu() {
  $('sessionMenu').hidden = true;
  $('board-wrap').classList.remove('sidebar-open', 'menu-open');
  // 只有宽屏下关掉才是「用户主动收起侧边栏」；窄屏关的是一块浮层，不该当成用户偏好记住。
  if (wideSidebar()) sidebarCollapsed = true;
  syncSessionToggle(false);
}

// 阅读 / 编辑切换（默认阅读态）。
// 白板是投屏现场：拿标 / 拖块 / 滑到正文上敲一下就改了内容，而且自动保存、没有后悔药。
// 所以默认不给改，要改先点一下「编辑」——这句也是 xiaoer-omia 的做法。
function setReading(next) {
  if (reading === next) return;
  reading = next;
  renderBoardEditor?.();   // 同一个编辑器实例上换只读/可编辑，不重新挂载
  syncReadToggle();
}

/** 按钮本身承担状态显示：阅读态写「编辑」（你一旦能做的事），编辑态写「阅读」。 */
function syncReadToggle() {
  const btn = $('readToggle');
  if (!btn) return;
  btn.textContent = reading ? '编辑' : '阅读';
  btn.title = reading ? '进入编辑，可以直接改白板内容（⌘E）' : '回到阅读，只看看不改（⌘E）';
  btn.setAttribute('aria-pressed', String(!reading));
  btn.dataset.editing = String(!reading);
}

/** 阅读态下有人试图直接改内容时说一句 —— 否则就是「敲键盘没反应」。每个阅读阶段只说一次。 */
function hintReadOnly() {
  if (readHintShown || !reading) return;
  readHintShown = true;
  toast('阅读模式：点右上角「编辑」才能修改');
}

async function initEditor() {
  // 上游编辑器是非受控组件：初始内容只在挂载时读取，切换会议时由调用方卸载并重建。
  editorReady = false;
  const generation = ++editorGeneration;
  const sessionAtInit = selectedSessionId;
  const initialValue = extractFrontMatter(doc).body || '';
  // 上游编辑器只接收正文，Front Matter 仍由外层分块保存逻辑负责回填。
  doc = initialValue;
  // 换场次回到阅读态（和 xiaoer-omia 一致：换文件默认阅读）。投屏中误碰修改比多按一下「编辑」贵得多。
  reading = true;
  readHintShown = false;
  editorRoot = createRoot(editorEl);
  await new Promise((resolve, reject) => {
    const boardProps = {
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
    };
    // readOnly 从 reading 现取：同一个编辑器实例上只是切一个 prop，不重新挂载
    // （重建会丢掉撤销历史、还会闪一下）。
    renderBoardEditor = () => editorRoot.render(createElement(BoardEditor, { ...boardProps, readOnly: reading }));
    renderBoardEditor();
    syncReadToggle();
  });
}

async function init() {
  document.getElementById('app').innerHTML = `
    <div class="board-wrap" id="board-wrap">
      <div class="board-bar">
        <button class="session-sidebar-toggle" id="sessionSidebarToggle" type="button" aria-controls="sessionMenu" aria-expanded="false" title="打开会议列表" aria-label="打开会议列表">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h10"/></svg>
        </button>
        <button class="board-session" id="sessionBtn" aria-haspopup="true" aria-controls="sessionMenu" aria-expanded="false">
          <span id="sessionName">加载中…</span>
          <svg class="board-caret" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>
        </button>
        <button class="board-copy" id="boardCopyBtn" hidden title="复制文档路径" aria-label="复制文档路径">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="8" height="4" x="8" y="2" rx="1" ry="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/></svg>
        </button>
        <span class="board-status" id="status" hidden></span>
        <button class="board-read-toggle" id="readToggle" aria-pressed="false" data-editing="false">编辑</button>
        <button class="local-ai-button" id="localAiButton" hidden>本地 AI 处理</button>
        <div class="board-menu" id="sessionMenu" hidden>
          <input class="board-search" id="sessionSearch" type="search" autocomplete="off" spellcheck="false"
                 placeholder="搜索会议标题或内容…" aria-label="搜索会议" aria-controls="sessionList">
          <div class="board-menu-list" id="sessionList"></div>
        </div>
      </div>
      <!-- 白板上只有两档，共占同一块位置：
            逐字稿（原话，只读）和 AI 会议内容（白板正文本身，可编辑，由模型生成）。
            **没有第三个笔记区**——标签下面不再另起一块编辑器。 -->
      <section class="preliminary-panel" id="preliminaryPanel" data-state="empty" data-tab="raw">
        <div class="preliminary-tabbar">
          <div class="preliminary-tabs" id="preliminaryTabs" role="tablist" aria-label="会议内容视图"></div>
        </div>
        <div class="board-panes">
          <div class="board-pane board-pane-raw" id="transcriptPane" data-active="true" role="tabpanel" aria-label="逐字稿">
            <pre id="preliminaryText" aria-live="polite">正在读取这场会议的转写…</pre>
            <div class="preliminary-note" id="preliminaryNote">开始说话后，逐字稿会出现在这里，不需要等 AI 整理。</div>
          </div>
          <div class="board-pane board-pane-ai" id="aiPane" data-active="false" role="tabpanel" aria-label="AI 会议内容">
            <div class="editor-wrap"><div id="editor"></div></div>
            <div class="preliminary-note" id="aiNote"></div>
          </div>
        </div>
      </section>
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
  rememberSessions(sessions);
  selectedSessionId = sessions.at(-1)?.id || '';
  selectedDate = localDateStamp();
  renderSessionTitle();
  renderMenu();
  await loadBoard(true);
  await initEditor();
  void requestPreliminary();
  const toggleSessionMenu = (event) => { event.stopPropagation(); if ($('sessionMenu').hidden) openMenu(); else closeMenu(); };
  $('sessionBtn').onclick = toggleSessionMenu;
  $('sessionSidebarToggle').onclick = toggleSessionMenu;
  // 宽屏默认展示侧边栏，给会议列表一个稳定的工作区；窄屏仍使用原来的下拉菜单。
  // 默认展开不是用户点的，所以不抢焦点（见 openMenu 的 focusSearch）。
  if (wideSidebar()) openMenu({ focusSearch: false });
  // 窗口宽度跨过阈值时跟着换形态：变宽按「默认打开」恢复（除非用户刚主动收起过），
  // 变窄必须收起来——浮层形态下留着它就会盖在正文上，而且这时候收起按钮本身是隐藏的。
  wideMedia.addEventListener('change', (event) => {
    if (event.matches) { if (!sidebarCollapsed) openMenu({ focusSearch: false }); return; }
    closeMenu();
    sidebarCollapsed = false;
  });
  // 边打边搜。服务端要读当天的 jsonl，敲一下就发一次请求既浪费又会让结果乱序，
  // 所以压一小段时间；真正的乱序由 runSearch 的序号兜住。
  $('sessionSearch').addEventListener('input', (event) => {
    menuQuery = event.target.value.trim();
    scheduleSearch(menuQuery);
  });
  $('readToggle').onclick = () => setReading(!reading);
  // ⌘E / Ctrl+E：和 xiaoer-omia 同一个快捷键。在输入框里不拦（会议定义那四个字段还是要能打字的）。
  document.addEventListener('keydown', (event) => {
    if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey) return;
    if (event.key.toLowerCase() !== 'e') return;
    const target = event.target;
    if (target instanceof HTMLElement && (target.closest('input, textarea, select') || target.isContentEditable)) return;
    event.preventDefault();
    setReading(!reading);
  });
  // 阅读态里直接上手改内容（点正文 / 敲键盘）时给一句提示
  editorEl.addEventListener('pointerdown', hintReadOnly, true);
  editorEl.addEventListener('keydown', hintReadOnly, true);
  $('saveDefBtn').onclick = async () => toast((await saveDef(readForm())) ? '定义已保存' : '保存失败');
  // 顶栏复制按钮
  $('boardCopyBtn').onclick = async () => {
    const text = $('boardCopyBtn').dataset.path;
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      toast('文档路径已复制');
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      toast('文档路径已复制');
    }
  };
  // 宽屏的侧边栏是常驻的：点正文不算「点到外面」。浮层下拉才靠点外面收起。
  document.addEventListener('click', (event) => {
    if (wideSidebar()) return;
    if (!event.target.closest('.board-bar')) closeMenu();
  });
  pollTimer = setInterval(async () => {
    await refreshSessions();
    await refreshDocument();
    void requestPreliminary();
  }, 2000);
  // 窗口重新拿回焦点时也重读一次（做法同 xiaoer-omia）。切窗口回来就该看到最新的，
  // 而不是再等一个轮询周期。
  window.addEventListener('focus', () => { void refreshDocument(); });
  document.addEventListener('keydown', (event) => {
    if (!$('sessionMenu').hidden) {
      const target = event.target;
      const inSearch = target === $('sessionSearch');
      // Home / End 在输入框里是「跳到关键词首尾」，只有光标在列表上时才当成「跳到首尾项」。
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        // 光标还在输入框时，向下键先落进列表：这样「打字 → 上下挑 → 回车」是一条完整的路径。
        if (inSearch) focusMenuItem(0); else moveMenuFocus(1);
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        // 已经在本轮第一项时，向上键回到输入框，否则没法再用键盘改关键词。
        if (!inSearch && menuItems().indexOf(target) === 0) $('sessionSearch').focus();
        else moveMenuFocus(-1);
        return;
      }
      if (!inSearch && event.key === 'Home') { event.preventDefault(); focusMenuItem(0); return; }
      if (!inSearch && event.key === 'End') { event.preventDefault(); focusMenuItem(menuItems().length - 1); return; }
      // 下拉展开时 Esc 先处理下拉（回车选中的是按钮本身的默认行为，不用额外处理），
      // 否则这个键会直接把白板窗口关掉。有搜索词时，Esc 先清词——一次 Esc 就关掉整个
      // 下拉，会让人分不清是「清掉搜索」还是「关掉菜单」。
      if (event.key === 'Escape') {
        if (menuQuery) {
          $('sessionSearch').value = '';
          menuQuery = '';
          void runSearch('');
          $('sessionSearch').focus();
          return;
        }
        closeMenu();
        $('sessionBtn').focus();
        return;
      }
    }
    if (event.key === 'Escape') window.close();
  });
}

window.addEventListener('beforeunload', () => { clearInterval(pollTimer); clearTimeout(saveTimer); clearTimeout(searchTimer); });
init().catch((error) => { console.error(error); if (statusEl) showStatus('初始化失败'); });
