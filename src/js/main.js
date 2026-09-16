import { $, renderRunStatus, initRunStatus, toast, setRecordBtn, flashPulse, initListAutoScroll, listNearTop } from './ui.js';
import { state, meterPctToRms, clampVADThreshold } from './state.js';
import { DEFAULT_RULES, flushCorrectionRules, loadCorrectionRules, saveCorrectionRules } from './correction.js';
import { ensurePastePermission } from './clipboard.js';
import { connectASR, setAsrStopHandler } from './asr.js';
import { getAudioConstraints, startAudio, stopRec } from './audio.js';
import { clearHistory, loadEarlier, renderHistory } from './history.js';
import { flushASRSettings, loadASRSettings, saveASRSettings, syncToggleUI, updateEngineBadge, loadTotalDuration, renderVADThresholdMarker, testBailianConnection, syncAIForm, readAIForm, testAIConnection, syncCollapsibleGroups, refreshGroupSummaries, toggleGroup, renderAutoEnterApps, addAutoEnterApp, toggleAutoEnterApp, commitAutoEnterApps, resetAutoEnterAppsDraft, AI_PROVIDERS } from './settings.js';
import { renderModelStatus, getModelStatus } from './model.js';
import { initLearnedCommands, pickApplication } from './commands.js';
import { migrateLegacyLocalConfig } from './config-migration.js';
import { checkForUpdates, setupUpdateUI, updateVersionInfo } from './updater.js';
import { playStart, playToggle } from './sfx.js';
import { apiUrl } from './api.js';
import { showStatsPage } from './stats.js';

/**
 * 主界面运行状态已收敛到 ui.js 的单一状态机（renderRunStatus / initRunStatus）。
 * 本文件不再自己写 #statusText / #statusTime，只负责改 state 并在必要时触发重渲染。
 * （状态块本身在 footer 电平尺一行右侧，曾经在顶栏。）
 */
setAsrStopHandler(stopRec);

// ---------- 开关类行为（唯一入口） ----------
// 音效挂在「行为」而不是「按钮点击」上：footer 按钮、设置页开关、⌘⇧V/⌘⇧E、
// Tauri 全局热键 ⌥⌘P 全都走下面这两个函数，新增入口也不会再漏掉提示音。
//
// 切换确认同样挂在这里：开关自己做一下短促的「按下」脉冲（样式见
// style.css 的 .toggled，脉冲本身是 ui.js 的 flashPulse，和录制按钮共用一套），
// 不再往顶部写一行字。反馈落在手指按下的那个按钮上，连续切换也不会在标题下方反复闪。
function setAutoPaste(on) {
  state.autoPaste = on;
  syncToggleUI();
  saveASRSettings();
  playToggle(on);
  flashPulse($('ftPaste'));
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
  flashPulse($('ftEnter'));
}

function toggleAutoEnter() {
  setAutoEnter(!state.autoEnter);
}

$('btn').onclick = async () => {
  if (state.wantRecording) {
    // 录音中，或正在 await getUserMedia 的半启动状态。
    // 后者以前会漏：wantRecording 只写不读，用户连点两下时 state.recording 还是 false，
    // 于是抓第二条麦克风流、建第二条 WebSocket，转写结果整段重复，且旧流再也停不掉。
    state.wantRecording = false;
    if (state.recording) stopRec();
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
      state.micError = '';
    } catch (e) {
      toast('无法访问麦克风：' + e.message);
      state.micError = e.message || '权限被拒';
      state.wantRecording = false;
      renderRunStatus();
      return;
    }
  }
  // 等待授权期间用户可能已经再点一下取消了，那就别继续起管道。
  if (!state.wantRecording) return;
  state.sentCount = 0;
  if ($('count')) $('count').textContent = '';
  state.recording = true;
  state.recStartTs = Date.now();
  setRecordBtn(true);
  renderRunStatus();
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
    renderRunStatus();
    try { if (state.stream) state.stream.getTracks().forEach(t => t.stop()); } catch (ex) {}
    state.stream = null;
  }
};

