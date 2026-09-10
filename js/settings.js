import { state, ASR_PRICE, VAD_METER_FULL_SCALE, normalizeEngine, engineLabel } from './state.js';
import { $ } from './ui.js';
import { fetchLocalConfig, saveLocalConfig } from './storage.js';

let costWriteTimer = null;
let settingsWriteTimer = null;

export function renderVADThresholdMarker() {
  const tick = $('levelMeterTick');
  const text = $('levelMeterText');
  const threshold = state.vadThreshold || 0.006;
  if (tick) {
    const pct = Math.min(100, threshold / VAD_METER_FULL_SCALE * 100);
    tick.style.left = pct.toFixed(1) + '%';
  }
  if (text) text.textContent = `0.0000 / ${threshold.toFixed(4)}`;
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
  };
}

function applySettings(config) {
  const s = config.settings || {};
  state.vadThreshold = (s.vadThreshold != null && s.vadThreshold <= 0.05) ? s.vadThreshold : 0.006;
  state.silenceTimeout = s.silenceTimeout || 2000;
  state.gainMultiplier = s.gainMultiplier || 1;
  state.autoPaste = s.autoPaste || false;
  state.autoEnter = s.autoEnter || false;
  state.filterOn = typeof s.filterOn === 'boolean' ? s.filterOn : true;
  state.apiKey = s.key || '';
  state.qwen3ModelDir = typeof s.qwen3ModelDir === 'string' ? s.qwen3ModelDir : '';
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
  const config = await fetchLocalConfig();
  config.totalDuration = state.totalDuration;
  await saveLocalConfig(config);
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
  }, 1000);
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
  btn.title = '当前引擎：' + engineLabel(eng);
}

export async function loadASRSettings() {
  const config = await fetchLocalConfig();
  applySettings(config);
  $('apiKey').value = state.apiKey;
  if ($('qwen3ModelDir')) $('qwen3ModelDir').value = state.qwen3ModelDir;
  if ($('vadThreshold')) {
    $('vadThreshold').value = state.vadThreshold;
    $('vadThresholdLabel').textContent = state.vadThreshold.toFixed(3);
  }
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
  const config = await fetchLocalConfig();
  config.settings = settingsFromState();
  await saveLocalConfig(config);
  const { key, ...publicSettings } = settingsFromState();
  console.log('[settings] saved', JSON.stringify({
    ...publicSettings,
    keyConfigured: !!key,
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
  const sp = $('autoPasteBtn');
  if (sp) sp.classList.toggle('on', state.autoPaste);
  const se = $('autoEnterBtn');
  if (se) se.classList.toggle('on', state.autoEnter);
  const ff = $('filterToggle');
  if (ff) ff.classList.toggle('on', state.filterOn);
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
    ws = new WebSocket('ws://127.0.0.1:8931');
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
    finish(false, '无法连接本地代理服务（ws://127.0.0.1:8931），请确认服务已启动');
  };
  ws.onclose = () => {
    finish(false, '连接被关闭：请检查 API Key 或稍后重试');
  };
}
