export const state = {
  recording: false,
  recStartTs: 0,          // 本次录音开始时刻（ms），用于录音按钮上显示本段录音时长
  sentCount: 0,
  wantRecording: false,
  audioCtx: null,
  stream: null,
  proc: null,
  srcNode: null,
  muteNode: null,
  reconnectTimer: null,
  wsRetry: 0,
  rendered: new Set(),
  lastDay: '',
  stickToBottom: true,   // 列表是否跟随最新内容；用户向上翻阅历史时置 false，不再抢滚动
  historyFrom: null,     // 已加载窗口的起点（ms）；向前翻页时不断前移，null=今天 00:00
  historyExhausted: false, // 已经翻到最早，不再尝试向前加载
  historyLoading: false,   // 向前加载进行中，防止滚动事件并发触发多次请求
  todayCount: 0,            // 标题栏实时显示的今日记录条数
  searchQuery: '',
  filterOn: true,
  asrEngine: 'sensevoice',
  apiKey: '',
  qwen3ModelDir: '',
  asrWs: null,
  asrTaskId: '',
  asrReady: false,
  // ---------- 运行状态（唯一渲染来源在 ui.js 的 renderRunStatus；显示在 footer 右侧） ----------
  serverOk: null,         // 本地服务探测结果：null=尚未探测 / true=可达 / false=不可达
  serverUptime: 0,        // 服务运行时长基准（秒），来自 /api/status.uptime
  micError: '',           // 麦克风不可用原因（''=可用），由 getUserMedia 失败时写入
  // 音频输入是否在流动（录音时看护，见 audio.js 的 startAudioFlowWatch）。
  // audioTickAt = 最近一次麦克风回调的时刻；audioStalled = 已确认「录音中但一个采样都收不到」。
  // 判据是结构性的（回调停了），不是「安静」——用户不说话是正常的，回调不来一定是管道断了。
  audioTickAt: 0,
  audioStalled: false,
  // 本机模型服务（asr_local/server.py 的 8933）探测结果，由 model.js 写入。
  // null 有两层含义：还没探测出来，或者当前引擎是百炼（云端）——本地模型服务与它无关，
  // 此时状态区不该报这个异常。只有本地引擎才可能是 false（= 未启动）。
  modelServiceOk: null,
  audioDuration: 0,
  asrLastTime: 0,
  asrLastText: '',
  pendingLine: null,
  finalizedText: '',
  asrSentenceId: null,
  asrLastBeginTime: -1,
  totalDuration: 0,
  vadThreshold: 0.006,
  vadMode: 'auto',
  silenceTimeout: 2000,
  gainMultiplier: 1,
  autoPaste: false,
  // 「哪些应用可以自动粘贴」的名单（存 `.app` 包名，如 WeChat）。空数组 = 沿用老行为：
  // 总闸开着就对所有应用粘。判定见 settings.shouldAutoPaste —— 名字要和前台应用身份
  // 对上才算命中（appInList 解释了名单里的 WeChat 与前台回的中文显示名为什么不是一回事）。
  autoPasteApps: [],
  autoEnter: false,
  // 「哪些应用可以自动回车」的名单（存应用名身份，同 autoPasteApps）。空数组 = 沿用老行为：
  // 总闸开着就对所有应用回车。判定见 settings.shouldAutoEnter。
  autoEnterApps: [],
  sfxOn: true,             // 按钮提示音开关（sfx.js）
  noiseFilter: true,
  correctionRules: [],
  correctionEnabled: true,
  pastePermPrompting: false,
  vadState: 'silent',
  vadSilenceCount: 0,
  vadHeartbeat: 0,
  // 起说门槛计数：连着这么多块过门槛才认「有人说话」（见 asr.js 的 VAD_ONSET_BLOCKS）。
  // 只用来挡一瞬的噪声（敲键盘、碰麦克风），所以中间掉一块就归零。
  vadSpeechBlocks: 0,
  // 最近一次「判定到有人在说话」的时刻（ms）。
  // 只给界面用（菜单栏说完后留一小段「已听到」的回执），**不参与**说话判定本身——
  // 判定只认 vadState（见 asr.js 的 updateSpeechState）。
  speechHeardAt: 0,
  vadBuf: [],
  silenceChunks: 0,
  pcmSendBuffer: [],
  pcmBufferStartTime: 0,
  // 上行拥塞提示只在一次拥塞里弹一次，恢复后复位（见 asr.js sendPCM）
  pcmStallNotified: false,
  asrStopHandler: null,
  // 一次性指令模式：用户主动打开后，只消费下一句定型语音，执行完自动关闭。
  commandModeArmed: false,
  // AI 服务商配置（OpenAI 兼容）：provider/baseUrl/apiKey/model
  aiConfig: {
    provider: 'custom',
    baseUrl: '',
    apiKey: '',
    model: '',
  },
};

