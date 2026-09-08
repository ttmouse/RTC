export const state = {
  recording: false,
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
  qMinutes: 30,
  histTimer: null,
  filterOn: true,
  asrEngine: 'sensevoice',
  apiKey: '',
  qwen3ModelDir: '',
  asrWs: null,
  asrTaskId: '',
  asrReady: false,
  audioDuration: 0,
  asrLastTime: 0,
  asrLastText: '',
  pendingLine: null,
  finalizedText: '',
  asrSentenceId: null,
  asrLastBeginTime: -1,
  totalDuration: 0,
  vadThreshold: 0.006,
  silenceTimeout: 2000,
  gainMultiplier: 1,
  autoPaste: false,
  autoEnter: false,
  noiseFilter: true,
  correctionRules: [],
  correctionEnabled: true,
  pastePermPrompting: false,
  vadState: 'silent',
  vadSilenceCount: 0,
  vadHeartbeat: 0,
  vadBuf: [],
  silenceChunks: 0,
  pcmSendBuffer: [],
  pcmBufferStartTime: 0,
  asrStopHandler: null,
};

export const ASR_PRICE = 0.00033;
export const VAD_METER_FULL_SCALE = 0.01;

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
  return ({ bailian: '百炼', sensevoice: '本地 · SenseVoice', qwen3: '千问 · Qwen3-ASR' })[e] || e;
}

/** 引擎状态文案（连接/就绪/超时等短状态） */
export function engineStatusText(engine) {
  const e = normalizeEngine(engine);
  return ({ bailian: '百炼', sensevoice: '本地 SenseVoice', qwen3: '千问 Qwen3' })[e] || e;
}
