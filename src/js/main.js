import { $, setStatus, toast, setRecordBtn, initListAutoScroll } from './ui.js';
import { state, VAD_METER_FULL_SCALE } from './state.js';
import { DEFAULT_RULES, flushCorrectionRules, loadCorrectionRules, saveCorrectionRules } from './correction.js';
import { ensurePastePermission } from './clipboard.js';
import { connectASR, setAsrStopHandler } from './asr.js';
import { getAudioConstraints, startAudio, stopRec } from './audio.js';
import { clearHistory, renderHistory } from './history.js';
import { flushASRSettings, loadASRSettings, saveASRSettings, syncToggleUI, updateEngineBadge, loadTotalDuration, renderVADThresholdMarker, testBailianConnection, syncAIForm, readAIForm, testAIConnection, AI_PROVIDERS } from './settings.js';
import { renderModelStatus, getModelStatus } from './model.js';
import { initLearnedCommands } from './commands.js';
import { migrateLegacyLocalConfig } from './config-migration.js';
import { checkForUpdates, setupUpdateUI, updateVersionBadge } from './updater.js';
import { playStart, playToggle } from './sfx.js';

/**
 * 主界面底部显示本地服务累计运行时长。
 * 启动时从 /api/status 拉取 uptime 基准，之后每秒本地递增；
 * 每 60 秒重新校准一次，服务重启后自动归零重新计时。
 * 服务不可达时显示「服务未连接」，用于判断后端是否正常运行。
 */
function initServerUptime() {
  const el = $('statusTime');
  if (!el) return;
  let uptime = 0;

  const render = () => {
    // 录音中：header 状态区显示本段录音时长（由 recStartTs 计时）；空闲时显示服务运行时长
    const s = state.recording && state.recStartTs
      ? Math.max(0, Math.floor((Date.now() - state.recStartTs) / 1000))
      : Math.max(0, Math.floor(uptime));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    const pad = (n) => String(n).padStart(2, '0');
    el.textContent = h > 0
      ? `${h}:${pad(m)}:${pad(sec)}`
      : `${pad(m)}:${pad(sec)}`;
    if (!state.recording) el.classList.remove('up-offline');
  };

  const fetchUptime = async () => {
    try {
      const res = await fetch('http://127.0.0.1:8931/api/status');
      if (!res.ok) throw new Error(`status ${res.status}`);
      const data = await res.json();
      if (data && typeof data.uptime === 'number') {
        uptime = data.uptime;
        render();
      }
    } catch {
      el.textContent = '服务未连接';
      el.classList.add('up-offline');
    }
  };

  fetchUptime();
  setInterval(() => { uptime += 1; render(); }, 1000);
  setInterval(fetchUptime, 60000);
}

setAsrStopHandler(stopRec);

// ---------- 开关类行为（唯一入口） ----------
// 音效挂在「行为」而不是「按钮点击」上：footer 按钮、设置页开关、⌘⇧V/⌘⇧E、
// Tauri 全局热键 ⌥⌘P 全都走下面这两个函数，新增入口也不会再漏掉提示音。
function setAutoPaste(on) {
  state.autoPaste = on;
  syncToggleUI();
  saveASRSettings();
  playToggle(on);
  if (on) ensurePastePermission();
}

function toggleAutoPaste() {
  setAutoPaste(!state.autoPaste);
}

function setAutoEnter(on) {
  state.autoEnter = on;
  syncToggleUI();
  saveASRSettings();
  playToggle(on);
}

function toggleAutoEnter() {
  setAutoEnter(!state.autoEnter);
}

$('btn').onclick = async () => {
  if (state.recording) {
    state.wantRecording = false;
    stopRec();
    return;
  }
  if (state.asrEngine === 'bailian' && !state.apiKey) {
    toast('请先在设置中配置百炼 API Key');
    return;
  }
  state.wantRecording = true;
  playStart();   // 在 getUserMedia / 建立 WS 之前先响，避免提示音被麦克风录进识别结果
  if (!state.stream) {
    try {
      state.stream = await navigator.mediaDevices.getUserMedia({ audio: getAudioConstraints() });
    } catch (e) {
      toast('无法访问麦克风：' + e.message);
      state.wantRecording = false;
      return;
    }
  }
  state.sentCount = 0;
  if ($('count')) $('count').textContent = '';
  state.recording = true;
  state.recStartTs = Date.now();
  setRecordBtn(true);
  $('btn').className = 'on';
  setStatus('录音中', true);
  try {
    await startAudio();
    state.pendingLine = null;
    state.finalizedText = '';
    state.silenceChunks = 0;
    state.vadState = 'silent';
    state.vadSilenceCount = 0;
    state.vadHeartbeat = 0;
    state.vadBuf.length = 0;
    connectASR();
  } catch (e) {
    console.error('[start]', e);
    toast('启动录音失败: ' + e.message);
    state.wantRecording = false;
    state.recording = false;
    setRecordBtn(false);
    $('btn').className = '';
    setStatus('就绪', false);
    try { if (state.stream) state.stream.getTracks().forEach(t => t.stop()); } catch (ex) {}
    state.stream = null;
  }
};

