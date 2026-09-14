import { toast } from './ui.js';
import { state } from './state.js';
import { fetchLocalConfig } from './storage.js';
import { apiUrl } from './api.js';

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
let loaded = false;

/** 读取指令映射：/api/commands（含内置默认，首次自动落盘） + 兼容旧 settings.commandAliases */
async function loadCommandMap() {
  let map = {};
  let actions = {};
  try {
    const r = await fetch(apiUrl('/api/commands'));
    const data = await r.json().catch(() => ({}));
    if (data && data.aliases && typeof data.aliases === 'object') map = { ...data.aliases };
    if (data && data.actions && typeof data.actions === 'object') actions = { ...data.actions };
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
  return { aliases: map, actions };
}

/** 写回 commands.json（PUT /api/commands） */
async function persistCommandMap(map) {
  try {
    const r = await fetch(apiUrl('/api/commands'), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: 1, aliases: map, actions: actionCache }),
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
  } catch (e) {
    console.error('[command] 指令表保存失败:', e.message || e);
  }
}

/** 启动时预载指令映射（放入内存同步表） */
export async function initLearnedCommands() {
  const { aliases, actions } = await loadCommandMap();
  commandCache = aliases;
  actionCache = actions;
  loaded = true;
  console.log(`[command] 指令表已加载 ${Object.keys(commandCache).length} 条别名 / ${Object.keys(actionCache).length} 条动作`);
  initCommandMenu();
}

/* ---------------- 语音指令面板（右上角图标入口；测试功能，刻意轻量） ---------------- */

// 动作码 → 人话。未知动作码原样显示，新增动作时面板不会失真
const ACTION_LABELS = { enter: '按下回车键', meeting_summary: '生成 Markdown 会议纪要' };
let cmdMenuBound = false;

/** 从别名表反推应用展示名：优先取中文说法作主名，其余英文说法作同义词 */
function appDisplay(appId) {
  const keys = Object.keys(commandCache).filter((k) => commandCache[k] === appId);
  const name = keys.find((k) => /[\u4e00-\u9fff]/.test(k)) || keys[0] || appId;
  return { name, rest: keys.filter((k) => k !== name) };
}

/** 用内存里的指令表渲染面板（纯本地，不出网） */
function renderCommandMenu() {
  const box = document.getElementById('cmdMenu');
  if (!box) return;
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const rows = (items) => items.map(([main, rest, act]) =>
    `<div class="cmdRow"><span class="cmdPhrase">${esc(main)}</span>`
    + `<span class="cmdAlias">${esc(rest.join(' / '))}</span>`
    + `<span class="cmdAct">${esc(act)}</span></div>`).join('');

  // 别名按应用归组（保持 commands.json 里的顺序），每组取一个中文说法当主名
  const byApp = new Map();
  for (const [phrase, app] of Object.entries(commandCache)) {
    if (!byApp.has(app)) byApp.set(app, []);
  }
  const appItems = [...byApp.keys()].map((app) => {
    const { name, rest } = appDisplay(app);
    return [name, rest, `打开 ${app}`];
  });

  const byAction = new Map();
  for (const [phrase, action] of Object.entries(actionCache)) {
    if (!byAction.has(action)) byAction.set(action, []);
    byAction.get(action).push(phrase);
  }
  const actItems = [...byAction].map(([action, list]) => {
    const [main, ...rest] = list;
    return [main, rest, ACTION_LABELS[action] || action];
  });

  box.innerHTML = `
    <div class="cmdTitle">语音指令<span class="cmdTag">测试功能</span></div>
    <div class="cmdSec">
      <div class="cmdSecTitle">打开应用</div>
      <div class="cmdHint">说「打开 + 名称」，例：打开微信</div>
      ${rows(appItems)}
    </div>
    <div class="cmdSec">
      <div class="cmdSecTitle">动作</div>
      <div class="cmdHint">整句说完即触发，不用加前缀</div>
      ${rows(actItems)}
    </div>
    <div class="cmdFoot">指令表存在数据目录的 commands.json，可在「设置 → 指令配置文件」里修改</div>`;
}

/** 绑定右上角图标入口：点击开合、点外面/ Esc 关闭 */
function initCommandMenu() {
  const btn = document.getElementById('cmdBtn');
  const menu = document.getElementById('cmdMenu');
  if (!btn || !menu || cmdMenuBound) return;
  cmdMenuBound = true;
  const isOpen = () => !menu.classList.contains('hidden');
  const setOpen = (open) => {
    menu.classList.toggle('hidden', !open);
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (!open) return;
    renderCommandMenu(); // 先用内存表秒开
    // 再后台重读 commands.json：文件被外部改过时，面板能立刻反映最新内容
    void loadCommandMap().then(({ aliases, actions }) => {
      commandCache = aliases;
      actionCache = actions;
      if (isOpen()) renderCommandMenu();
    });
  };
  btn.onclick = (e) => { e.stopPropagation(); setOpen(!isOpen()); };
  document.addEventListener('click', (e) => {
    if (!isOpen()) return;
    if (e.target && e.target.closest && e.target.closest('.cmdWrap')) return;
    setOpen(false);
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && isOpen()) setOpen(false); });
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
function activate(app, label) {
  const invoke = window.__TAURI__?.core?.invoke;
  if (!invoke) {
    toast('应用指令仅支持桌面版');
    return Promise.resolve(false);
  }
  return invoke('activate_app', { app })
    .then(() => { toast(`已打开${label}`); return true; })
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

/** 执行动作指令，命中返回 true */
function runActionCommand(action, phrase) {
  if (action === 'enter') {
    void executeEnter();
    return true;
  }
  if (action === 'meeting_summary') {
    void executeMeetingSummary();
    return true;
  }
  console.warn('[command] 未知动作:', action, '(', phrase, ')');
  return false;
}

/**
 * 同步快速路径：动作指令（发送/回车）+ 打开应用别名。
 * 命中即执行并返回 true（该句被消费，不再当普通文本输出）。
 */
export function tryHandleSpecialCommand(text) {
  // 1) 动作指令：整句精确匹配 actions 表（如「发送」→ enter、「总结会议」→ meeting_summary）
  const phrase = normalizePhrase(text);
  if (phrase && phrase.length <= 20) {
    const action = actionCache[phrase];
    if (action && runActionCommand(action, phrase)) return true;
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
  const alias = parseAppCommand(text);
  const isMeetingPhrase = MEETING_SUMMARY_RE.test(text);
  if (!alias && !isMeetingPhrase) return;

  // 1) 会议总结：关键词直接命中，不调 LLM（避免误判吃句，词规则见 MEETING_SUMMARY_RE）
  if (isMeetingPhrase) {
    const phrase = normalizePhrase(text);
    // 学习回写：同款说法下次走同步路径直接命中
    if (phrase && phrase.length <= 20 && !actionCache[phrase]) {
      actionCache[phrase] = 'meeting_summary';
      await persistCommandMap(commandCache);
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
        await persistCommandMap(commandCache);
        console.log(`[command] LLM 学习: "${alias}" → ${app}`);
      }
      const ok = await activate(app, alias);
      if (ok) toast(`已识别指令并执行：打开${alias}（已记住，下次免解析）`);
    }
  } catch (e) {
    console.error('[command] LLM 指令解析失败:', e.message || e);
  }
}