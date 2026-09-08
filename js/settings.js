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
  const sel = $('engineBadge');
  if (!sel) return;
  sel.value = eng;
  const optBailian = sel.querySelector('option[value="bailian"]');
  if (optBailian) {
    optBailian.textContent = isBailian ? '百炼 · ' + formatCost(state.totalDuration) : '百炼';
  }
  sel.className = isBailian ? 'bailian' : '';
  sel.title = '当前引擎：' + engineLabel(eng);
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
  $('asrStatus').textContent = '已切换至 ' + engineLabel(state.asrEngine) + ' 引擎';
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