$('filterToggle').onclick = () => {
  state.filterOn = !state.filterOn;
  syncToggleUI();
  saveASRSettings();
  if (state.recording) {
    stopRec();
    state.stream = null;
    $('btn').onclick();
  }
};

const sfxToggle = $('sfxToggle');
if (sfxToggle) sfxToggle.onclick = () => {
  state.sfxOn = !state.sfxOn;
  syncToggleUI();
  saveASRSettings();
  playToggle(state.sfxOn);   // 开启时立刻让用户听到效果（关闭时静默）
};

function showSettings(show) {
  $('settingsPage').classList.toggle('hidden', !show);
  $('queryBar').style.display = show ? 'none' : '';
  $('list').style.display = show ? 'none' : '';
  document.querySelector('footer').style.display = show ? 'none' : '';
  if (show) {
    renderModelStatus();
    syncAIForm();
    loadStorageInfo();
  }
}

$('settingsBtn').onclick = () => showSettings(true);
$('settingsClose').onclick = () => showSettings(false);
$('settingsSaveBtn').onclick = async () => {
  state.apiKey = $('apiKey').value.trim();
  if (state.asrEngine === 'bailian' && !state.apiKey) {
    state.asrEngine = 'sensevoice';
    updateEngineBadge();
  }
  readAIForm();
  saveASRSettings();
  saveCorrectionRules($('correctionRules').value);
  await flushASRSettings();
  await flushCorrectionRules();
  renderVADThresholdMarker();
  showSettings(false);
};
$('settingsCancelBtn').onclick = () => showSettings(false);
$('settingsResetBtn').onclick = async () => {
  state.asrEngine = 'sensevoice';
  state.apiKey = '';
  $('apiKey').value = '';
  setKeyVisible(false);
  const testStatus = $('apiKeyTestStatus');
  if (testStatus) { testStatus.textContent = ''; testStatus.className = 'key-test-status'; }
  state.vadThreshold = 0.006;
  $('vadThreshold').value = 0.006;
  $('vadThresholdLabel').textContent = '0.006';
  state.silenceTimeout = 2000;
  $('silenceTimeout').value = 2000;
  $('silenceTimeoutLabel').textContent = '2000ms';
  state.gainMultiplier = 1;
  $('gainMultiplier').value = 1;
  $('gainMultiplierLabel').textContent = '1x';
  state.autoPaste = false;
  state.autoEnter = false;
  state.filterOn = true;
  // AI 服务商恢复默认（自定义：清空；预设：保留预设值）
  const prevProvider = state.aiConfig.provider;
  const defaults = AI_PROVIDERS[prevProvider] ? AI_PROVIDERS[prevProvider] : AI_PROVIDERS.custom;
  state.aiConfig = {
    provider: prevProvider,
    baseUrl: defaults.baseUrl || '',
    apiKey: '',
    model: defaults.model || '',
  };
  const aiTestStatus = $('aiTestStatus');
  if (aiTestStatus) { aiTestStatus.textContent = ''; aiTestStatus.className = 'key-test-status'; }
  syncAIForm();
  syncToggleUI();
  updateEngineBadge();
  $('correctionRules').value = DEFAULT_RULES;
  saveCorrectionRules(DEFAULT_RULES);
  saveASRSettings();
  await flushCorrectionRules();
  await flushASRSettings();
  renderVADThresholdMarker();
};

document.addEventListener('mouseup', () => {
  const sel = window.getSelection();
  const text = sel && !sel.isCollapsed ? sel.toString().trim() : '';
  if (!text) return;
  navigator.clipboard.writeText(text).catch(() => {});
});

