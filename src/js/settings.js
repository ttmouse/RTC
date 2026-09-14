import { state, ASR_PRICE, rmsToMeterPct, clampVADThreshold, normalizeEngine, engineLabel } from './state.js';
import { $ } from './ui.js';
import { fetchLocalConfig, patchLocalConfig } from './storage.js';
import { apiUrl, wsProxyUrl } from './api.js';

let costWriteTimer = null;
let settingsWriteTimer = null;

export function renderVADThresholdMarker() {
  const tick = $('levelMeterTick');
  const text = $('levelMeterText');
  const threshold = state.vadThreshold || 0.006;
  if (tick) {
    const pct = rmsToMeterPct(threshold);
    tick.style.left = pct.toFixed(1) + '%';
  }
  if (text) text.textContent = `0.0000 / ${threshold.toFixed(4)}`;
}

// OpenAI 兼容服务商预设（选预设自动填 baseUrl/model，也可切「自定义」手动填）
export const AI_PROVIDERS = {
  openai:   { name: 'OpenAI',          baseUrl: 'https://api.openai.com/v1',                model: 'gpt-4o-mini' },
  deepseek: { name: 'DeepSeek',        baseUrl: 'https://api.deepseek.com/v1',               model: 'deepseek-chat' },
  kimi:     { name: 'Kimi · Moonshot', baseUrl: 'https://api.moonshot.cn/v1',                model: 'moonshot-v1-8k' },
  zhipu:    { name: '智谱 GLM',        baseUrl: 'https://open.bigmodel.cn/api/paas/v4',      model: 'glm-4-flash' },
  silicon:  { name: '硅基流动',        baseUrl: 'https://api.siliconflow.cn/v1',             model: 'Qwen/Qwen2.5-7B-Instruct' },
  // OpenCode Zen Go 网关：baseUrl 不要带 /chat/completions，由后端 chatEndpoint 统一拼接。
  // 该网关强制要求 x-opencode-session 请求头，由后端 providerHeaders() 按主机名自动附加。
  opencode: { name: 'OpenCode Zen Go', baseUrl: 'https://opencode.ai/zen/go/v1',             model: 'deepseek-v4.1-flash' },
  ollama:   { name: 'Ollama（本地）',   baseUrl: 'http://localhost:11434/v1',               model: 'qwen2.5' },
  custom:   { name: '自定义',          baseUrl: '',                                           model: '' },
};

export function aiProviderLabel(key) {
  return (AI_PROVIDERS[key] && AI_PROVIDERS[key].name) || '自定义';
}

function settingsFromState() {
  return {
    key: state.apiKey,
    engine: state.asrEngine,
    qwen3ModelDir: state.qwen3ModelDir,
    vadThreshold: state.vadThreshold,
    silenceTimeout: state.silenceTimeout,
    gainMultiplier: state.gainMultiplier,
    autoPaste: state.autoPaste,
    autoEnter: state.autoEnter,
    filterOn: state.filterOn,
    sfx: state.sfxOn,
    ai: { ...state.aiConfig },
  };
}

function applySettings(config) {
  const s = config.settings || {};
  state.vadThreshold = s.vadThreshold != null ? clampVADThreshold(s.vadThreshold) : 0.006;
  state.silenceTimeout = s.silenceTimeout || 2000;
  state.gainMultiplier = s.gainMultiplier || 1;
  state.autoPaste = s.autoPaste || false;
  state.autoEnter = s.autoEnter || false;
  state.sfxOn = s.sfx !== false;   // 旧配置无此字段 → 默认开启
  state.filterOn = typeof s.filterOn === 'boolean' ? s.filterOn : true;
  state.apiKey = s.key || '';
  state.qwen3ModelDir = typeof s.qwen3ModelDir === 'string' ? s.qwen3ModelDir : '';
  // AI 服务商配置（兼容缺失/旧结构）
  const ai = (s.ai && typeof s.ai === 'object') ? s.ai : {};
  const provider = AI_PROVIDERS[ai.provider] ? ai.provider : 'custom';
  state.aiConfig = {
    provider,
    baseUrl: typeof ai.baseUrl === 'string' ? ai.baseUrl : (AI_PROVIDERS[provider].baseUrl || ''),
    apiKey: typeof ai.apiKey === 'string' ? ai.apiKey : '',
    model: typeof ai.model === 'string' ? ai.model : (AI_PROVIDERS[provider].model || ''),
  };
  // 兼容旧配置：'local' → sensevoice；bailian 无 key 回落 sensevoice
  let eng = normalizeEngine(s.engine || 'sensevoice');
  if (eng === 'bailian' && !state.apiKey) eng = 'sensevoice';
  state.asrEngine = eng;
}