export const ASR_PRICE = 0.00033;

// ---------- 电平尺刻度 ----------
// 尺子的显示范围 = VAD 阈值的可调范围，所以刻度能一路拖到尺子两端，两个概念不会打架。
// 映射走 dBFS（20·log10(rms)）而不是线性 RMS：麦克风电平和人耳都是对数的，线性刻度下
// 正常说话就顶格（旧版满量程 0.01 就是这样：原始麦克风说句话 RMS 就已经到 0.01 了），
// 而轻声、气声全挤在最左边几个像素里，看不见也拖不准。
export const VAD_THRESHOLD_MIN = 0.001;
export const VAD_THRESHOLD_MAX = 0.05;

const METER_DB_MIN = 20 * Math.log10(VAD_THRESHOLD_MIN); // -60 dBFS
const METER_DB_MAX = 20 * Math.log10(VAD_THRESHOLD_MAX); // -26 dBFS

/** RMS（线性幅度）→ 电平尺百分比（0~100）。非正数、超范围都夹到端点 */
export function rmsToMeterPct(rms) {
  if (!(rms > 0)) return 0;
  const db = 20 * Math.log10(rms);
  const pct = (db - METER_DB_MIN) / (METER_DB_MAX - METER_DB_MIN) * 100;
  return Math.max(0, Math.min(100, pct));
}

/** 电平尺百分比（0~100）→ RMS；拖动刻度时用它反解阈值，与 rmsToMeterPct 严格互逆 */
export function meterPctToRms(pct) {
  const db = METER_DB_MIN + (METER_DB_MAX - METER_DB_MIN) * (pct / 100);
  return Math.pow(10, db / 20);
}

/** 电平尺百分比（0~100）→ dBFS；仪表读数用它，保证数字和尺子严格同源 */
export function meterPctToDb(pct) {
  return METER_DB_MIN + (METER_DB_MAX - METER_DB_MIN) * (pct / 100);
}

/** 夹到合法阈值区间：保证阈值永远落在尺子范围内，刻度不会被算出界 */
export function clampVADThreshold(v) {
  if (!Number.isFinite(v)) return VAD_THRESHOLD_MIN;
  return Math.min(VAD_THRESHOLD_MAX, Math.max(VAD_THRESHOLD_MIN, Number(v)));
}

// ---------- 引擎辅助 ----------

/** 本地类引擎（sensevoice/qwen3）→ true；百炼 → false。兼容旧值 'local' → sensevoice */
export function isLocalEngine(engine) {
  return engine !== 'bailian';
}

/** 归一化引擎名：'local'（旧配置）→ 'sensevoice'；其余原样 */
export function normalizeEngine(engine) {
  if (engine === 'local') return 'sensevoice';
  return engine;
}

/** 引擎中文显示名 */
export function engineLabel(engine) {
  const e = normalizeEngine(engine);
  return ({ bailian: '百炼', sensevoice: 'SenseVoice', qwen3: 'Qwen3-ASR' })[e] || e;
}

/** 引擎状态文案（连接/就绪/超时等短状态） */
export function engineStatusText(engine) {
  const e = normalizeEngine(engine);
  return ({ bailian: '百炼', sensevoice: 'SenseVoice', qwen3: 'Qwen3' })[e] || e;
}
