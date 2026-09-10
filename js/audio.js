import { state, VAD_METER_FULL_SCALE, isLocalEngine, normalizeEngine } from './state.js';
import { $, setStatus } from './ui.js';
import { vadSend, sendPCM, finalizePending, disconnectBailian } from './asr.js';
import { flushTotalDuration } from './settings.js';

export function getAudioConstraints() {
  const agc = isLocalEngine(normalizeEngine(state.asrEngine)) ? false : true;
  return state.filterOn
    ? { echoCancellation: true, noiseSuppression: true, autoGainControl: agc, channelCount: 1 }
    : { autoGainControl: agc, channelCount: 1 };
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
  if (state.audioCtx.state === 'suspended') await state.audioCtx.resume();
  if (!state.srcNode || !state.proc) {
    state.srcNode = state.audioCtx.createMediaStreamSource(state.stream);
    state.proc = state.audioCtx.createScriptProcessor(4096, 1, 1);
    state.proc.onaudioprocess = e => {
      if (!state.recording) return;
      const input = e.inputBuffer.getChannelData(0);
      const down = downsample(input, state.audioCtx.sampleRate, 16000);
      if (state.gainMultiplier > 1) {
        for (let i = 0; i < down.length; i++) down[i] *= state.gainMultiplier;
      }
      let sumSquares = 0;
      for (let i = 0; i < down.length; i++) sumSquares += down[i] * down[i];
      const rms = Math.sqrt(sumSquares / down.length);

      const bar = $('levelMeterBar');
      if (bar) {
        const pct = Math.min(100, rms / VAD_METER_FULL_SCALE * 100);
        bar.style.width = pct.toFixed(0) + '%';
        bar.className = rms >= state.vadThreshold
          ? (rms >= state.vadThreshold * 3 ? 'loud' : 'speech')
          : '';
      }
      const levelText = $('levelMeterText');
      if (levelText) {
        levelText.textContent = `${rms.toFixed(4)} / ${state.vadThreshold.toFixed(4)}`;
      }

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
}

export function stopRec() {
  state.wantRecording = false;
  state.recording = false;
  clearTimeout(state.reconnectTimer);
  try { if (state.proc) state.proc.disconnect(); } catch (e) {}
  try { if (state.srcNode) state.srcNode.disconnect(); } catch (e) {}
  try { if (state.audioCtx) state.audioCtx.close(); } catch (e) {}
  try { if (state.stream) state.stream.getTracks().forEach(t => t.stop()); } catch (e) {}
  finalizePending();
  disconnectBailian();
  state.pcmSendBuffer = [];
  state.pcmBufferStartTime = 0;
  state.audioDuration = 0;
  state.asrLastTime = 0;
  state.audioCtx = null;
  state.stream = null;
  state.proc = null;
  state.srcNode = null;
  state.muteNode = null;
  const bar = $('levelMeterBar');
  if (bar) {
    bar.style.width = '0%';
    bar.className = '';
  }
  const levelText = $('levelMeterText');
  if (levelText) levelText.textContent = `0.0000 / ${state.vadThreshold.toFixed(4)}`;
  flushTotalDuration();
  const btn = $('btn');
  btn.textContent = '▶ 开始录音';
  btn.className = '';
  setStatus('就绪', false);
}