export async function loadTotalDuration() {
  const config = await fetchLocalConfig();
  state.totalDuration = Number(config.totalDuration) || 0;
}

async function persistTotalDuration() {
  // 只写自己这一个字段：录音中这个函数每秒跑一次，旧写法会把整份 config
  // （含 API Key）重写一遍，并且会用陈旧快照覆盖同时刻的其他设置改动。
  await patchLocalConfig({ totalDuration: state.totalDuration });
}

export function saveTotalDuration() {
  if (costWriteTimer) return;
  costWriteTimer = setTimeout(async () => {
    costWriteTimer = null;
    try {
      await persistTotalDuration();
    } catch (e) {
      console.error('[config] duration save failed:', e.message || e);
    }
  }, 5000);
}

export async function flushTotalDuration() {
  if (costWriteTimer) {
    clearTimeout(costWriteTimer);
    costWriteTimer = null;
  }
  try {
    await persistTotalDuration();
  } catch (e) {
    console.error('[config] duration flush failed:', e.message || e);
  }
}

export function formatCost(seconds) {
  const cost = seconds * ASR_PRICE;
  if (cost < 0.01) return (cost * 100).toFixed(2) + ' 分';
  return cost.toFixed(4) + ' 元';
}

export function updateEngineBadge() {
  const eng = normalizeEngine(state.asrEngine);
  if (state.asrEngine !== eng) state.asrEngine = eng;  // 一次性迁移旧值
  const isBailian = eng === 'bailian' && state.apiKey;
  // 设置页的引擎选中态与主界面药丸共用同一份状态，必须一起刷新，否则两处会不一致
  syncEnginePick(eng);
  const btn = $('engineBadge');
  if (!btn) return;
  const textEl = $('engineBadgeText');
  if (textEl) textEl.textContent = engineLabel(eng) + (isBailian ? ' · ' + formatCost(state.totalDuration) : '');
  const optBailian = document.querySelector('.engineOption[data-engine="bailian"] .optLabel');
  if (optBailian) optBailian.textContent = '百炼' + (isBailian ? ' · ' + formatCost(state.totalDuration) : '');
  document.querySelectorAll('.engineOption').forEach(o => {
    o.classList.toggle('on', o.dataset.engine === eng);
  });
  btn.classList.toggle('bailian', isBailian);
  // 不再设 title：按钮上已经写着引擎名，tooltip 只会复述一遍
}

/**
 * 同步设置页「识别方式」区的「使用中」标记与拾音参数显隐。
 * 设置面板不做引擎切换（切换只在主界面底栏），所以这里不写任何选中/可选中状态，
 * 只负责标出当前正在用哪个引擎；每个选项的配置由点击表头自行展开收起。
 * 只由 updateEngineBadge() 调用，保证标记只有一处写入点。
 */