$('list').addEventListener('click', e => {
  const sel = window.getSelection();
  if (sel && !sel.isCollapsed) return;
  const line = e.target.closest('.line');
  if (!line) return;
  const txt = line.querySelector('.txt');
  if (!txt) return;
  const text = txt.textContent.trim();
  if (!text) return;
  navigator.clipboard.writeText(text).then(() => {
    line.style.transition = 'background .15s';
    line.style.background = 'rgba(191,58,30,.08)';
    setTimeout(() => { line.style.background = ''; }, 400);
  }).catch(() => {});
});

function changeEngine(next) {
  state.apiKey = $('apiKey').value.trim();
  if (next === state.asrEngine) return;
  if (next === 'bailian' && !state.apiKey) {
    toast('请先在设置中配置百炼 API Key');
    updateEngineBadge();
    return;
  }
  state.asrEngine = next;
  playToggle(true);
  saveASRSettings();
  updateEngineBadge();
  if (state.recording) {
    stopRec();
    state.stream = null;
    $('btn').onclick();
  }
}

// 自定义引擎下拉（不使用浏览器原生 select，避免 WKWebView 弹出层闪烁/抖动）
function refreshEngineMenuAvailability() {
  // 百炼：未配置 API Key 则不显示
  const optB = $('optBailian');
  if (optB) optB.classList.toggle('hidden', !state.apiKey);
  // Qwen3：模型未下载则不显示（异步查询本地模型状态）
  const optQ = $('optQwen3');
  if (optQ) {
    getModelStatus()
      .then(st => {
        const ok = st && !st.error && st.qwen3 && st.qwen3.exists;
        optQ.classList.toggle('hidden', !ok);
      })
      .catch(() => { /* 模型服务不可达时保持现状 */ });
  }
}

(function initEngineMenu() {
  const btn = $('engineBadge');
  const menu = $('engineMenu');
  if (!btn || !menu) return;
  btn.onclick = e => {
    e.stopPropagation();
    const opening = menu.classList.contains('hidden');
    menu.classList.toggle('hidden');
    if (opening) refreshEngineMenuAvailability();
  };
  document.addEventListener('click', e => {
    if (!menu.classList.contains('hidden') && !(e.target && e.target.closest && e.target.closest('.engineWrap'))) {
      menu.classList.add('hidden');
    }
  });
  menu.querySelectorAll('.engineOption').forEach(o => {
    o.onclick = () => {
      menu.classList.add('hidden');
      changeEngine(o.dataset.engine);
    };
  });
})();
refreshEngineMenuAvailability();

$('vadThreshold').oninput = function () {
  state.vadThreshold = parseFloat(this.value);
  $('vadThresholdLabel').textContent = state.vadThreshold.toFixed(3);
  saveASRSettings();
  renderVADThresholdMarker();
};

// 主界面 VAD 阈值 tick 可拖拽调整灵敏度
(function initVADTickDrag() {
  const bg = $('levelMeterBg');
  if (!bg) return;

  function setThresholdFromClientX(clientX) {
    const r = bg.getBoundingClientRect();
    const ratio = (clientX - r.left) / r.width;
    const clamped = Math.max(0.001, Math.min(0.05, ratio * VAD_METER_FULL_SCALE));
    state.vadThreshold = Math.round(clamped * 1000) / 1000;
    renderVADThresholdMarker();
    if ($('vadThreshold')) {
      $('vadThreshold').value = state.vadThreshold;
      $('vadThresholdLabel').textContent = state.vadThreshold.toFixed(3);
    }
    saveASRSettings();
  }

  bg.style.cursor = 'ew-resize';
  bg.addEventListener('pointerdown', e => {
    bg.setPointerCapture(e.pointerId);
    e.preventDefault();
    setThresholdFromClientX(e.clientX);
  });
  bg.addEventListener('pointermove', e => {
    if (e.buttons & 1) setThresholdFromClientX(e.clientX);
  });
})();

$('apiKey').onchange = () => {
  state.apiKey = $('apiKey').value.trim();
  if (state.asrEngine === 'bailian' && !state.apiKey) {
    state.asrEngine = 'sensevoice';
    updateEngineBadge();
  }
  saveASRSettings();
};

