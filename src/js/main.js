import { $, renderRunStatus, initRunStatus, refreshServerStatus, toast, setRecordBtn, flashPulse, initListAutoScroll, listNearTop } from './ui.js';
import { state, meterPctToRms, clampVADThreshold, normalizePushToTalkKey, pushToTalkKeyLabel } from './state.js';
import { DEFAULT_RULES, flushCorrectionRules, loadCorrectionRules, saveCorrectionRules } from './correction.js';
import { ensurePastePermission } from './clipboard.js';
import { connectASR, disconnectBailian, resetVAD, sendVADThreshold, setAsrStopHandler, beginPushToTalkSegment, cancelPushToTalkSegment, flushPushToTalkSegment } from './asr.js';
import { getAudioConstraints, startAudio, stopRec, cancelPushToTalkRec, streamIsDead, rebuildAudioInput, startAudioFlowWatch } from './audio.js';
import { watchWake } from './lifecycle.js';
import { clearHistory, loadEarlier, renderHistory } from './history.js';
import { flushASRSettings, loadASRSettings, saveASRSettings, syncToggleUI, updateEngineBadge, loadTotalDuration, renderVADThresholdMarker, testBailianConnection, syncAIForm, readAIForm, testAIConnection, syncCollapsibleGroups, refreshGroupSummaries, toggleGroup, renderAppRuleLists, addAppRule, toggleAppRule, commitAppRules, resetAppRulesDraft, AI_PROVIDERS } from './settings.js';
// 底标那行小字住自己的模块（settings.js 只负责“设置变了就重画”，不转发它）
import { renderModelStatus, getModelStatus, watchModelService, probeModelService } from './model.js';
import { initLearnedCommands, pickApplication } from './commands.js';
import { checkForUpdates, setupUpdateUI, updateVersionInfo } from './updater.js';
import { playStart, playStop, playToggle } from './sfx.js';
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

