import { $, setStatus, toast } from './ui.js';
import { state, VAD_METER_FULL_SCALE } from './state.js';
import { DEFAULT_RULES, flushCorrectionRules, loadCorrectionRules, saveCorrectionRules } from './correction.js';
import { ensurePastePermission } from './clipboard.js';
import { connectASR, setAsrStopHandler } from './asr.js';
import { getAudioConstraints, startAudio, stopRec } from './audio.js';
import { clearHistory, renderHistory, startHistPoll } from './history.js';
import { flushASRSettings, loadASRSettings, saveASRSettings, syncToggleUI, updateEngineBadge, loadTotalDuration, renderVADThresholdMarker } from './settings.js';
import { migrateLegacyLocalConfig } from './config-migration.js';
import { checkForUpdates, setupUpdateUI, updateVersionBadge } from './updater.js';

setAsrStopHandler(stopRec);

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
  $('btn').textContent = '停止录音';
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
    $('btn').textContent = '▶ 开始录音';
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

function showSettings(show) {
  $('settingsPage').classList.toggle('hidden', !show);
  $('queryBar').style.display = show ? 'none' : '';
  $('list').style.display = show ? 'none' : '';
  document.querySelector('footer').style.display = show ? 'none' : '';
}

$('settingsBtn').onclick = () => showSettings(true);
$('settingsClose').onclick = () => showSettings(false);
$('settingsSaveBtn').onclick = async () => {
  state.apiKey = $('apiKey').value.trim();
  state.qwen3ModelDir = $('qwen3ModelDir').value.trim();
  if (state.asrEngine === 'bailian' && !state.apiKey) {
    state.asrEngine = 'sensevoice';
    updateEngineBadge();
  }
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
  state.qwen3ModelDir = '';
  $('qwen3ModelDir').value = '';
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
  const txt = e.target.closest('.txt');
  if (!txt) return;
  const text = txt.textContent.trim();
  if (!text) return;
  navigator.clipboard.writeText(text).then(() => {
    txt.style.transition = 'background .15s';
    txt.style.background = 'rgba(191,58,30,.08)';
    setTimeout(() => { txt.style.background = ''; }, 400);
  }).catch(() => {});
});

function changeEngine(sel) {
  const next = sel.value;
  state.apiKey = $('apiKey').value.trim();
  if (next === state.asrEngine) return;
  if (next === 'bailian' && !state.apiKey) {
    toast('请先在设置中配置百炼 API Key');
    updateEngineBadge();
    return;
  }
  state.asrEngine = next;
  saveASRSettings();
  updateEngineBadge();
  if (state.recording) {
    stopRec();
    state.stream = null;
    $('btn').onclick();
  }
}

$('engineBadge').onchange = () => changeEngine($('engineBadge'));

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

$('qwen3ModelDir').onchange = () => {
  state.qwen3ModelDir = $('qwen3ModelDir').value.trim();
  saveASRSettings();
  if (state.recording) {
    toast('Qwen3 模型目录已更新，将在下个识别任务生效');
  }
};

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

$('autoPasteBtn').onclick = function () {
  state.autoPaste = !state.autoPaste;
  syncToggleUI();
  saveASRSettings();
  if (state.autoPaste) ensurePastePermission();
};

$('autoEnterBtn').onclick = function () {
  state.autoEnter = !state.autoEnter;
  syncToggleUI();
  saveASRSettings();
};

$('ftPaste').onclick = function () {
  state.autoPaste = !state.autoPaste;
  syncToggleUI();
  saveASRSettings();
  if (state.autoPaste) ensurePastePermission();
};

$('ftEnter').onclick = function () {
  state.autoEnter = !state.autoEnter;
  syncToggleUI();
  saveASRSettings();
};

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

document.querySelectorAll('.qbtn[data-min]').forEach(b => {
  b.onclick = () => {
    document.querySelectorAll('.qbtn[data-min]').forEach(x => x.className = 'qbtn');
    b.className = 'qbtn on';
    state.qMinutes = +b.dataset.min;
    void renderHistory(true).catch(e => {
      console.error('[transcript] history load failed:', e.message || e);
    });
  };
});

$('clearBtn').onclick = () => {
  if (confirm('确定清空所有历史记录？')) {
    clearHistory()
      .then(() => {})
      .catch(e => toast('清空失败：' + (e.message || e)));
  }
};

document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'E') {
    e.preventDefault();
    state.autoEnter = !state.autoEnter;
    syncToggleUI();
    saveASRSettings();
  }
  if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'V') {
    e.preventDefault();
    state.autoPaste = !state.autoPaste;
    syncToggleUI();
    saveASRSettings();
    if (state.autoPaste) ensurePastePermission();
  }
});

(async () => {
  setStatus('就绪', false);
  await migrateLegacyLocalConfig();
  await Promise.all([
    loadCorrectionRules(),
    loadASRSettings(),
    loadTotalDuration(),
  ]);
  if (state.autoPaste) ensurePastePermission();
  updateEngineBadge();
  setupUpdateUI();
  updateVersionBadge();
  await renderHistory(true);
  startHistPoll();
  $('btn').click();
  // 启动 6 秒后静默检查更新；发现新版本时显示顶部横幅提醒
  setTimeout(() => checkForUpdates(false), 6000);
})().catch(e => {
  console.error('[app] startup failed:', e.message || e);
});

/* 纠错规则模态框控制 */
window.correctionOpenEditor = function correctionOpenEditor() {
  document.getElementById('correctionModal').classList.add('open');
};
window.correctionCloseEditor = function correctionCloseEditor() {
  document.getElementById('correctionModal').classList.remove('open');
};
document.getElementById('correctionModal').addEventListener('click', function(e) {
  if (e.target === this) correctionCloseEditor();
});