// 降噪 / 回声消除没有开关：默认开启（state.filterOn 由 audio.js getAudioConstraints 读取），
// 设置页不再暴露该选项。保留状态字段，历史上关掉过的用户其偏好依然生效。

// 百炼 API Key 默认收起，避免一个空输入框常驻占位；点齿轮图标才展开填写。
// 设置页只做管理，引擎切换仅在底栏药丸。
$('bailianConfigBtn').onclick = () => {
  const panel = $('bailianPanel');
  const btn = $('bailianConfigBtn');
  const willOpen = panel.classList.contains('hidden');
  panel.classList.toggle('hidden', !willOpen);
  btn.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
};

// 按钮提示音没有开关：设置页不再暴露该选项，音效恒为启用。
// state.sfxOn / config.settings.sfx 仍然保留并被 sfx.js 读取，因此
// 历史上关掉过提示音的用户其偏好依然生效，也不会破坏既有配置文件结构。
function showSettings(show) {
  $('settingsPage').classList.toggle('hidden', !show);
  $('queryBar').style.display = show ? 'none' : '';
  $('list').style.display = show ? 'none' : '';
  document.querySelector('footer').style.display = show ? 'none' : '';
  if (show) {
    renderModelStatus();
    syncAIForm();
    loadStorageInfo();
    // 恢复上次的展开/收起偏好（首次打开回落到默认展开状态）
    syncCollapsibleGroups();
    // 「识别方式」的选中态与展开面板由 updateEngineBadge() 内部同步（单一写入点）
    updateEngineBadge();
    renderAutoEnterApps();
  }
}

// 分组折叠：点击标题行切换；状态写入 localStorage，下次打开设置保持同样折叠
$('settingsPage').addEventListener('click', (e) => {
  const head = e.target.closest('.s-group.collapsible .sg-head');
  if (head) {
    // 登记表键由 head id 去掉 GroupHead 后缀得到（aiGroupHead → ai）
    toggleGroup(head.id.replace(/GroupHead$/, ''));
    return;
  }
  const appToggle = e.target.closest('.app-rule-toggle');
  if (appToggle) {
    toggleAutoEnterApp(appToggle.dataset.app);
    return;
  }
  const addApp = e.target.closest('#autoEnterAppAdd');
  if (addApp) {
    void pickApplication(addApp, '', addAutoEnterApp);
    return;
  }
  // 「恢复默认」后所有摘要文案都会变，统一重算一遍
  if (e.target.closest('#settingsResetBtn')) refreshGroupSummaries();
});

// ---------- 今日记录统计 ----------
$('statsBtn').onclick = () => showStatsPage(true);

// 会议白板
// 会议白板 — 新开独立窗口，与主界面并存
$('meetingBoardBtn').onclick = () => {
  const tauri = window.__TAURI__;
  if (tauri && tauri.webviewWindow) {
    try {
      new tauri.webviewWindow.WebviewWindow('meeting-board', {
        url: '/meeting-board/',
        title: '会议白板',
        width: 900,
        height: 650,
        center: true,
      });
      return;
    } catch (e) {
      console.warn('[board] Tauri window failed, fallback to popup:', e);
    }
  }
  // 网页/Dev 模式回退
  const w = window.open('/meeting-board/', 'rtc-meeting-board',
    'width=900,height=650,scrollbars=yes');
  if (!w) toast('弹窗被拦截，请允许弹出窗口或手动打开 http://localhost:8931/meeting-board/');
};

// ---------- 推荐 RTC 居中弹窗 ----------
function closeSharePopover() {
  $('sharePopover').classList.add('hidden');
  $('shareBtn').classList.remove('on');
  $('shareBtn').setAttribute('aria-expanded', 'false');
}

