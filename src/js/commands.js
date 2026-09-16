import { toast, esc } from './ui.js';
import { state } from './state.js';
import { fetchLocalConfig } from './storage.js';
import { apiUrl } from './api.js';
import { pasteToCursor, copyToSystemClipboard } from './clipboard.js';
import { getFrontmostApp } from './frontmost.js';

// 默认指令表：仅在 commands.json 缺失时作为种子写入。
// 此后一切以数据目录下的 commands.json 为准（用户或外部 AI Agent 可直接改文件）。
const DEFAULT_ALIASES = {
  '微信': 'WeChat',
  'weixin': 'WeChat',
  'wechat': 'WeChat',
  '钉钉': 'DingTalk',
  'dingtalk': 'DingTalk',
  '企业微信': 'WeCom',
  'wecom': 'WeCom',
  '浏览器': 'Safari',
  'safari': 'Safari',
  '谷歌浏览器': 'Google Chrome',
  'chrome': 'Google Chrome',
  '终端': 'Terminal',
  'terminal': 'Terminal',
  '访达': 'Finder',
  'finder': 'Finder',
};

const LEARN_KEY = 'commandAliases'; // 旧配置兼容：settings.commandAliases

// 内存同步表：启动时预载（commands.json + 旧配置合并），此后 tryHandleSpecialCommand 同步命中
let commandCache = {};
let actionCache = {}; // 动作指令表：整句说法 → 动作（enter 等）
let snippetCache = {}; // 快捷短语表：整句说法 → 要粘贴出去的一段文本
let loaded = false;

/** 读取指令映射：/api/commands（含内置默认，首次自动落盘） + 兼容旧 settings.commandAliases */
async function loadCommandMap() {
  let map = {};
  let actions = {};
  let snippets = {};
  try {
    const r = await fetch(apiUrl('/api/commands'));
    const data = await r.json().catch(() => ({}));
    if (data && data.aliases && typeof data.aliases === 'object') map = { ...data.aliases };
    if (data && data.actions && typeof data.actions === 'object') actions = { ...data.actions };
    if (data && data.snippets && typeof data.snippets === 'object') snippets = { ...data.snippets };
  } catch (e) {
    console.error('[command] 指令表加载失败:', e.message || e);
  }
  // 兼容旧配置（settings.commandAliases），合并覆盖
  try {
    const config = await fetchLocalConfig();
    const legacy = config.settings && config.settings[LEARN_KEY];
    if (legacy && typeof legacy === 'object') {
      for (const k of Object.keys(legacy)) {
        if (typeof legacy[k] === 'string' && legacy[k]) map[k] = legacy[k];
      }
    }
  } catch { /* 忽略旧配置读取失败 */ }
  return { aliases: map, actions, snippets };
}

/** 写回单条指令（PATCH /api/commands，只动这一条）
 *  为什么不整表 PUT：这份文件允许用户和外部 Agent 直接编辑（设置里的「指令配置文件」
 *  就是它），整表覆盖会把别人刚改的内容静默抹掉（原则 6）。PATCH 只提交本次学到的
 *  这一条，其余条目一概不碰；删除只在管理页里由用户显式做。 */
async function persistCommandEntry(section, key, value) {
  try {
    const r = await fetch(apiUrl('/api/commands'), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [section]: { set: { [key]: value } } }),
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
  } catch (e) {
    console.error('[command] 指令回写失败:', e.message || e);
  }
}

/** 启动时预载指令映射（放入内存同步表） */
export async function initLearnedCommands() {
  const { aliases, actions, snippets } = await loadCommandMap();
  commandCache = aliases;
  actionCache = actions;
  snippetCache = snippets;
  loaded = true;
  console.log(`[command] 指令表已加载 ${Object.keys(commandCache).length} 条别名 / ${Object.keys(actionCache).length} 条动作 / ${Object.keys(snippetCache).length} 条短语`);
  initCommandMenu();
}

/* ---------------- 语音指令面板（右上角图标入口；测试功能，刻意轻量） ---------------- */

// 动作值 → 人话。两种值：按键表达式（Enter / Meta+Shift+KeyK）和功能码（meeting_summary）。
// 未知值原样显示，新增动作时面板不会失真。
// 老表里存的是动作码，显示和执行前都先翻译成表达式
const LEGACY_KEY_ALIAS = { enter: 'Enter', arrow_down: 'ArrowDown', arrow_up: 'ArrowUp' };
const MOD_SYMBOLS = { Meta: '⌘', Ctrl: '⌃', Alt: '⌥', Shift: '⇧' };
const KEY_SYMBOLS = {
  Enter: '↩', Escape: 'esc', Tab: '⇥', Space: '空格', Backspace: '⌫', Delete: '⌦',
  ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
  Home: '↖', End: '↘', PageUp: '⇞', PageDown: '⇟',
};

/** `Meta+Shift+KeyK` → `⌘⇧K`；`ArrowDown` → `↓` */
function formatShortcut(expr) {
  return String(expr || '').split('+').filter(Boolean).map((p) => {
    if (MOD_SYMBOLS[p]) return MOD_SYMBOLS[p];
    if (KEY_SYMBOLS[p]) return KEY_SYMBOLS[p];
    const letter = /^Key([A-Z])$/.exec(p);
    if (letter) return letter[1];
    const digit = /^Digit(\d)$/.exec(p);
    if (digit) return digit[1];
    return p;
  }).join('');
}