function syncEnginePick(eng) {
  const heads = document.querySelectorAll('#settingsPage .pickHead');
  if (!heads.length) return;
  heads.forEach((head) => {
    const on = head.dataset.engine === eng;
    head.classList.toggle('on', on);
    // 左侧竖脊的染色跟着走。不用 :has() 是因为 Tauri 最低支持到 macOS 10.15，
    // 那里的 WKWebView 还不认这个选择器，会退化成「当前引擎认不出来」。
    const card = head.closest('.pick');
    if (card) card.classList.toggle('on', on);
  });
  // 拾音参数只有本地引擎才用得到
  const tuning = $('localTuningPanel');
  if (tuning) tuning.classList.toggle('hidden', eng === 'bailian');
  updateEngineStates(eng);
}

/** 各引擎选项右侧的状态标记：使用中 / 已就绪 / 未下载 / 未配置 */
function updateEngineStates(eng) {
  // 「使用中」只在这里加一次（上游传进来的是纯状态，不含该标记）
  const rows = [
    ['bailian', 'bailianState', state.apiKey ? '已配置' : '未配置 Key'],
    ['sensevoice', 'sensevoiceState', modelStateText('sensevoice')],
    ['qwen3', 'qwen3State', modelStateText('qwen3')],
  ];
  rows.forEach(([key, id, raw]) => {
    const el = $(id);
    if (!el) return;
    const text = raw || '';
    el.textContent = eng === key ? (text ? `使用中 · ${text}` : '使用中') : text;
    // error 态用红色（如下载失败、模型服务未启动）
    el.classList.toggle('pickStateErr', modelStateMode[key] === 'error');
  });
}

// 各引擎状态文案与是否处于错误态。文案由 model.js 喂入，settings.js 只负责渲染。
const modelState = {};
const modelStateMode = {};
function modelStateText(model) {
  return modelState[model] || '';
}

/**
 * model.js 拿到本地模型状态后回填。
 * states: { [engine]: '已就绪 · 228 MB' }，mode: { [engine]: 'error' }。
 */
export function refreshModelStateLabels(states = {}, modes = {}) {
  Object.assign(modelState, states);
  Object.assign(modelStateMode, modes);
  updateEngineStates(normalizeEngine(state.asrEngine));
}

export async function loadASRSettings() {
  const config = await fetchLocalConfig();
  applySettings(config);
  $('apiKey').value = state.apiKey;
  if ($('qwen3ModelDir')) $('qwen3ModelDir').value = state.qwen3ModelDir;
  syncAIForm();
  if ($('silenceTimeout')) {
    $('silenceTimeout').value = state.silenceTimeout;
    $('silenceTimeoutLabel').textContent = state.silenceTimeout + 'ms';
  }
  if ($('gainMultiplier')) {
    $('gainMultiplier').value = state.gainMultiplier;
    $('gainMultiplierLabel').textContent = state.gainMultiplier + 'x';
  }
  syncToggleUI();
  updateEngineBadge();
  renderVADThresholdMarker();
}

async function saveASRSettingsNow() {
  // 只写 settings 字段，其余字段（totalDuration / correctionRules 等）交给各自的写入者，
  // 互不覆盖（见 storage.js patchLocalConfig 注释）
  await patchLocalConfig({ settings: settingsFromState() });
  const { key, ai, ...publicSettings } = settingsFromState();
  const { apiKey: aiKey, ...publicAI } = ai || {};
  console.log('[settings] saved', JSON.stringify({
    ...publicSettings,
    keyConfigured: !!key,
    ai: { ...publicAI, apiKeyConfigured: !!aiKey },
  }));
}

export function saveASRSettings() {
  if (settingsWriteTimer) clearTimeout(settingsWriteTimer);
  settingsWriteTimer = setTimeout(async () => {
    settingsWriteTimer = null;
    try {
      await saveASRSettingsNow();
    } catch (e) {
      console.error('[config] settings save failed:', e.message || e);
    }
  }, 250);
}

export async function flushASRSettings() {
  if (settingsWriteTimer) {
    clearTimeout(settingsWriteTimer);
    settingsWriteTimer = null;
  }
  try {
    await saveASRSettingsNow();
  } catch (e) {
    console.error('[config] settings flush failed:', e.message || e);
  }
}