$('shareBtn').onclick = () => {
  const popover = $('sharePopover');
  if (!popover.classList.contains('hidden')) { closeSharePopover(); return; }
  popover.classList.remove('hidden');
  $('shareBtn').classList.add('on');
  $('shareBtn').setAttribute('aria-expanded', 'true');
};

$('sharePopoverClose').onclick = closeSharePopover;

// 点击遮罩关闭弹窗
document.addEventListener('click', (e) => {
  const popover = $('sharePopover');
  if (popover.classList.contains('hidden')) return;
  if (e.target.closest('.sharePopover-panel') || e.target.closest('#shareBtn')) return;
  closeSharePopover();
});

// 点击文案段落复制
document.addEventListener('click', (e) => {
  const item = e.target.closest('.sharePopover-item');
  if (!item) return;
  // 从可见内容提取文案，<br> 转成实际换行
  const textEl = item.querySelector('.sharePopover-item-text');
  if (!textEl) return;
  const text = textEl.innerHTML
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .trim();
  navigator.clipboard.writeText(text).then(() => {
    item.classList.add('copied');
    setTimeout(() => item.classList.remove('copied'), 1500);
  }).catch(() => {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed'; ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  });
});

$('settingsBtn').onclick = () => showSettings(true);
$('settingsClose').onclick = () => showSettings(false);
$('settingsSaveBtn').onclick = async () => {
  commitAutoEnterApps();
  state.apiKey = $('apiKey').value.trim();
  readAIForm();
  saveASRSettings();
  saveCorrectionRules($('correctionRules').value);
  await flushASRSettings();
  await flushCorrectionRules();
  renderVADThresholdMarker();
  refreshGroupSummaries();   // 保存后状态文案可能变了，折叠标题行的摘要同步刷新
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
  // VAD 灵敏度无面板控件（唯一入口是主界面电平尺上的可拖刻度），只重置状态
  state.vadThreshold = 0.006;
  state.silenceTimeout = 2000;
  $('silenceTimeout').value = 2000;
  $('silenceTimeoutLabel').textContent = '2000ms';
  state.gainMultiplier = 1;
  $('gainMultiplier').value = 1;
  $('gainMultiplierLabel').textContent = '1x';
  state.autoPaste = false;
  state.autoEnter = false;
  resetAutoEnterAppsDraft();
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

// 选中即复制：正文区域好用，但**不能**在表单里生效。
// textarea/input 里的选中同样是 non-collapsed selection，在 API Key 输入框里选一段
// 想改一下，剪贴板就被悄悄换成了那串 Key——用户接下来粘贴到哪儿都会出岔子。
document.addEventListener('mouseup', (e) => {
  if (e.target instanceof Element && e.target.closest('input, textarea, select, [contenteditable]')) return;
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

/**
 * 切换识别引擎。唯一入口是主界面底栏药丸；设置面板只管配置、不提供切换。
 * 没有百炼 Key 时不允许切过去并提示——切过去也用不了，不如先拦住。
 */
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

// VAD 灵敏度唯一入口：主界面电平尺上的可拖刻度（无面板副本）
(function initVADTickDrag() {
  const bg = $('levelMeterBg');
  const block = $('levelMeterBlock');
  if (!bg) return;

  function setThresholdFromClientX(clientX) {
    const r = bg.getBoundingClientRect();
    const ratio = (clientX - r.left) / r.width;
    const clamped = clampVADThreshold(meterPctToRms(ratio * 100));
    // 4 位小数：dB 刻度下阈值在低端变化极慢（0.001→0.002 就占了尺子 18%），
    // 按 3 位取整会让拖动在左边一路跳格，留 4 位拖动才连续
    state.vadThreshold = Math.round(clamped * 10000) / 10000;
    renderVADThresholdMarker();
    saveASRSettings();
  }

  bg.style.cursor = 'ew-resize';
  bg.addEventListener('pointerdown', e => {
    bg.setPointerCapture(e.pointerId);
    e.preventDefault();
    block.classList.add('dragging'); // 拖动中收起刻度 Tips，见 style.css 对应注释
    setThresholdFromClientX(e.clientX);
  });
  bg.addEventListener('pointermove', e => {
    if (e.buttons & 1) setThresholdFromClientX(e.clientX);
  });
  // 释放捕获后 pointerup / pointercancel 都会派发到 bg 上；两个都要收尾，
  // 否则拖到一半被系统取消（切窗口等）时 dragging 会一直留着，Tips 再也不弹
  for (const ev of ['pointerup', 'pointercancel']) {
    bg.addEventListener(ev, () => block.classList.remove('dragging'));
  }
})();

$('apiKey').onchange = () => {
  state.apiKey = $('apiKey').value.trim();
  // 不再回落引擎：用户在面板里选的就是他要的。缺 Key 时状态行显示「未配置 Key」，
  // 真去录音时会被 startRec 拦截并提示。若这里自动切走，用户连选回百炼都会被弹回。
  updateEngineBadge();
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

// 折叠/展开由 #settingsPage 上的统一委托处理（见 showSettings 附近），这里不再单独挂 onclick，
// 否则同一次点击会切换两次、状态又回到原点。

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

// 自动粘贴 / 自动回车：唯一入口是底部两个开关（ftPaste / ftEnter）
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

// 聊天式向前翻页：滚到列表顶部附近时自动加载更早的记录。
// 用 rAF 合并滚动事件（一帧内只判断一次），加载中/已到最早由 loadEarlier 自己拦。
(function initEarlierLoader() {
  const list = $('list');
  if (!list || list.dataset.earlierBound) return;
  list.dataset.earlierBound = '1';
  let queued = false;
  list.addEventListener('scroll', () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      if (!listNearTop()) return;
      void loadEarlier().catch(err => {
        console.error('[transcript] load earlier failed:', err.message || err);
      });
    });
  }, { passive: true });
})();

$('clearDataBtn').onclick = () => {
  if (!confirm('确定清除全部历史记录？该操作不可恢复。')) return;
  clearHistory()
    .then(() => toast('历史记录已清除'))
    .catch(e => toast('清除失败：' + (e.message || e)));
};

document.addEventListener('keydown', (e) => {
  // 主界面激活时，空格复用录音按钮的唯一切换入口；输入控件和各整页界面不抢键盘。
  const mainInterfaceActive = ['settingsPage', 'cmdPage', 'statsPage', 'sharePopover', 'correctionModal']
    .every(id => {
      const el = $(id);
      return !el || (id === 'correctionModal' ? !el.classList.contains('open') : el.classList.contains('hidden'));
    });
  const target = e.target;
  const isTyping = target instanceof Element && target.closest('input, textarea, select, [contenteditable="true"]');
  const isControl = target instanceof Element && target.closest('button, a');
  if (e.code === 'Space' && mainInterfaceActive && !isTyping && !isControl) {
    e.preventDefault();
    $('btn').click();
    return;
  }

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
// 与上面的 ⌘⇧V 完全同一条路径（都走 toggleAutoPaste），反馈也由那条路径统一给出：
// 开关脉冲 + playToggle 的音（开=高音、关=低音）。窗口不在前台时听声音即可，
// 不再在这里补顶部提示——那行字既离操作位置远，又会连续切换时反复闪。
window.__TAURI__?.event?.listen('rtc:toggle-auto-paste', () => toggleAutoPaste());

(async () => {
  renderRunStatus();
  initListAutoScroll();
  await migrateLegacyLocalConfig();
  // 这四个加载各自读写 /api/config 或 /api/commands。以前它们挂在同一条 await 链上、
  // 只有一个兜底 catch(console.error)：桌面端窗口和 sidecar 抢跑时哪怕一次 fetch 失败，
  // 后面的 initRunStatus / renderHistory / updateVersionInfo / 自动开录全部跳过，
  // 而且没有任何重试，界面就此停在「就绪 + 空列表」。单个失败不该拖垮整个启动。
  const settle = (name, p) => Promise.resolve(p).catch(e => {
    console.error(`[startup] ${name} 失败:`, e && (e.message || e));
  });
  await Promise.all([
    settle('correctionRules', loadCorrectionRules()),
    settle('asrSettings', loadASRSettings()),
    settle('totalDuration', loadTotalDuration()),
    settle('learnedCommands', initLearnedCommands()),
  ]);
  if (state.autoPaste) ensurePastePermission();
  updateEngineBadge();
  refreshEngineMenuAvailability();
  setupUpdateUI();
  updateVersionInfo();
  initRunStatus();
  await renderHistory(true);
  $('btn').click();
  // 启动 6 秒后静默检查更新；发现新版本时显示顶部横幅提醒
  setTimeout(() => checkForUpdates(false), 6000);
})().catch(e => {
  console.error('[app] startup failed:', e.message || e);
});

// ---------- 数据存储位置展示 ----------

function fmtBytes(n) {
  if (!n) return '0 B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / (1024 * 1024)).toFixed(1) + ' MB';
}

let storagePaths = {};

async function loadStorageInfo() {
  try {
    const r = await fetch(apiUrl('/api/storage'));
    const data = await r.json();
    if (!data || !data.dataRoot) return;
    storagePaths = {
      dataRoot: data.dataRoot,
      eventsDir: data.eventsDir,
      configFile: data.configFile,
      commandsFile: data.commandsFile,
    };
    const st = data.stats || {};
    const eventsEl = $('storageEvents');
    eventsEl.textContent =
      `${data.eventsDir}（共 ${st.eventFiles || 0} 个记录文件 · ${fmtBytes(st.eventBytes)}）`;
    eventsEl.dataset.copyKey = 'eventsDir';
    eventsEl.title = '点击复制路径 · ⌥ 点击在访达中显示';
    const cmdEl = $('storageCommandsFile');
    cmdEl.textContent = `${data.commandsFile}${st.commandsExists ? ' · 已存在' : ' · 尚未创建'}`;
    cmdEl.dataset.copyKey = 'commandsFile';
    cmdEl.title = '点击复制路径 · ⌥ 点击在访达中显示';
    refreshGroupSummaries({ storage: `${data.dataRoot} · ${st.eventFiles || 0} 个记录文件` });
  } catch (e) {
    const events = $('storageEvents');
    if (events) events.textContent = '无法读取（服务未连接）: ' + (e.message || e);
    refreshGroupSummaries({ storage: '服务未连接' });
  }
}

// 在访达中显示（目录→打开目录，文件→选中文件）
// 走自定义命令而不是 shell.open：后者对本地路径有 URL 白名单，必然失败
function revealInFinder(path) {
  const invoke = window.__TAURI__?.core?.invoke;
  if (!invoke) {
    toast('仅桌面版支持在访达中显示');
    return;
  }
  invoke('reveal_in_finder', { path }).catch(error => {
    console.error('[storage] 在访达中显示失败:', error);
    toast('打开失败：' + (error && error.message ? error.message : error));
  });
}

// 存储路径行：点击复制路径；按住 ⌥ 点击在访达中显示。
// 比并排两个按钮更省地方，路径本身就是最该被复制的东西。
function ensureStoragePaths() {
  const container = $('settingsPage');
  if (!container) return;
  container.querySelectorAll('.storage-path').forEach(el => {
    if (el.dataset.bound) return;
    el.dataset.bound = '1';
    el.onclick = (e) => {
      const key = el.dataset.copyKey;
      const path = storagePaths[key];
      if (!path) return;
      if (e.altKey) { revealInFinder(path); return; }
      navigator.clipboard.writeText(path)
        .then(() => toast('路径已复制'))
        .catch(() => toast('复制失败'));
    };
  });
}
ensureStoragePaths();

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