/** 动作值 → 界面上显示的名字 */
function actionLabel(value) {
  if (!value) return '选择按键';
  if (value === 'meeting_summary') return '生成会议纪要';
  return formatShortcut(LEGACY_KEY_ALIAS[value] || value);
}

/* ---------------- 语音指令管理页（整页；增删改查都在这） ---------------- */
// 以前这里是个只读小面板：想改指令得自己去编辑 commands.json，而 open -a 认的是
// .app 包名（写显示名「飞书」会报「应用不存在」），改错了还不好自查。
// 现在点图标直接打开这一页，和设置同一个形态：左边说法、右边目标，随时增删改。

// 动作分两类，界面上分两块摆：按键类是「替你敲一下」，功能类是「让 app 干一件事」。
// 混在一起用户会以为会议总结也只是个快捷键——它并不按键，说完要等一下结果。
const ACTION_GROUPS = [
  { id: 'keys', order: ['enter', 'arrow_down', 'arrow_up'] },
  { id: 'features', order: ['meeting_summary'] },
];
const ACTION_GROUP_BOX = { keys: 'cmdRowsKeys', features: 'cmdRowsFeatures' };
const CMD_ROW_BOX = {                                // section → 它在页面上占的容器（动作有两个）
  aliases: ['cmdRowsAliases'],
  actions: Object.values(ACTION_GROUP_BOX),
  snippets: ['cmdRowsSnippets'],
};
const ALL_CMD_BOXES = Object.values(CMD_ROW_BOX).flat();
const CMD_ICON_TRASH = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg>';

let cmdMenuBound = false;   // 图标入口只绑一次
let cmdPageBound = false;   // 管理页内的事件只绑一次
let cmdPageBefore = null;   // 打开页面时的快照：保存时用它算「到底改了哪几条」
let cmdApps = null;         // 应用候选（name 就是 open -a 认的包名）
let cmdAppsPending = null;
let cmdPickerEl = null;
let cmdPickerCleanup = null;



/** 应用候选（GET /api/apps）：返回的 name 就是包名，不是显示名 */
function loadAppList() {
  if (cmdApps) return Promise.resolve(cmdApps);
  if (cmdAppsPending) return cmdAppsPending;
  cmdAppsPending = fetch(apiUrl('/api/apps'))
    .then((r) => r.json())
    .then((d) => { cmdApps = (d && Array.isArray(d.apps)) ? d.apps : []; return cmdApps; })
    .catch(() => { cmdApps = []; return cmdApps; })
    .finally(() => { cmdAppsPending = null; });
  return cmdAppsPending;
}

/** 一行 = 一条指令：说法 → 目标（应用 / 动作 / 要发出去的话） */
function commandRowHtml(section, key, value) {
  let target;
  if (section === 'snippets') {
    target = `<input class="cmdInput cmdValueIn" value="${esc(value)}" placeholder="要发出去的话" spellcheck="false">`;
  } else {
    const label = section === 'actions' ? actionLabel(value) : (value || '选择应用');
    // 功能块的目标不能改：值是程序里的功能码，换一个等于换个不存在的功能。做成不可点的
    // 样子，而不是「点下去才知道不行」；新功能加进 ACTION_GROUPS 的 features 里就会自动锁上。
    // 症状备忘（别再写回来）：这里曾经是 !!FUNCTION_LABELS[value]，而 FUNCTION_LABELS 被
    // 删掉换成了 actionLabel 里的字面判断。少删的这一处让整页在第 175 行抛 ReferenceError，
    // 页面停在 hidden 没显示出来，用户看到的就是「右上角 ⌘ 图标点了没反应」。
    const locked = section === 'actions' && actionGroupId(value) === 'features';
    const tip = locked ? `这个功能由程序实现，只能改左边的说法（${label}）` : label;
    // title：右边这一栏窄，长应用名（如 Karabiner-VirtualHIDDevice-Manager）会被截断，
    // 鼠标停留一下能看到全名
    target = `<button type="button" class="cmdTargetBtn${value ? '' : ' empty'}${locked ? ' locked' : ''}" data-value="${esc(value)}" title="${esc(tip)}"${locked ? ' aria-disabled="true"' : ''}>${esc(label)}</button>`;
  }
  return `<div class="cmdEditRow" data-section="${section}">`
    + `<input class="cmdInput cmdPhraseIn" value="${esc(key)}" placeholder="说法，多个用 ｜ 隔开" spellcheck="false">`
    + `<span class="cmdArrowTxt">→</span>${target}`
    + `<button type="button" class="cmdIconBtn cmdDelBtn" data-act="del" title="删除这条" aria-label="删除这条">${CMD_ICON_TRASH}</button>`
    + `</div>`;
}