export function syncToggleUI() {
  const fp = $('ftPaste');
  if (fp) fp.classList.toggle('on', state.autoPaste);
  const fe = $('ftEnter');
  if (fe) fe.classList.toggle('on', state.autoEnter);
}

// ---------- 设置分组折叠 ----------

// 通用折叠组登记表：每组的 head/body/summary id，以及摘要生成方式
//   summary: 'text'  → 取状态文案元素的 textContent（如 0.006 / 3 条规则）
//   summary: 'paste' → 拼接多个状态文案
//   summary: fn      → 自定义生成
//   dataKey          → 该组没有独立状态文案，但文案变化时由上游调
//                      refreshGroupSummaries({ [dataKey]: '新文案' }) 显式喂入
export const COLLAPSIBLE_GROUPS = {
  ai:      { head: 'aiGroupHead',      body: 'aiGroupBody',      sum: 'aiGroupSummary', dataKey: 'ai' },
  storage: { head: 'storageGroupHead', body: 'storageGroupBody', sum: 'storageGroupSummary', dataKey: 'storage' },
};

// 没有存过偏好时的默认展开状态：核心配置与最常用的两项保持展开
const EXPANDED_BY_DEFAULT = new Set(['ai', 'local', 'storage']);
const GROUPS_STORE_KEY = 'rtc_settings_group_open';

/** 读取折叠偏好；未存过 / 存储不可用 → null，由调用方回落到默认展开状态 */
function readGroupPrefs() {
  try {
    const raw = localStorage.getItem(GROUPS_STORE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === 'object') ? parsed : null;
  } catch {
    return null;
  }
}

function writeGroupPref(key, open) {
  try {
    const prefs = readGroupPrefs() || {};
    prefs[key] = open;
    localStorage.setItem(GROUPS_STORE_KEY, JSON.stringify(prefs));
  } catch {
    /* localStorage 不可用（隐私模式 / 文件协议）：折叠仍可用，只是不记忆 */
  }
}

export function isGroupOpen(key) {
  const prefs = readGroupPrefs();
  if (prefs && typeof prefs[key] === 'boolean') return prefs[key];
  return EXPANDED_BY_DEFAULT.has(key);
}

/**
 * 展开/收起一个分组。
 * 传 open=null 表示只刷新 UI、不写入偏好（初始化时用）。
 */
export function toggleGroup(key, open = null, { persist = true } = {}) {
  const cfg = COLLAPSIBLE_GROUPS[key];
  if (!cfg || !cfg.head || !cfg.body) return;
  const head = $(cfg.head);
  const body = $(cfg.body);
  if (!head || !body) return;
  const next = open === null ? head.getAttribute('aria-expanded') !== 'true' : !!open;
  head.setAttribute('aria-expanded', next ? 'true' : 'false');
  body.classList.toggle('hidden', !next);
  if (persist) writeGroupPref(key, next);
  updateGroupSummary(key);
}

// 数据源型分组的文案缓存：由其他模块通过 refreshGroupSummaries(overrides) 喂入。
// 单独存一份的原因：切换折叠状态时要重算摘要，不能去读已经渲染进标题行的文本。
const summaryValues = {};

/**
 * 刷新分组标题行右侧的摘要。
 * overrides（可选）：{ [dataKey]: '文案' }，用于刷新由其他模块产生的文案
 * （本地模型状态、存储路径、更新状态）。
 * 标题行在展开时隐藏摘要，所以展开态下直接跳过。
 */
export function refreshGroupSummaries(overrides = {}) {
  Object.assign(summaryValues, overrides);
  for (const key of Object.keys(COLLAPSIBLE_GROUPS)) updateGroupSummary(key);
}