// API Key 明文/密文切换（眼睛图标）
function setKeyVisible(show) {
  const input = $('apiKey');
  const btn = $('apiKeyToggle');
  input.type = show ? 'text' : 'password';
  btn.classList.toggle('showing', show);
  btn.title = show ? '隐藏 API Key' : '显示 API Key';
  btn.setAttribute('aria-label', btn.title);
}
$('apiKeyToggle').onclick = () => {
  setKeyVisible($('apiKey').type === 'password');
  $('apiKey').focus();
};
// 失焦自动切回密文（点击眼睛按钮本身除外，避免闪烁）
$('apiKey').addEventListener('blur', () => {
  if ($('apiKey').type !== 'text') return;
  if (document.activeElement === $('apiKeyToggle')) return;
  setKeyVisible(false);
});
$('apiKeyTestBtn').onclick = testBailianConnection;

// ---------- AI 服务商表单 ----------

// 预设切换：自动填充 baseUrl / 模型名（用户已手填 values 时同样覆盖为预设值）
$('aiProvider').onchange = function () {
  const preset = AI_PROVIDERS[this.value];
  if (!preset) return;
  state.aiConfig.provider = this.value;
  if (preset.baseUrl) $('aiBaseUrl').value = preset.baseUrl;
  if (preset.model) $('aiModel').value = preset.model;
  const st = $('aiTestStatus');
  if (st) { st.textContent = ''; st.className = 'key-test-status'; }
  readAIForm();
  saveASRSettings();
};

$('aiBaseUrl').onchange = () => { readAIForm(); saveASRSettings(); };
$('aiModel').onchange = () => { readAIForm(); saveASRSettings(); };
$('aiApiKey').onchange = () => { readAIForm(); saveASRSettings(); };

// API Key 明文/密文切换（复用百炼的交互）
function setAIKeyVisible(show) {
  const input = $('aiApiKey');
  const btn = $('aiApiKeyToggle');
  input.type = show ? 'text' : 'password';
  btn.classList.toggle('showing', show);
  btn.title = show ? '隐藏 API Key' : '显示 API Key';
  btn.setAttribute('aria-label', btn.title);
}
$('aiApiKeyToggle').onclick = () => {
  setAIKeyVisible($('aiApiKey').type === 'password');
  $('aiApiKey').focus();
};
$('aiApiKey').addEventListener('blur', () => {
  if ($('aiApiKey').type !== 'text') return;
  if (document.activeElement === $('aiApiKeyToggle')) return;
  setAIKeyVisible(false);
});
$('aiTestBtn').onclick = testAIConnection;


$('silenceTimeout').oninput = function () {
  state.silenceTimeout = parseInt(this.value);
  $('silenceTimeoutLabel').textContent = state.silenceTimeout + 'ms';
  saveASRSettings();
};

$('gainMultiplier').oninput = function () {
  state.gainMultiplier = parseFloat(this.value);
  $('gainMultiplierLabel').textContent = state.gainMultiplier + 'x';
  saveASRSettings();
};

$('autoPasteBtn').onclick = () => toggleAutoPaste();

$('autoEnterBtn').onclick = () => toggleAutoEnter();

$('ftPaste').onclick = () => toggleAutoPaste();

$('ftEnter').onclick = () => toggleAutoEnter();

$('corrSave').onclick = async () => {
  saveCorrectionRules($('correctionRules').value);
  await flushCorrectionRules();
  correctionCloseEditor();
};

$('corrReset').onclick = async () => {
  $('correctionRules').value = DEFAULT_RULES;
  saveCorrectionRules(DEFAULT_RULES);
  await flushCorrectionRules();
};

// 搜索框：停止输入 250ms 后重查一次，避免每敲一个字就打一次接口。
// 这里必须判空：dev 模式下改 src/ 会触发热重载，页面有可能拿到「新 JS + 旧 HTML」的
// 中间态；一旦 $('searchInput') 为 null 却不判空，整个模块会在求值阶段抛错，
// 后面的启动流程（含首次 renderHistory）全部不执行，界面就成空列表。
const searchInput = $('searchInput');
let searchTimer = null;
if (searchInput) searchInput.oninput = (e) => {
  state.searchQuery = e.target.value.trim();
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    void renderHistory(true).catch(err => {
      console.error('[transcript] history load failed:', err.message || err);
    });
  }, 250);
};

$('clearDataBtn').onclick = () => {
  if (!confirm('确定清除全部历史记录？该操作不可恢复。')) return;
  clearHistory()
    .then(() => toast('历史记录已清除'))
    .catch(e => toast('清除失败：' + (e.message || e)));
};

$('nukeDataBtn').onclick = () => {
  if (!confirm('确定清除所有数据？历史记录与全部设置都会被删除，且不可恢复。')) return;
  clearHistory()
    .then(() => {
      $('settingsResetBtn').click();
      toast('所有数据已清除');
    })
    .catch(e => toast('清除失败：' + (e.message || e)));
};