async function toggleRecording() {
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
  // 本机模型服务确定没在跑时直接拦下：状态区已经写着「模型服务未启动」，
  // 再放行到 ASR 那条路只会让用户对着「模型服务未启动」空等 15 秒超时。
  // （只在探测已确认（连续失败 + 过了冷启动宽限）时为 false，见 model.js）
  if (state.modelServiceOk === false) {
    toast('本地模型服务未启动，识别无法工作：打开设置 →「识别方式」看原因并重启');
    return;
  }
  state.wantRecording = true;
  // 旧流还要能用才行：`state.stream` 这个对象留着，不代表设备还在干活。
  // 睡眠唤醒后 macOS 会让旧麦克风句柄失效（音轨 ended），这时只判断 `!state.stream`
  // 会老老实实复用一条死流——界面正常、录音正常、一个字都不会出。
  if (streamIsDead(state.stream)) {
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
    // 快捷键路径不是浏览器用户手势，必须等录音 AudioContext 已经 running 后再播；
    // 否则 WKWebView 会静默拦掉开始音。播放在 ASR 连接前发生，仍不会进入识别结果。
    playStart();
    state.pendingLine = null;
    state.finalizedText = '';
    state.vadState = 'silent';
    state.vadSilenceCount = 0;
    state.vadHeartbeat = 0;
    state.vadSpeechBlocks = 0;
    state.speechHeardAt = 0;
    state.vadBuf.length = 0;
    resetVAD();
    // 按住说话模式在开关开启时已经预热连接；这里只在连接尚未就绪时补建。
    if (!state.asrReady) connectASR();
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
}

$('btn').onclick = () => {
  void toggleRecording();
};

function preparePushToTalk() {
  if (!state.pushToTalk || state.asrReady || state.asrWs) return;
  connectASR();
}

/**
 * 按住说话开关：只控制「快捷键是否生效」。
 *
 * 2026-09-20 用户明确要求两种方式不冲突：开关**不再**停掉正在跑的常态录音，
 * 录音按钮也不再被锁住。常态是 VAD 自动断句、自动上屏；按住只是把这一句的句尾
 * 暂时交给手，松开立刻接回常态（细节见 beginPushToTalk / endPushToTalk）。
 */
function setPushToTalk(on, { persist = true, feedback = true } = {}) {
  const next = !!on;
  if (state.pushToTalk === next) return;
  cancelPushToTalkStart({ discard: !next });
  state.pushToTalk = next;
  state.pushToTalkHeld = false;
  state.pushToTalkVisualActive = false;
  pushToTalkChorded = false;
  if (next) preparePushToTalk();
  syncToggleUI();
  setRecordBtn(state.recording);
  renderRunStatus();
  if (persist) saveASRSettings();
  if (feedback) playToggle(next);
}

const PUSH_TO_TALK_HOLD_DELAY_MS = 180;
let pushToTalkStartTimer = null;
let pushToTalkChorded = false;
// 这次录音是快捷键替用户开的（按下前没在录）。松开后它转入常态、不撤销；
// 但如果这次按键其实是系统组合键（⌥Tab），就是误开，必须收回去。
let pushToTalkOwnsRecording = false;
let recordingPushToTalkShortcut = false;
let pushToTalkKeyDraft = state.pushToTalkKey;
let pushToTalkEnabledDraft = state.pushToTalk;

function syncPushToTalkEnabledDraft() {
  const toggle = $('pushToTalkEnabledToggle');
  if (!toggle) return;
  toggle.classList.toggle('on', pushToTalkEnabledDraft);
  toggle.setAttribute('aria-pressed', pushToTalkEnabledDraft ? 'true' : 'false');
  toggle.setAttribute('aria-label', `${pushToTalkEnabledDraft ? '关闭' : '开启'}按住说话`);
}

function syncPushToTalkShortcutRecorder() {
  const btn = $('pushToTalkShortcutBtn');
  const value = $('pushToTalkShortcutValue');
  const action = $('pushToTalkShortcutAction');
  if (!btn || !value || !action) return;
  btn.classList.toggle('recording', recordingPushToTalkShortcut);
  btn.setAttribute('aria-pressed', recordingPushToTalkShortcut ? 'true' : 'false');
  value.textContent = recordingPushToTalkShortcut ? '请按快捷键…' : pushToTalkKeyLabel(pushToTalkKeyDraft);
  action.textContent = recordingPushToTalkShortcut ? '等待输入' : '点击录制';
}

/**
 * 按下没走到「这一段归手动」就提前作废。
 *
 * discard 只在一种情况下真的要收回去：这次录音是快捷键替他开的，而按键其实是组合键。
 * 常态录音本来就在跑时，音频属于刚才那一句，只能取消手动接管，不能丢也不能停。
 */
function cancelPushToTalkStart({ discard = false } = {}) {
  clearTimeout(pushToTalkStartTimer);
  pushToTalkStartTimer = null;
  state.pushToTalkVisualActive = false;
  renderRunStatus();
  if (!state.pushToTalkManual) {
    if (discard && pushToTalkOwnsRecording) { pushToTalkOwnsRecording = false; undoAutoStartedRecording(); }
    return;
  }
  state.pushToTalkManual = false;
  cancelPushToTalkSegment();
  renderRunStatus();
  setRecordBtn(state.recording);
  syncToggleUI();
  if (discard && pushToTalkOwnsRecording) { pushToTalkOwnsRecording = false; undoAutoStartedRecording(); }
}

/** 快捷键误开了一次常态录音（组合键）：停采集、丢掉这一段，并把这次开起来的连接收掉。 */
function undoAutoStartedRecording() {
  if (!state.recording && !state.wantRecording) return;
  cancelPushToTalkRec();   // 停采集（无声）+ 丢弃当前段
  disconnectBailian();     // 连接是这次误按开的，不能留在那儿（stopRec 会做的事，但这里不能 finalizePending）
  setRecordBtn(state.recording);
  syncToggleUI();
}

/** 过了组合键判定窗口、确认只是单独按住：把这一句交给手动。 */
async function startPushToTalk() {
  if (!state.pushToTalkHeld || pushToTalkChorded) return;
  // 先置位再开录：run-task 会带上这个初值，避开「连上之后再补一条控制消息」的竞态。
  // ownsRecording 也在等待前置位，因为等待的正是 getUserMedia：用户可能在那一刻按下 Tab
  // 组成系统快捷键，那时必须能把这半次误开的录音收回去（见 cancelPushToTalkStart）。
  pushToTalkOwnsRecording = !state.recording;
  state.pushToTalkManual = true;
  if (pushToTalkOwnsRecording) {
    await toggleRecording();
    if (!state.pushToTalkManual) {
      // 等待期间已经松手或被组合键作废：不要再补发「手动」，录音由取消路径收尾。
      if (pushToTalkOwnsRecording) { pushToTalkOwnsRecording = false; undoAutoStartedRecording(); }
      return;
    }
    if (!state.recording) {
      // 麦克风或服务起不来：当作没按过，别把「手动接管」留在指示上。
      state.pushToTalkManual = false;
      pushToTalkOwnsRecording = false;
      syncToggleUI();
      return;
    }
  }
  beginPushToTalkSegment();   // 常态录音已有连接：把「这一句不听 VAD」告诉服务端
  // 首次按住若顺带开启了底层录音，toggleRecording 已经播放开始音；常态录音本来就在跑时，
  // 这里补上“这一句开始”的反馈。两条路径保证每句一次，不重复。
  if (!pushToTalkOwnsRecording) playStart();
  renderRunStatus();
  setRecordBtn(state.recording);
  syncToggleUI();
}

function beginPushToTalk() {
  if (!state.pushToTalk || state.pushToTalkHeld) return;
  state.pushToTalkHeld = true;
  state.pushToTalkVisualActive = true;
  pushToTalkChorded = false;
  // 用户的动作是「按下」，所以顶部反馈就在这一刻出现；
  // 不等组合键窗口，更不等 VAD 听到人声。
  renderRunStatus();
  // 留出极短窗口判断这是不是普通组合键（如 ⌥Tab）。确认只是单独按住后才接管。
  pushToTalkStartTimer = setTimeout(() => {
    pushToTalkStartTimer = null;
    void startPushToTalk();
  }, PUSH_TO_TALK_HOLD_DELAY_MS);
}

function endPushToTalk() {
  if (!state.pushToTalk || !state.pushToTalkHeld) return;
  state.pushToTalkHeld = false;
  state.pushToTalkVisualActive = false;
  // 松开同样立即撤回顶部反馈，不等识别结果返回。
  renderRunStatus();
  // 松手只撤掉尚未触发的 180ms 等待；已经开始的手动段不能在提交前被取消。
  clearTimeout(pushToTalkStartTimer);
  pushToTalkStartTimer = null;
  if (pushToTalkChorded) {
    pushToTalkChorded = false;
    return;
  }
  // 松手可能发生在半启动阶段（还没进入手动接管）。那就不冲刷，把它当一次没说完的按压。
  if (!state.pushToTalkManual) return;
  state.pushToTalkManual = false;
  pushToTalkOwnsRecording = false;
  // 松开就是明确句尾：立即定型。**不停录音**——常态的 VAD 自动断句在下一句接回。
  // 这一句的粘贴结果自己携带「不重复播放」身份；不设全局静音，
  // 否则底层录音继续时，后续连续听写的粘贴音会一直没有。
  playStop({ suppressNextPaste: false });
  flushPushToTalkSegment();
  renderRunStatus();
  setRecordBtn(state.recording);
  syncToggleUI();
}

function handleModifierKey(event) {
  const payload = event && event.payload ? event.payload : event;
  const key = payload && payload.key;
  const keyState = payload && payload.state;

  if (recordingPushToTalkShortcut) {
    if (keyState !== 'pressed' || !key) return;
    pushToTalkKeyDraft = normalizePushToTalkKey(key);
    // 用户主动录制快捷键，就表示希望使用它；仍然只改设置草稿，点保存后才生效。
    pushToTalkEnabledDraft = true;
    recordingPushToTalkShortcut = false;
    syncPushToTalkShortcutRecorder();
    syncPushToTalkEnabledDraft();
    return;
  }

  // 选定键之后又按了任何普通键或另一个修饰键，说明用户在用系统组合键，不是说话。
  const isOtherModifier = keyState === 'pressed' && key && key !== state.pushToTalkKey;
  if (state.pushToTalkHeld && (keyState === 'chord' || isOtherModifier)) {
    pushToTalkChorded = true;
    cancelPushToTalkStart({ discard: true });
    return;
  }
  if (key !== state.pushToTalkKey) return;
  if (keyState === 'pressed') beginPushToTalk();
  else if (keyState === 'released') endPushToTalk();
}

/**
 * 机器刚睡醒（见 lifecycle.js 的 watchWake）。
 *
 * 睡一觉回来，三样东西可能都已经死了：麦克风句柄、WebAudio 会话、ASR 的 TCP 连接——
 * 而且死得悄无声息，界面照样写「就绪」。所以这里直接做两件事：
 *   1. 立刻重探两个服务（状态区平时 60 秒才校准一次，停在旧结论上就是在说谎）；
 *   2. 正在录音的话，重建音频输入并重开一条 ASR 连接（睡眠会掐断原来的连接，
 *      而它在 readyState 上看起来还是开着的）。
 * 窗口被完全遮挡时定时器也会被节流（属于假唤醒），所以动作必须便宜且幂等：
 * 没在录音就只重探服务，不碰任何东西。
 */
function handleSystemWake() {
  void refreshServerStatus();
  void probeModelService();
  if (!state.recording) return;
  void rebuildAudioInput().then(ok => { if (ok) connectASR(); });
}

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
    pushToTalkKeyDraft = normalizePushToTalkKey(state.pushToTalkKey);
    pushToTalkEnabledDraft = state.pushToTalk;
    recordingPushToTalkShortcut = false;
    syncPushToTalkShortcutRecorder();
    syncPushToTalkEnabledDraft();
    renderModelStatus();
    syncAIForm();
    loadStorageInfo();
    // 恢复上次的展开/收起偏好（首次打开回落到默认展开状态）
    syncCollapsibleGroups();
    // 「识别方式」的选中态与展开面板由 updateEngineBadge() 内部同步（单一写入点）
    updateEngineBadge();
    renderAppRuleLists();
  } else {
    recordingPushToTalkShortcut = false;
    syncPushToTalkShortcutRecorder();
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
  // 两份名单（自动粘贴 / 自动发送）的行结构一样，用行所在的名单容器区分改哪一份
  const appToggle = e.target.closest('.app-rule-toggle');
  if (appToggle) {
    const box = appToggle.closest('.app-rule-list');
    if (box) toggleAppRule(box.dataset.rule, appToggle.dataset.app);
    return;
  }
  const addApp = e.target.closest('.app-rule-add [data-rule]');
  if (addApp) {
    void pickApplication(addApp, '', app => addAppRule(addApp.dataset.rule, app));
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
$('pushToTalkShortcutBtn').onclick = () => {
  recordingPushToTalkShortcut = !recordingPushToTalkShortcut;
  syncPushToTalkShortcutRecorder();
};
$('pushToTalkEnabledToggle').onclick = () => {
  pushToTalkEnabledDraft = !pushToTalkEnabledDraft;
  syncPushToTalkEnabledDraft();
};
$('settingsSaveBtn').onclick = async () => {
  commitAppRules();
  state.pushToTalkKey = normalizePushToTalkKey(pushToTalkKeyDraft);
  setPushToTalk(pushToTalkEnabledDraft, { persist: false, feedback: false });
  state.apiKey = $('apiKey').value.trim();
  readAIForm();
  saveASRSettings();
  saveCorrectionRules($('correctionRules').value);
  await flushASRSettings();
  await flushCorrectionRules();
  renderVADThresholdMarker();
  syncToggleUI();
  setRecordBtn(state.recording);
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
  state.silenceTimeout = 2000;
  $('silenceTimeout').value = 2000;
  $('silenceTimeoutLabel').textContent = '2000ms';
  state.gainMultiplier = 1;
  $('gainMultiplier').value = 1;
  $('gainMultiplierLabel').textContent = '1x';
  state.autoPaste = false;
  state.autoEnter = false;
  state.pushToTalkKey = 'left-option';
  pushToTalkKeyDraft = state.pushToTalkKey;
  pushToTalkEnabledDraft = false;
  setPushToTalk(false, { persist: false, feedback: false });
  recordingPushToTalkShortcut = false;
  syncPushToTalkShortcutRecorder();
  syncPushToTalkEnabledDraft();
  resetAppRulesDraft();
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
    line.style.background = 'var(--seal-light)';
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
  // 切到本地引擎要立刻重探模型服务：否则上一次探测（可能是引擎为百炼时报的 null）
  // 会让异常提示晚 1 分钟才出现，而用户此刻已经以为可以录了
  void probeModelService();
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
    sendVADThreshold();
    saveASRSettings();
  }

  bg.style.cursor = 'ew-resize';
  bg.addEventListener('pointerdown', e => {
    if (state.pushToTalkManual) return;
    bg.setPointerCapture(e.pointerId);
    e.preventDefault();
    block.classList.add('dragging'); // 拖动中收起刻度 Tips，见 style.css 对应注释
    setThresholdFromClientX(e.clientX);
  });
  bg.addEventListener('pointermove', e => {
    if (!state.pushToTalkManual && (e.buttons & 1)) setThresholdFromClientX(e.clientX);
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

// 主界面底部只保留需要随时切换的自动粘贴 / 自动回车；按住说话在设置页管理。
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

// 搜索：顶栏一个图标（#searchBtn），点开才展开 #queryBar 这一行。它默认不占版面，
// 因为「翻旧记录」是低频动作——常驻一条输入框等于天天邀请人去搜索。搜索能力本身没变，
// 只是从「常驻一行」改成「按需展开」。
// 展开状态放在 body.search-open 上（不写内联 display）：设置页 / 语音指令页「整页打开时
// 把主界面让开」用的是内联 display，不会和它互相覆盖。
// 这里必须判空：dev 模式下改 src/ 会触发热重载，页面有可能拿到「新 JS + 旧 HTML」的
// 中间态；一旦 $('searchInput') 为 null 却不判空，整个模块会在求值阶段抛错，
// 后面的启动流程（含首次 renderHistory）全部不执行，界面就成空列表。
const searchInput = $('searchInput');
const searchBtn = $('searchBtn');
let searchTimer = null;

function rerenderForSearch() {
  void renderHistory(true).catch(err => {
    console.error('[transcript] history load failed:', err.message || err);
  });
}

function setSearchOpen(open) {
  document.body.classList.toggle('search-open', open);
  if (searchBtn) searchBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
  if (open && searchInput) searchInput.focus();
}

// 收起时若还留着关键词，列表就继续被一份看不见的过滤条件压着（「我的记录怎么少了一半」），
// 所以收起 = 连关键词一起清掉、回到全部记录。关键词还在时框本身是可见的，状态从不偷偷存在。
function closeSearch() {
  setSearchOpen(false);
  if (!searchInput || !state.searchQuery) return;
  searchInput.value = '';
  state.searchQuery = '';
  rerenderForSearch();
}

if (searchBtn) searchBtn.onclick = () => {
  if (document.body.classList.contains('search-open')) closeSearch();
  else setSearchOpen(true);
};

if (searchInput) searchInput.oninput = (e) => {
  state.searchQuery = e.target.value.trim();
  clearTimeout(searchTimer);
  searchTimer = setTimeout(rerenderForSearch, 250);
};

// Esc：有词先清词，词空了才收起——一步一跳，不会「按一下把关键词和搜索框一起弄没了」。
if (searchInput) searchInput.onkeydown = (e) => {
  if (e.key !== 'Escape') return;
  e.stopPropagation();
  if (searchInput.value) {
    searchInput.value = '';
    state.searchQuery = '';
    rerenderForSearch();
    return;
  }
  closeSearch();
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
  if (e.code === 'Space' && !e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey
      && mainInterfaceActive && !isTyping && !isControl) {
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
window.__TAURI__?.event?.listen('rtc:modifier-key', handleModifierKey);

(async () => {
  renderRunStatus();
  initListAutoScroll();
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
  // 本地模型服务的看护（主界面状态区据此显示「模型服务未启动」）
  watchModelService();
  // 睡眠唤醒后主动重建录音链路（见 handleSystemWake）；录音期间看护音频是否真的在流动
  watchWake(handleSystemWake);
  startAudioFlowWatch();
  await renderHistory(true);
  if (state.pushToTalk) preparePushToTalk();
  // 2026-09-28 用户定：启动后一律自动进入录音模式。按住说话只是叠在常态录音上的
  // 句尾接管（见 beginPushToTalk），不冲突；过去「开了按住说话就不自动开录」
  // 的分支会让用户每次启动都要手动点一下，与他的使用规矩相反（症状：启动后停在待命，
  // 要多一次点击才开始录）。
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
