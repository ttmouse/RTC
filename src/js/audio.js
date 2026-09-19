import { state, rmsToMeterPct, isLocalEngine, normalizeEngine } from './state.js';
import { renderRunStatus, setRecordBtn } from './ui.js';
import { vadSend, sendPCM, finalizePending, disconnectBailian } from './asr.js';
import { flushTotalDuration } from './settings.js';
import { playStop } from './sfx.js';
import { feedMeter, startMeter, resetMeter } from './meter.js';

export function getAudioConstraints() {
  const agc = isLocalEngine(normalizeEngine(state.asrEngine)) ? false : true;
  return state.filterOn
    ? { echoCancellation: true, noiseSuppression: true, autoGainControl: agc, channelCount: 1 }
    : { autoGainControl: agc, channelCount: 1 };
}

// ---------- 音频会话 / 输入流是否还活着 ----------
//
// 系统睡眠唤醒之后，WebKit 的 WebAudio 会进一个「不是 running」的状态：
//   - 'suspended'：页面被挂起（旧实现只认这一种）；
//   - 'interrupted'：WebKit 特有，系统睡眠、或音频会话被别的应用抢走之后就是它。
// 旧实现只对 'suspended' 调 resume()，于是唤醒后音频图整个是哑的：麦克风回调一次都不触发，
// 而界面上一切正常（ASR 连接是好的，状态区还写着「识别中」）——用户对着它说完一整场，
// 一个字都不会出来。而且停止再录音也不管用，因为「睡过的页面」再建一个新上下文同样是哑的，
// 只有重开应用才能恢复。所以这里只认一条判断：不是 running 就必须拉回 running，
// 拉不回来就如实报错，绝不假装还能录。

/** 非 running 的音频上下文该怎么处理：ok=能用 / resume=还能救 / dead=救不回来（closed 等） */
export function audioStateAction(ctxState) {
  if (ctxState === 'running') return 'ok';
  if (ctxState === 'suspended' || ctxState === 'interrupted') return 'resume';
  return 'dead';
}

/** 把音频上下文恢复到 running，返回最终状态（'running' 才算真的好了） */
export async function ensureAudioRunning(ctx, timeoutMs = 800) {
  const action = audioStateAction(ctx.state);
  if (action !== 'resume') return ctx.state;
  try { await ctx.resume(); } catch (e) { /* 唤醒竞态下 resume 会抛，按下面的最终状态判断 */ }
  const deadline = Date.now() + timeoutMs;
  while (ctx.state !== 'running' && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 40));
  }
  return ctx.state;
}

/**
 * 麦克风流是不是已经废了：没有音轨，或者音轨全是 ended。
 * 睡眠唤醒后 macOS 会让旧设备的句柄失效（音轨 ended，或从此不再出声），
 * 而 `state.stream` 这个对象还在——只判断 `!state.stream` 就会老老实实复用一条死流。
 */
export function streamIsDead(stream) {
  if (!stream) return true;
  const tracks = typeof stream.getAudioTracks === 'function' ? stream.getAudioTracks() : [];
  if (!tracks.length) return true;
  return tracks.every(t => t.readyState === 'ended');
}

export function downsample(input, from, to) {
  if (from === to) return input;
  const ratio = from / to;
  const n = Math.floor(input.length / ratio);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = i * ratio;
    const i0 = x | 0;
    const frac = x - i0;
    out[i] = input[i0] * (1 - frac) + (input[i0 + 1] || 0) * frac;
  }
  return out;
}