/**
 * 渲染时把目标相同的说法并成一行。
 * 用户是按「这个应用要哪些说法」来想的（飞出｜飞速｜飞书 都是 Lark），拆成多行会把
 * 同一件事散在好几处；底层仍是扁平键值对（外部工具好改），只在显示这一层合并。
 */
function groupPhrasesByValue(table) {
  const groups = [];
  const byValue = new Map();
  for (const [key, value] of Object.entries(table || {})) {
    let group = byValue.get(value);
    if (!group) { group = { keys: [], value }; byValue.set(value, group); groups.push(group); }
    group.keys.push(key);
  }
  return groups;
}

/** 空块里的提示。功能块没有「添加一条」，别让它指向一个不存在的按钮 */
function emptyHintFor(boxId) {
  return boxId === 'cmdRowsFeatures'
    ? '这里没有可用功能（功能里是程序逻辑，只能改说法）'
    : '还没有，点下面的「添加一条」';
}

function renderCommandRows(section, table, boxId) {
  const box = document.getElementById(boxId);
  if (!box) return;
  const groups = groupPhrasesByValue(table);
  box.innerHTML = groups.length
    ? groups.map((g) => commandRowHtml(section, g.keys.join('｜'), g.value)).join('')
    : `<div class="cmdEmpty">${emptyHintFor(boxId)}</div>`;
}

/** 这个动作属于哪一类（按「值」判断；认不出的先归按键，不至于凭空消失） */
function actionGroupId(value) {
  const hit = ACTION_GROUPS.find((g) => g.order.includes(value));
  return hit ? hit.id : ACTION_GROUPS[0].id;
}

function renderCommandPage(tables) {
  renderCommandRows('aliases', tables.aliases, 'cmdRowsAliases');
  renderCommandRows('snippets', tables.snippets, 'cmdRowsSnippets');
  // 动作按类归位：渲染时就按值分组，所以哪怕哪一行选错了类的动作，重开也会回到正确那边
  const byGroup = { keys: {}, features: {} };
  for (const [key, value] of Object.entries(tables.actions || {})) byGroup[actionGroupId(value)][key] = value;
  for (const g of ACTION_GROUPS) renderCommandRows('actions', byGroup[g.id], ACTION_GROUP_BOX[g.id]);
}

/** 整页打开时把主界面让开（和设置页同一套做法） */
function setMainHidden(hidden) {
  const display = hidden ? 'none' : '';
  for (const id of ['queryBar', 'list']) {
    const el = document.getElementById(id);
    if (el) el.style.display = display;
  }
  const footer = document.querySelector('footer');
  if (footer) footer.style.display = display;
}

/**
 * 说法里的「或者」：`飞出|飞速|飞书` 各算一条。
 * 同音误识别这类场景一次要加三四个说法，逐个加行太啰嗦；全角半角竖线都认。
 */
function splitPhraseKeys(raw) {
  return raw.split(/[|｜]/).map((s) => s.trim()).filter(Boolean);
}

/** 读界面上的当前内容。没填全的行不丢弃，收进 problems，保存时一并提示 */
function collectCommandPage() {
  const problems = [];
  const tables = { aliases: {}, actions: {}, snippets: {} };
  // 动作分两块容器，所以遍历容器而不是遍历 section；section 从行自己身上拿
  for (const boxId of ALL_CMD_BOXES) {
    const box = document.getElementById(boxId);
    if (!box) continue;
    for (const row of box.querySelectorAll('.cmdEditRow')) {
      const section = row.dataset.section;
      const raw = row.querySelector('.cmdPhraseIn').value.trim();
      const input = row.querySelector('.cmdValueIn');
      const target = row.querySelector('.cmdTargetBtn');
      const value = ((input ? input.value : (target ? target.dataset.value : '')) || '').trim();
      // 一行可以写好几个说法，保存时各成一条（之后能单独改、单独删）
      const keys = splitPhraseKeys(raw);
      if (!keys.length && !value) continue;               // 整行空着：当没这条
      if (!keys.length) { problems.push('有一行只填了右边，没写「说法」'); continue; }
      if (!value) { problems.push(`「${keys[0]}」还没选目标`); continue; }
      for (const key of keys) {
        if (tables[section][key] !== undefined) { problems.push(`「${key}」在同一个分组里出现了两次`); continue; }
        tables[section][key] = value;
      }
    }
  }
  return { tables, problems };
}

/** 只算出改动过的条目：外部同时改过 commands.json 时，没动的内容不受牵连 */
function diffCommands(before, after) {
  const patch = {};
  for (const section of ['aliases', 'actions', 'snippets']) {
    const oldTable = before[section] || {};
    const newTable = after[section] || {};
    const set = {};
    const del = [];
    for (const [k, v] of Object.entries(newTable)) if (oldTable[k] !== v) set[k] = v;
    for (const k of Object.keys(oldTable)) if (!(k in newTable)) del.push(k);
    if (Object.keys(set).length || del.length) patch[section] = { set, del };
  }
  return patch;
}

function closeCommandPicker() {
  if (cmdPickerEl) { cmdPickerEl.remove(); cmdPickerEl = null; }
  if (cmdPickerCleanup) { cmdPickerCleanup(); cmdPickerCleanup = null; }
}