function updateGroupSummary(key) {
  const cfg = COLLAPSIBLE_GROUPS[key];
  if (!cfg || !cfg.sum) return;
  const head = cfg.head ? $(cfg.head) : null;
  const el = $(cfg.sum);
  if (!el) return;
  // 展开时标题行已有完整内容，摘要没有意义
  if (head && head.getAttribute('aria-expanded') === 'true') {
    el.textContent = '';
    return;
  }
  let text = '';
  const spec = cfg.summary;
  if (typeof spec === 'function') {
    text = spec();
  } else if (spec && spec.el) {
    const src = $(spec.el);
    text = src ? src.textContent.trim() : '';
  } else if (spec && spec.els) {
    text = spec.els
      .map(id => { const src = $(id); return src ? src.textContent.trim() : ''; })
      .filter(Boolean).join(' · ');
  } else if (cfg.dataKey) {
    text = summaryValues[cfg.dataKey] || '';
  }
  // 折叠态下若还没有状态文案，保留占位而不是显示空白标题行
  el.textContent = text || '点击展开';
}

/** 同步所有分组折叠状态（打开设置页 / 初始化时调用；不覆盖已存偏好） */
export function syncCollapsibleGroups() {
  for (const key of Object.keys(COLLAPSIBLE_GROUPS)) {
    toggleGroup(key, isGroupOpen(key), { persist: false });
  }
}

// ---------- AI 服务商表单同步与测试连接 ----------

/** AI 服务商分组的展开/收起（保留旧入口，语义等同 toggleGroup('ai')） */
export function setAIGroupOpen(open) {
  toggleGroup('ai', open);
}

/** 摘要仅在收起时有意义：显示当前服务商 · 模型 */
export function updateAIGroupSummary() {
  const { provider, model } = state.aiConfig;
  summaryValues.ai = aiProviderLabel(provider) + ' · ' + (model || '未配置模型');
  updateGroupSummary('ai');
}

/** 把 state.aiConfig 同步到设置页表单（打开设置 / 加载设置时调用） */
export function syncAIForm() {
  const sel = $('aiProvider');
  const base = $('aiBaseUrl');
  const key = $('aiApiKey');
  const model = $('aiModel');
  if (!sel || !base || !key || !model) return;
  sel.value = state.aiConfig.provider;
  base.value = state.aiConfig.baseUrl;
  key.value = state.aiConfig.apiKey;
  model.value = state.aiConfig.model;
  updateAIGroupSummary();
}

/** 读表单 → state.aiConfig；provider=custom 时 baseUrl/model 以输入为准 */
export function readAIForm() {
  const sel = $('aiProvider');
  const base = $('aiBaseUrl');
  const key = $('aiApiKey');
  const model = $('aiModel');
  if (!sel || !base || !key || !model) return;
  state.aiConfig.provider = sel.value;
  state.aiConfig.baseUrl = base.value.trim();
  state.aiConfig.apiKey = key.value.trim();
  state.aiConfig.model = model.value.trim();
  updateAIGroupSummary();
}

/** 当前 AI 配置是否完整可用 */
export function aiConfigReady() {
  return !!(state.aiConfig.baseUrl && state.aiConfig.model);
}

function prettifyAIError(raw) {
  const msg = String(raw || '');
  const code = (msg.match(/\b4\d{2}\b/) || [])[0];
  if (code === '401' || code === '403') return 'API Key 无效（HTTP ' + code + '），请检查 Key 是否正确';
  if (code === '404') return '接口或模型不存在（HTTP 404）：请检查 API 地址是否以 /v1 结尾、模型名是否正确';
  if (msg.startsWith('无法连接') || msg.startsWith('连接超时')) return msg;
  return msg.slice(0, 160);
}

/**
 * 测试自定义服务商连通性：走本地代理 POST /api/llm/chat，
 * 请求一条最小消息（max_tokens=1），不产生实质推理成本。
 */