export function floatToInt16(f) {
  const out = new Int16Array(f.length);
  for (let i = 0; i < f.length; i++) {
    const s = Math.max(-1, Math.min(1, f[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
  }
  return out;
}

export async function startAudio() {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!state.audioCtx) state.audioCtx = new AC();
  // 不是 running（suspended / WebKit 的 interrupted）就必须拉回来：唤醒后哑掉的音频图
  // 表现是「回调一次都不来」，界面看不出任何异常（见本文件顶部的说明）。
  const ctxState = await ensureAudioRunning(state.audioCtx);
  if (ctxState !== 'running') {
    throw new Error(`音频设备没有就绪（${ctxState}）——睡眠唤醒后常见，请再点一次录音`);
  }
  // 录音过程中被系统打断（睡眠、别的应用抢音频会话）时自己拉回来，不必等看护循环发现
  state.audioCtx.onstatechange = () => {
    const ctx = state.audioCtx;
    if (!ctx) return;
    if (audioStateAction(ctx.state) === 'resume') ctx.resume().catch(() => {});
  };
  state.audioTickAt = Date.now();
  if (!state.srcNode || !state.proc) {
    state.srcNode = state.audioCtx.createMediaStreamSource(state.stream);
    state.proc = state.audioCtx.createScriptProcessor(4096, 1, 1);
    state.proc.onaudioprocess = e => {
      if (!state.recording) return;
      // 回调本身就是「管道还活着」的证据（不管有没有人说话），看护循环读这个时刻
      state.audioTickAt = Date.now();
      if (state.audioStalled) {
        state.audioStalled = false;
        renderRunStatus();
      }
      const input = e.inputBuffer.getChannelData(0);
      const down = downsample(input, state.audioCtx.sampleRate, 16000);
      if (state.gainMultiplier > 1) {
        for (let i = 0; i < down.length; i++) down[i] *= state.gainMultiplier;
      }
      let sumSquares = 0;
      for (let i = 0; i < down.length; i++) sumSquares += down[i] * down[i];
      const rms = Math.sqrt(sumSquares / down.length);

      // 电平表：这里只把目标值交给 meter.js，DOM 写入由它的 rAF 循环统一做。
      // 音频回调约 11.7 次/秒（4096 采样 @48k），直接写 width 会一格一格闪；
      // 而这个频率又远不够 60fps，所以「采样」和「画」必须分开（见 meter.js 顶部注释）
      feedMeter(rms, rmsToMeterPct(rms), state.vadThreshold);

      if (state.asrEngine === 'bailian') {
        const pcm = floatToInt16(down);
        vadSend(down, pcm);
      } else if (isLocalEngine(normalizeEngine(state.asrEngine))) {
        const pcm = floatToInt16(down);
        sendPCM(pcm);
      } else {
        floatToInt16(down);
      }
    };
    state.srcNode.connect(state.proc);
    state.muteNode = state.audioCtx.createGain();
    state.muteNode.gain.value = 0;
    state.proc.connect(state.muteNode);
    state.muteNode.connect(state.audioCtx.destination);
  }
  startMeter();
}

/**
 * 拆掉当前的音频管道（图 + 麦克风流），不碰录音状态、历史与界面。
 * 只有两个调用方：停录，以及录音中途重建（见 rebuildAudioInput）。
 */
function releaseAudioInput() {
  try { if (state.proc) state.proc.disconnect(); } catch (e) {}
  try { if (state.srcNode) state.srcNode.disconnect(); } catch (e) {}
  // close() 对已经关闭的上下文会返回一个被拒的 promise（Chromium 报
  // 「Cannot close a closed AudioContext」），接住它：管道已经是被系统掐断的情况下
  // 我们才来拆，这里本来就很可能是「关一个已经关掉的东西」。
  try { if (state.audioCtx) Promise.resolve(state.audioCtx.close()).catch(() => {}); } catch (e) {}
  try { if (state.stream) state.stream.getTracks().forEach(t => t.stop()); } catch (e) {}
  state.audioCtx = null;
  state.stream = null;
  state.proc = null;
  state.srcNode = null;
  state.muteNode = null;
}

/**
 * 录音中途重建音频输入：拆掉旧的图与旧的流，重新取一次麦克风。
 * 睡眠唤醒、输入设备被拔掉/切走之后，旧流可能还在但一个字节都不给（音轨 ended、
 * 或设备句柄已经失效），这时只有重新取流能修好——而用户听起来一模一样，
 * 界面也不会有任何异常（这正是「界面正常但录不到」的来源）。
 * 返回 true = 新管道已经起来（不代表已经有声音，看护循环会继续盯）。
 */
export async function rebuildAudioInput() {
  if (!state.recording) return false;   // 没在录就没什么可重建的，别凭空开一个麦克风
  releaseAudioInput();
  try {
    state.stream = await navigator.mediaDevices.getUserMedia({ audio: getAudioConstraints() });
    state.micError = '';
  } catch (e) {
    state.micError = e.message || '权限被拒';
    state.audioStalled = true;
    renderRunStatus();
    return false;
  }
  try {
    await startAudio();
  } catch (e) {
    state.audioStalled = true;
    renderRunStatus();
    return false;
  }
  return true;
}

// ---------- 录音时的音频流动看护 ----------
//
// 判据是**结构性的**：麦克风回调停了（三秒一次都不来），而不是「安静」——用户不说话是正常的，
// 回调不来就一定是管道断了（音频会话被抢、设备消失、唤醒后哑掉）。发现后先自动重建一次，
// 还是不通就如实报「没有声音输入」，绝不让状态区继续显示「识别中」：
// 那是本项目最忌讳的假状态——用户对着一个安静在录的界面说完一整场，事后才知道什么都没存。
const AUDIO_STALL_MS = 3000;
// 两次自动重建之间的冷却。管道处于「每隔几秒只通一小会儿」这种半死状态时，
// 没有冷却就会每 3 秒重新取一次麦克风并新建音频上下文（系统麦克风指示灯反复闪，
// 也没人告诉用户有问题）。冷却期内不再重建，直接按「救不回来」如实报告。
const REBUILD_COOLDOWN_MS = 15000;
let stallRebuilt = false;   // 这一轮断流里已经重建过了（避免无限重建）
let lastRebuildAt = 0;

/** 启动看护循环（只调用一次，由 main.js 在启动时拉起） */
export function startAudioFlowWatch(intervalMs = 1000) {
  setInterval(() => {
    if (!state.recording) {
      stallRebuilt = false;
      lastRebuildAt = 0;   // 下一次录音是全新的一轮，冷却不跨录音继承
      state.audioStalled = false;   // 停录时复位，由状态机自己的每秒重渲染带回正常
      return;
    }
    if (Date.now() - state.audioTickAt < AUDIO_STALL_MS) {
      stallRebuilt = false;
      if (state.audioStalled) {
        state.audioStalled = false;
        renderRunStatus();
      }
      return;
    }
    if (!stallRebuilt) {
      if (Date.now() - lastRebuildAt < REBUILD_COOLDOWN_MS) {
        // 刚重建过还是不出声：不再反复折腾设备，如实说
        if (!state.audioStalled) {
          state.audioStalled = true;
          renderRunStatus();
        }
        return;
      }
      stallRebuilt = true;
      lastRebuildAt = Date.now();
      state.audioTickAt = Date.now();   // 给新管道一个完整的观察窗口
      void rebuildAudioInput();
      return;
    }
    if (!state.audioStalled) {
      state.audioStalled = true;
      renderRunStatus();
    }
  }, intervalMs);
}

export function stopRec() {
  playStop();   // 停录路径可能来自按钮 / 快捷键 / WS 断开，统一在这里出声
  state.wantRecording = false;
  state.recording = false;
  state.recStartTs = 0;
  clearTimeout(state.reconnectTimer);
  releaseAudioInput();
  finalizePending();
  disconnectBailian();
  state.pcmSendBuffer = [];
  state.pcmBufferStartTime = 0;
  state.audioDuration = 0;
  state.asrLastTime = 0;
  state.audioTickAt = 0;
  state.audioStalled = false;
  // 仪表归零：停表、清掉电平/峰值/读数。以前这里手写 bar.style.width='0%'，
  // 现在归零动作统一在 meter.js 里（它还管着 rAF 的取消，漏了会留一个空转的循环）
  resetMeter();
  flushTotalDuration();
  // 按钮的常态/录音中状态统一由 setRecordBtn 切（它顺带播一下脉冲），
  // 这里不再单独改 className，否则状态就有了两个来源。
  setRecordBtn(false);
  renderRunStatus();
}