/** 选应用 / 选动作的浮层（不用原生 select，理由见 style.css） */
function openCommandPicker(anchor, items, current, { searchable = false, record = false, onPick = null } = {}) {
  closeCommandPicker();
  const rect = anchor.getBoundingClientRect();
  const el = document.createElement('div');
  el.className = 'cmdPicker';
  el.innerHTML = (searchable ? '<input class="cmdPickerSearch" placeholder="搜索应用…" spellcheck="false">' : '')
    + '<div class="cmdPickerList"></div>'
    + (record ? '<button type="button" class="cmdPickRecord">直接按一个键…（可带 ⌘⇧⌥⌃）</button>' : '');
  document.body.appendChild(el);
  cmdPickerEl = el;

  const list = el.querySelector('.cmdPickerList');
  const draw = (keyword) => {
    const kw = (keyword || '').trim().toLowerCase();
    const shown = kw
      ? items.filter((it) => it.label.toLowerCase().includes(kw) || (it.sub || '').toLowerCase().includes(kw))
      : items;
    list.innerHTML = shown.length
      ? shown.map((it) => `<button type="button" class="cmdPickItem${it.value === current ? ' on' : ''}" data-value="${esc(it.value)}">`
          + `<span>${esc(it.label)}</span>${it.sub ? `<span class="pickSub">${esc(it.sub)}</span>` : ''}</button>`).join('')
      : '<div class="cmdPickNone">没找到</div>';
  };
  draw('');

  // 摆位：往下放不下就翻到上面，右边越界就贴右（先量高度再定位）
  const height = el.offsetHeight;
  const width = el.offsetWidth;
  const below = window.innerHeight - rect.bottom - 8;
  el.style.top = (below >= Math.min(height, 200) ? rect.bottom + 4 : Math.max(8, rect.top - height - 4)) + 'px';
  el.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)) + 'px';

  const search = el.querySelector('.cmdPickerSearch');
  if (search) {
    search.oninput = () => draw(search.value);
    setTimeout(() => search.focus(), 0);
  }
  const onOutside = (e) => { if (!el.contains(e.target) && e.target !== anchor) closeCommandPicker(); };
  const onEscape = (e) => { if (e.key === 'Escape') { e.stopPropagation(); closeCommandPicker(); } };
  cmdPickerCleanup = () => {
    document.removeEventListener('click', onOutside, true);
    document.removeEventListener('keydown', onEscape, true);
  };
  setTimeout(() => {
    document.addEventListener('click', onOutside, true);
    document.addEventListener('keydown', onEscape, true);
  }, 0);

  list.addEventListener('click', (e) => {
    const item = e.target.closest('.cmdPickItem');
    if (!item) return;
    const expr = item.dataset.value;
    if (onPick) {
      onPick(expr);
    } else {
      anchor.dataset.value = expr;
      anchor.textContent = formatShortcut(expr);
      anchor.title = expr;
      anchor.classList.remove('empty');
    }
    closeCommandPicker();
  });

  const rec = el.querySelector('.cmdPickRecord');
  if (rec) rec.addEventListener('click', () => { closeCommandPicker(); startShortcutRecording(anchor); });
}

/**
 * 录一个快捷键：按下什么就记什么，Esc 取消。
 * 光按修饰键不算数（那没意义）。左右修饰键在这里会被合并——这条发键通道本来就发不出
 * 左右，录下来也执行不了，不如当场就不给这个错觉。
 */
function startShortcutRecording(anchor) {
  const original = { value: anchor.dataset.value || '', text: anchor.textContent, title: anchor.title };
  anchor.classList.add('recording');
  anchor.textContent = '请按一个键…（Esc 取消）';
  const stop = () => {
    document.removeEventListener('keydown', onKey, true);
    anchor.classList.remove('recording');
  };
  const restore = () => {
    anchor.dataset.value = original.value;
    anchor.textContent = original.text;
    anchor.title = original.title;
  };
  const onKey = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') { restore(); stop(); return; }
    if (['Meta', 'Control', 'Alt', 'Shift'].includes(e.key)) return;   // 光按修饰键不算
    const mods = [];
    if (e.metaKey) mods.push('Meta');
    if (e.ctrlKey) mods.push('Ctrl');
    if (e.altKey) mods.push('Alt');
    if (e.shiftKey) mods.push('Shift');
    const expr = mods.concat(e.code).join('+');
    anchor.dataset.value = expr;
    anchor.textContent = formatShortcut(expr);
    anchor.title = expr;
    anchor.classList.remove('empty');
    stop();
    toast('已录下 ' + formatShortcut(expr));
  };
  document.addEventListener('keydown', onKey, true);
}

/** 复用语音指令页的应用选择器，供其他设置选择本机应用。 */
export async function pickApplication(anchor, current, onPick) {
  const apps = await loadAppList();
  if (!apps.length) { toast('没能读到本机应用列表，请确认本机服务在跑'); return; }
  openCommandPicker(anchor, apps.map((a) => ({ value: a.name, label: a.name, sub: a.path })), current, { searchable: true, onPick });
}