export function testAIConnection() {
  const btn = $('aiTestBtn');
  const status = $('aiTestStatus');
  readAIForm();
  const { baseUrl, apiKey, model } = state.aiConfig;
  if (!baseUrl || !model) {
    if (status) { status.textContent = '请先填写 API 地址与模型名'; status.className = 'key-test-status err'; }
    return;
  }
  if (btn) { btn.disabled = true; btn.textContent = '测试中…'; }
  if (status) { status.textContent = '正在连接 ' + aiProviderLabel(state.aiConfig.provider) + '…'; status.className = 'key-test-status'; }

  const done = (ok, msg) => {
    if (btn) { btn.disabled = false; btn.textContent = '测试连接'; }
    if (status) { status.textContent = msg; status.className = 'key-test-status ' + (ok ? 'ok' : 'err'); }
  };

  fetch(apiUrl('/api/llm/chat'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      baseUrl,
      apiKey,
      model,
      messages: [{ role: 'user', content: 'ping' }],
      maxTokens: 1,
    }),
  })
    .then(async r => {
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.ok) {
        done(false, prettifyAIError((data && data.error) || ('HTTP ' + r.status)));
        return;
      }
      const reply = (data.data && data.data.choices && data.data.choices[0] && data.data.choices[0].message && data.data.choices[0].message.content) || '';
      done(true, '连接成功：服务商可正常访问' + (reply ? '（' + String(reply).slice(0, 20) + '）' : ''));
    })
    .catch(err => {
      done(false, prettifyAIError(err && err.message));
    });
}

// ---------- 百炼连接测试 ----------

function prettifyBailianError(raw) {
  const m = String(raw || '');
  const code = (m.match(/\b4\d{2}\b/) || [])[0];
  if (code === '401' || code === '403') return 'API Key 无效（HTTP ' + code + '），请检查 Key 是否正确';
  return m;
}

/**
 * 测试百炼连通性：走与真实录音相同的路径（本地代理 ws://127.0.0.1:8931 → 百炼 WSS），
 * 只建立连接并等待握手回包即关闭，不发送音频、不启动识别任务，因此不产生费用。
 */
export function testBailianConnection() {
  const btn = $('apiKeyTestBtn');
  const status = $('apiKeyTestStatus');
  const key = (($('apiKey') && $('apiKey').value) || '').trim();
  if (!key) {
    if (status) { status.textContent = '请先输入 API Key'; status.className = 'key-test-status err'; }
    return;
  }
  if (btn) { btn.disabled = true; btn.textContent = '测试中…'; }
  if (status) { status.textContent = '正在连接百炼…'; status.className = 'key-test-status'; }

  const done = (ok, msg) => {
    if (btn) { btn.disabled = false; btn.textContent = '测试连接'; }
    if (status) { status.textContent = msg; status.className = 'key-test-status ' + (ok ? 'ok' : 'err'); }
  };

  let finished = false;
  const finish = (ok, msg) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    try { ws.close(); } catch (e) {}
    done(ok, msg);
  };

  const timer = setTimeout(() => finish(false, '连接超时：请检查网络后重试'), 10000);

  let ws;
  try {
    ws = new WebSocket(wsProxyUrl());
  } catch (e) {
    clearTimeout(timer);
    done(false, '无法创建连接：' + (e.message || e));
    return;
  }

  ws.onopen = () => {
    ws.send(JSON.stringify({
      type: 'connect',
      engine: 'bailian',
      url: 'wss://dashscope.aliyuncs.com/api-ws/v1/inference/?api_key=' + encodeURIComponent(key),
    }));
  };
  ws.onmessage = ev => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch (e) { return; }
    if (msg.type === 'connected') {
      finish(true, '连接成功：百炼服务可正常访问');
    } else if (msg.type === 'error') {
      finish(false, prettifyBailianError(msg.message || '连接失败'));
    }
  };
  ws.onerror = () => {
    finish(false, `无法连接本地代理服务（${wsProxyUrl()}），请确认服务已启动`);
  };
  ws.onclose = () => {
    finish(false, '连接被关闭：请检查 API Key 或稍后重试');
  };
}