document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'E') {
    e.preventDefault();
    toggleAutoEnter();
  }
  if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'V') {
    e.preventDefault();
    toggleAutoPaste();
  }
});

// 系统级全局热键（⌥⌘P，由 Rust 侧注册并 emit）：窗口不在前台也能切换自动粘贴。
// 与上面的 ⌘⇧V 同一条路径（都走 toggleAutoPaste）；多一句 toast——窗口不在前台时看不到 footer 按钮的填充状态。
window.__TAURI__?.event?.listen('rtc:toggle-auto-paste', () => {
  toggleAutoPaste();
  toast(state.autoPaste ? '自动粘贴已开启（⌥⌘P）' : '自动粘贴已关闭（⌥⌘P）');
});

(async () => {
  setStatus('就绪', false);
  initListAutoScroll();
  await migrateLegacyLocalConfig();
  await Promise.all([
    loadCorrectionRules(),
    loadASRSettings(),
    loadTotalDuration(),
    initLearnedCommands(),
  ]);
  if (state.autoPaste) ensurePastePermission();
  updateEngineBadge();
  refreshEngineMenuAvailability();
  setupUpdateUI();
  updateVersionBadge();
  initServerUptime();
  await renderHistory(true);
  $('btn').click();
  // 启动 6 秒后静默检查更新；发现新版本时显示顶部横幅提醒
  setTimeout(() => checkForUpdates(false), 6000);
})().catch(e => {
  console.error('[app] startup failed:', e.message || e);
});

// ---------- 数据存储位置展示 ----------

function storageBase() {
  return (location.protocol === 'http:' || location.protocol === 'https:') && location.port === '8931'
    ? ''
    : 'http://127.0.0.1:8931';
}

function fmtBytes(n) {
  if (!n) return '0 B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / (1024 * 1024)).toFixed(1) + ' MB';
}

let storagePaths = {};

async function loadStorageInfo() {
  try {
    const r = await fetch(`${storageBase()}/api/storage`);
    const data = await r.json();
    if (!data || !data.dataRoot) return;
    storagePaths = {
      dataRoot: data.dataRoot,
      eventsDir: data.eventsDir,
      configFile: data.configFile,
      commandsFile: data.commandsFile,
    };
    const st = data.stats || {};
    $('storageDataRoot').textContent = data.dataRoot;
    $('storageEvents').textContent =
      `${data.eventsDir}（共 ${st.eventFiles || 0} 个记录文件 · ${fmtBytes(st.eventBytes)}）`;
    $('storageConfigFile').textContent =
      `${data.configFile}${st.configExists ? ' · 已存在' : ' · 尚未创建'}`;
    $('storageCommandsFile').textContent =
      `${data.commandsFile}${st.commandsExists ? ' · 已存在' : ' · 尚未创建'}`;
  } catch (e) {
    $('storageDataRoot').textContent = '无法读取（服务未连接）: ' + (e.message || e);
  }
}

// 在访达中显示
function ensureStorageButtons() {
  const container = $('settingsPage');
  if (!container) return;
  container.querySelectorAll('.storage-open-btn').forEach(btn => {
    if (btn.dataset.bound) return;
    btn.dataset.bound = '1';
    btn.onclick = () => {
      const path = storagePaths[btn.dataset.open];
      if (!path) return;
      if (window.__TAURI__ && window.__TAURI__.shell) {
        window.__TAURI__.shell.open(path).catch(() => {});
      } else {
        toast('仅桌面版支持打开文件夹');
      }
    };
  });
  container.querySelectorAll('.storage-copy-btn').forEach(btn => {
    if (btn.dataset.bound) return;
    btn.dataset.bound = '1';
    btn.onclick = () => {
      const path = storagePaths[btn.dataset.copy];
      if (!path) return;
      navigator.clipboard.writeText(path)
        .then(() => toast('路径已复制'))
        .catch(() => toast('复制失败'));
    };
  });
}
ensureStorageButtons();

// ---------- 纠错规则模态框控制 ----------
window.correctionOpenEditor = function correctionOpenEditor() {
  document.getElementById('correctionModal').classList.add('open');
};
window.correctionCloseEditor = function correctionCloseEditor() {
  document.getElementById('correctionModal').classList.remove('open');
};
document.getElementById('correctionModal').addEventListener('click', function(e) {
  if (e.target === this) correctionCloseEditor();
});