/** 点「选择应用 / 选择动作」 */
async function pickCommandTarget(btn) {
  const row = btn.closest('.cmdEditRow');
  const current = btn.dataset.value || '';
  if (row.dataset.section === 'actions') {
    // 功能块的值是程序里的功能码，换一个等于换个不存在的功能——只让改说法
    if (row.parentElement && row.parentElement.id === 'cmdRowsFeatures') {
      toast('这个功能由程序实现，只能改左边的说法');
      return;
    }
    // 按键目标不是下拉选择器：点进去就等待用户直接按键。
    startShortcutRecording(btn);
    return;
  }
  const apps = await loadAppList();
  if (!apps.length) { toast('没能读到本机应用列表，请确认本机服务在跑'); return; }
  openCommandPicker(btn, apps.map((a) => ({ value: a.name, label: a.name, sub: a.path })), current, { searchable: true });
}

function ensureEmptyHint(box) {
  if (!box) return;
  const hasRow = !!box.querySelector('.cmdEditRow');
  const hint = box.querySelector('.cmdEmpty');
  if (!hasRow && !hint) box.insertAdjacentHTML('beforeend', `<div class="cmdEmpty">${emptyHintFor(box.id)}</div>`);
  if (hasRow && hint) hint.remove();
}

function addCommandRow(section, boxId) {
  const box = document.getElementById(boxId || CMD_ROW_BOX[section][0]);
  if (!box) return;
  const hint = box.querySelector('.cmdEmpty');
  if (hint) hint.remove();
  // 新行的默认动作：按它所在那块的头一个来（按键块给回车，功能块给会议纪要）
  const group = ACTION_GROUPS.find((g) => ACTION_GROUP_BOX[g.id] === boxId);
  box.insertAdjacentHTML('beforeend', commandRowHtml(section, '', group ? group.order[0] : ''));
  const row = box.lastElementChild;
  row.querySelector('.cmdPhraseIn').focus();
  row.scrollIntoView({ block: 'nearest' });
}

async function saveCommandPage() {
  const { tables, problems } = collectCommandPage();
  if (problems.length) {
    toast(problems[0] + (problems.length > 1 ? `（还有 ${problems.length - 1} 处）` : ''));
    return;
  }
  const patch = diffCommands(cmdPageBefore || { aliases: {}, actions: {}, snippets: {} }, tables);
  if (!Object.keys(patch).length) { closeCommandPage(); toast('没有改动'); return; }
  try {
    const r = await fetch(apiUrl('/api/commands'), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || data.error) throw new Error(data.error || ('HTTP ' + r.status));
    // 服务端回的是写盘后的全表：直接拿它刷新内存表，不用再读一次
    commandCache = data.aliases || {};
    actionCache = data.actions || {};
    snippetCache = data.snippets || {};
    closeCommandPage();
    toast('指令已保存');
  } catch (e) {
    toast('保存失败：' + (e.message || e));
  }
}

/** 恢复默认：只把界面填回出厂表，点「保存」才写盘（和设置页同一套心智） */
async function resetCommandPage() {
  if (!confirm('把三张表都换回出厂指令表？\n\n界面上你自己加的内容会清掉。这一步不会马上写文件，点「保存」才生效。')) return;
  try {
    const r = await fetch(apiUrl('/api/commands?defaults=1'));
    const d = await r.json().catch(() => ({}));
    renderCommandPage({ aliases: d.aliases || {}, actions: d.actions || {}, snippets: d.snippets || {} });
    toast('已填入默认指令，点「保存」生效');
  } catch (e) {
    toast('读取默认指令失败：' + (e.message || e));
  }
}

function closeCommandPage() {
  closeCommandPicker();
  const page = document.getElementById('cmdPage');
  if (page) page.classList.add('hidden');
  setMainHidden(false);
}

/** 打开管理页：每次打开都重读一遍文件（外部可能刚改过） */
async function openCommandPage() {
  const page = document.getElementById('cmdPage');
  if (!page) return;
  bindCommandPage();
  // 设置页可能开着：两层整页不叠在一起
  const settings = document.getElementById('settingsPage');
  if (settings) settings.classList.add('hidden');
  const { aliases, actions, snippets } = await loadCommandMap();
  commandCache = aliases;
  actionCache = actions;
  snippetCache = snippets;
  cmdPageBefore = { aliases: { ...aliases }, actions: { ...actions }, snippets: { ...snippets } };
  // 渲染失败也必须把页面显示出来：以前异常会冒泡出去，页面永远停在 hidden，
  // 用户看到的现象是「点了没反应」，连报错都看不到（原则 3：状态要诚实）。
  try {
    renderCommandPage(cmdPageBefore);
  } catch (err) {
    console.error('[command] 指令管理页渲染失败:', err);
    toast('指令管理页打不开：' + (err.message || err));
  }
  page.classList.remove('hidden');
  setMainHidden(true);
  void loadAppList();   // 后台先把应用列表取回来，点下拉时不用等
}

/** 管理页里的事件只绑一次：增删、选目标、底部三颗按钮都走这里 */
function bindCommandPage() {
  if (cmdPageBound) return;
  const page = document.getElementById('cmdPage');
  if (!page) return;
  cmdPageBound = true;

  page.addEventListener('click', (e) => {
    const prompt = e.target.closest('#cmdAgentPrompt');
    if (prompt) {
      const text = prompt.querySelector('.cmdAgentPromptText')?.textContent?.trim();
      if (text) copyToSystemClipboard(text);
      prompt.classList.add('copied');
      prompt.querySelector('.cmdAgentPromptCopy').textContent = '已复制';
      prompt.title = '已复制提示词';
      setTimeout(() => {
        prompt.classList.remove('copied');
        prompt.querySelector('.cmdAgentPromptCopy').textContent = '点击复制';
        prompt.title = '点击复制提示词';
      }, 1500);
      return;
    }
    const add = e.target.closest('.cmdAddBtn');
    if (add) { addCommandRow(add.dataset.section, add.dataset.box); return; }
    const targetBtn = e.target.closest('.cmdTargetBtn');
    if (targetBtn) { void pickCommandTarget(targetBtn); return; }
    // 行尾只剩「删除」一个图标按钮
    const icon = e.target.closest('.cmdIconBtn');
    if (icon) {
      const row = icon.closest('.cmdEditRow');
      const box = row.parentElement;
      row.remove();
      ensureEmptyHint(box);
    }
  });

  const closeBtn = document.getElementById('cmdPageClose');
  if (closeBtn) closeBtn.onclick = () => closeCommandPage();
  const cancelBtn = document.getElementById('cmdPageCancel');
  if (cancelBtn) cancelBtn.onclick = () => closeCommandPage();
  const saveBtn = document.getElementById('cmdPageSave');
  if (saveBtn) saveBtn.onclick = () => void saveCommandPage();
  const resetBtn = document.getElementById('cmdPageReset');
  if (resetBtn) resetBtn.onclick = () => void resetCommandPage();
}

/** 绑定右上角图标入口：点开语音指令管理页 */
function initCommandMenu() {
  const btn = document.getElementById('cmdBtn');
  if (!btn || cmdMenuBound) return;
  cmdMenuBound = true;
  btn.onclick = (e) => { e.stopPropagation(); void openCommandPage(); };
}

/** 从语音中识别选区 AI 操作（"翻译一下"） */
function parseSelectionAiCommand(text) {
  const normalized = normalizePhrase(text);
  return /^(?:帮我)?翻译一下$/.test(normalized) ? { action: 'translate' } : null;
}

/** 从当前应用搜索口令提取搜索词（"找到菜花"） */
function parseCurrentAppSearchCommand(text) {
  const normalized = String(text || '').trim().replace(/[。！？；，、,.!?;\s]+$/g, '');
  const match = normalized.match(/^(?:找到|搜索|查找)\s*(.+)$/);
  const query = match && match[1].trim();
  return query ? { query } : null;
}

/** 从复合口令提取应用和搜索词（"打开钉钉，找到紫藤"） */
function parseAppSearchCommand(text) {
  const normalized = String(text || '').trim().replace(/[。！？；，、,.!?;\s]+$/g, '');
  const match = normalized.match(/^(?:打开|启动|开启)\s*(.+?)\s*(?:[，,、]\s*)?(?:找到|搜索|查找)\s*(.+)$/);
  if (!match) return null;
  const alias = match[1].trim();
  const query = match[2].trim();
  if (!alias || !query) return null;
  const app = commandCache[alias] || commandCache[alias.toLowerCase()];
  return app ? { app, alias, query } : null;
}

/** 从口述文本提取应用名（"打开微信" → "微信"） */
function parseAppCommand(text) {
  const normalized = String(text || '')
    .trim()
    .replace(/[。！？；，、,.!?;\s]+$/g, '')
    .toLowerCase();
  const match = normalized.match(/^(?:打开|启动|开启)\s*(.+)$/);
  if (!match) return null;
  return match[1].trim();
}

/** 执行激活应用，返回 Promise<boolean> */
function activate(app, label, { notify = true } = {}) {
  const invoke = window.__TAURI__?.core?.invoke;
  if (!invoke) {
    toast('应用指令仅支持桌面版');
    return Promise.resolve(false);
  }
  return invoke('activate_app', { app })
    .then(() => { if (notify) toast(`已打开${label}`); return true; })
    .catch(error => {
      console.error('[command] 激活应用失败:', error);
      toast(`打开${label}失败：${error}`);
      return false;
    });
}

/** 归一化整句：去空白与结尾标点 */
function normalizePhrase(text) {
  return String(text || '').trim().replace(/[。！？；，、,.!?;\s]+$/g, '');
}

/** 触发回车（动作 enter）：POST /key/enter，不碰剪贴板 */
async function executeEnter() {
  try {
    const r = await fetch(apiUrl('/key/enter'), { method: 'POST' });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || data.error) {
      toast('发送失败：' + ((data && data.error) || ('HTTP ' + r.status)));
      return;
    }
    if (data.warn) toast('已触发回车（若未发送成功，请检查辅助功能权限）');
    else toast('已发送');
  } catch (e) {
    toast('发送失败：本机服务未连接');
  }
}

/** 按一下某个键（按键类动作）：POST /key/press，值是一个按键表达式 */
async function executeKey(expr, { notify = true } = {}) {
  try {
    const r = await fetch(apiUrl('/key/press'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: expr }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || data.error) {
      if (notify) toast('按键失败：' + ((data && data.error) || ('HTTP ' + r.status)));
      return false;
    }
    if (notify) {
      const name = formatShortcut(LEGACY_KEY_ALIAS[expr] || expr);
      if (data.warn) toast(`已按 ${name}（若没反应，请检查辅助功能权限）`);
      else toast(`已按 ${name}`);
    }
    return true;
  } catch (e) {
    if (notify) toast('按键失败：本机服务未连接');
    return false;
  }
}

/** 会议总结触发词：要求「会议」与「总结/纪要/摘要」同现，避免误吃普通句子 */
const MEETING_SUMMARY_RE = /会议\s*(纪要|总结|摘要)|(纪要|总结|摘要)\s*会议/;

/** 执行会议总结（动作 meeting_summary）：POST /api/tasks/meeting-summary */
async function executeMeetingSummary() {
  toast('正在总结最近一次会议…');
  try {
    const r = await fetch(apiUrl('/api/tasks/meeting-summary'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || data.error) {
      toast('会议总结失败：' + ((data && data.error) || ('HTTP ' + r.status)));
      return;
    }
    toast('会议纪要已生成：' + data.path);
  } catch (e) {
    toast('会议总结失败：本机服务未连接');
  }
}

/** 过长的短语在面板里截断显示，避免把浮层撑宽 */
function clipText(s, n = 20) {
  const t = String(s || '');
  return t.length > n ? t.slice(0, n) + '…' : t;
}

/**
 * 执行快捷短语：把预设文本粘贴到光标处并回车发出去。
 * 不论「自动粘贴」开关是否开着都照发——说这句话的意图就是发出去，不是记下来；
 * 与 enter 动作保持一致（同样不看开关）。
 */
function executeSnippet(text) {
  toast(`发送短语：${clipText(text, 24)}`);
  void pasteToCursor(text, true);
}

/** 执行动作指令，命中返回 true */
function runActionCommand(action, phrase) {
  if (!action) return false;
  if (action === 'enter') {          // 保留老路：/key/enter 是个已经写进文档的接口
    void executeEnter();
    return true;
  }
  if (action === 'meeting_summary') {
    void executeMeetingSummary();
    return true;
  }
  // 其余全当按键表达式（含老表里的 arrow_down / arrow_up，服务端会翻译）
  void executeKey(action);
  return true;
}

/** 等待应用窗口和搜索框完成切换 */
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const searchSubmitDelay = app => /钉钉|dingtalk/i.test(String(app || '')) ? 1000 : 300;

/** 执行“打开应用 → ⌘F → 输入搜索词 → 回车”的复合口令 */
async function executeAppSearchCommand({ app, alias, query }) {
  toast(`正在打开${alias}并搜索“${query}”…`);
  if (!await activate(app, alias, { notify: false })) return;
  await wait(700);
  if (!await executeKey('Meta+KeyF', { notify: false })) return;
  await wait(250);
  pasteToCursor(query, false);
  await wait(searchSubmitDelay(app));
  await executeKey('Enter', { notify: false });
  toast(`已在${alias}中搜索“${query}”`);
}

/** 执行选中文字的 AI 操作，并替换原选区 */
async function executeSelectionAiCommand({ action }) {
  const invoke = window.__TAURI__?.core?.invoke;
  if (!invoke) {
    toast('选区 AI 操作仅支持桌面版');
    return;
  }
  const { baseUrl, model } = state.aiConfig;
  if (!baseUrl || !model) {
    toast('请先在设置中配置 AI 服务');
    return;
  }

  toast('正在读取选中文字…');
  let selected;
  try {
    selected = await invoke('read_selected_text');
  } catch (error) {
    console.error('[command] 读取选区失败:', error);
    toast('读取选中文字失败，请检查辅助功能权限');
    return;
  }
  if (!selected || !selected.trim()) {
    toast('没有识别到选中的文字');
    return;
  }

  toast('正在翻译选中文字…');
  try {
    const response = await fetch(apiUrl('/api/llm/chat'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        baseUrl,
        apiKey: state.aiConfig.apiKey || '',
        model,
        messages: [
          {
            role: 'system',
            content: '你是一个翻译工具。若原文主要是中文，翻译成自然、准确的英文；否则翻译成自然、准确的中文。只输出译文，不要解释、不要加引号、不要加标题。',
          },
          { role: 'user', content: selected },
        ],
        maxTokens: 4096,
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok || !data.data) {
      toast('翻译失败：AI 服务未返回结果');
      return;
    }
    const result = data.data.choices?.[0]?.message?.content?.trim();
    if (!result) {
      toast('翻译失败：AI 返回内容为空');
      return;
    }
    pasteToCursor(result, false);
    toast('已翻译并替换选中文字');
  } catch (error) {
    console.error('[command] 选区翻译失败:', error);
    toast('翻译失败：' + (error.message || 'AI 服务未连接'));
  }
}

/** 执行“当前前台应用 → ⌘F → 输入搜索词 → 回车” */
async function executeCurrentAppSearchCommand({ query }) {
  const app = await getFrontmostApp();
  if (!app) {
    toast('没有识别到当前应用，未执行搜索');
    return;
  }
  toast(`正在${app}中搜索“${query}”…`);
  if (!await executeKey('Meta+KeyF', { notify: false })) return;
  await wait(250);
  pasteToCursor(query, false);
  await wait(searchSubmitDelay(app));
  await executeKey('Enter', { notify: false });
  toast(`已在${app}中搜索“${query}”`);
}

/**
 * 同步快速路径：动作指令（发送/回车）+ 打开应用别名。
 * 命中即执行并返回 true（该句被消费，不再当普通文本输出）。
 */
export function tryHandleSpecialCommand(text) {
  const selectionAi = parseSelectionAiCommand(text);
  if (selectionAi) {
    void executeSelectionAiCommand(selectionAi);
    return true;
  }

  const appSearch = parseAppSearchCommand(text);
  if (appSearch) {
    void executeAppSearchCommand(appSearch);
    return true;
  }
  const currentAppSearch = parseCurrentAppSearchCommand(text);
  if (currentAppSearch) {
    void executeCurrentAppSearchCommand(currentAppSearch);
    return true;
  }

  // 1) 动作指令：整句精确匹配 actions 表（如「发送」→ enter、「总结会议」→ meeting_summary）
  const phrase = normalizePhrase(text);
  if (phrase && phrase.length <= 20) {
    const action = actionCache[phrase];
    if (action && runActionCommand(action, phrase)) return true;
  }

  // 1.5) 快捷短语：整句匹配 → 把预设那段话粘贴并发送（如「推送一下」）
  if (phrase && snippetCache[phrase]) {
    executeSnippet(snippetCache[phrase]);
    return true;
  }

  // 2) 打开应用："打开/启动/开启 + 别名"
  const alias = parseAppCommand(text);
  if (!alias) return false;
  const app = commandCache[alias] || commandCache[alias.toLowerCase()];
  if (app) {
    void activate(app, alias);
    return true;
  }
  return false;
}

/**
 * 异步完善指令：本地未命中时，若已配置 AI 服务商，让 LLM 判定该句
 * 是否是「打开应用」指令，命中则执行并回写学习映射（下次直接命中）。
 * 不阻塞、不吞文本——判定结果只影响后续同款说法的处理。
 */
export async function learnSpecialCommand(text) {
  if (parseSelectionAiCommand(text) || parseAppSearchCommand(text) || parseCurrentAppSearchCommand(text)) return;
  const alias = parseAppCommand(text);
  const isMeetingPhrase = MEETING_SUMMARY_RE.test(text);
  if (!alias && !isMeetingPhrase) return;

  // 1) 会议总结：关键词直接命中，不调 LLM（避免误判吃句，词规则见 MEETING_SUMMARY_RE）
  if (isMeetingPhrase) {
    const phrase = normalizePhrase(text);
    // 学习回写：同款说法下次走同步路径直接命中
    if (phrase && phrase.length <= 20 && !actionCache[phrase]) {
      actionCache[phrase] = 'meeting_summary';
      await persistCommandEntry('actions', phrase, 'meeting_summary');
      console.log(`[command] 学习会议总结: "${phrase}"`);
    }
    void executeMeetingSummary();
    return;
  }

  const { baseUrl, model } = state.aiConfig;
  if (!baseUrl || !model) return; // 未配 AI 服务商，跳过学习

  try {
    const response = await fetch(apiUrl('/api/llm/chat'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        baseUrl,
        apiKey: state.aiConfig.apiKey || '',
        model,
        messages: [
          {
            role: 'system',
            content: '你是应用启动指令解析器。判断用户口述是否是「打开/启动某个应用」的指令。' +
              '是则只输出 JSON: {"action":"open_app","app":"应用英文名，如 WeChat"}；' +
              '否则只输出 {}。不要输出其他任何内容。',
          },
          { role: 'user', content: text },
        ],
        maxTokens: 32,
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok || !data.data) return;
    const content = (data.data.choices && data.data.choices[0] && data.data.choices[0].message && data.data.choices[0].message.content) || '';
    const parsed = (() => {
      try { return JSON.parse(content); } catch { return {}; }
    })();
    if (parsed && parsed.action === 'open_app' && typeof parsed.app === 'string' && parsed.app.trim()) {
      const app = parsed.app.trim();
      // 学习回写：后续同款说法直接命中，不再调 LLM（写 commands.json）
      if (!commandCache[alias] && !commandCache[alias.toLowerCase()]) {
        commandCache[alias] = app;
        await persistCommandEntry('aliases', alias, app);
        console.log(`[command] LLM 学习: "${alias}" → ${app}`);
      }
      const ok = await activate(app, alias);
      if (ok) toast(`已识别指令并执行：打开${alias}（已记住，下次免解析）`);
    }
  } catch (e) {
    console.error('[command] LLM 指令解析失败:', e.message || e);
  }
}