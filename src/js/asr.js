import { wsProxyUrl } from './api.js';
import { state, isLocalEngine, normalizeEngine, engineStatusText } from './state.js';
import { $, esc, toast, addLine, scrollListToBottom, renderRunStatus } from './ui.js';
import { applyCorrection } from './correction.js';
import { pasteToCursor } from './clipboard.js';
import { tryHandleSpecialCommand, learnSpecialCommand } from './commands.js';
import { saveEntry } from './history.js';
import { saveTotalDuration, updateEngineBadge } from './settings.js';

const VAD_RMS = 0.012;
const VAD_SILENCE_BLOCKS = 10;
const VAD_PAD_BLOCKS = 3;
const VAD_HEARTBEAT_BLOCKS = 54;
const SILENCE_FRAMES = 16;
const SILENCE_THRESH = 300;
// 上行不通时的音频缓冲上限。单个 chunk 是 4096 字节 PCM16@16k ≈ 128ms；
// 只保留最近 10 秒，恢复连接后补发，超出部分丢弃并明确告知用户。
const PCM_BUFFER_MAX_MS = 10000;
const PCM_CHUNK_MS = 4096 / 16000 * 1000;

export function setAsrStopHandler(handler) {
  state.asrStopHandler = handler;
}

/**
 * 按句末标点切分，标点保留在句尾。
 *
 * 原来是 `delta.split(/(?<=[。！？；])/)`——正则后行断言（lookbehind）。V8/Node 支持，
 * 但 WebKit 到 Safari 16.4 才支持：这是**解析期**语法错误，不是运行期异常，所以
 * 在 macOS 10.15/11/12 的 WKWebView 里整个 asr.js 加载失败，main.js 的模块图直接断掉，
 * 表现为点开就白屏。而 tauri.conf.json 写的 minimumSystemVersion 正是 10.15。
 * 手写一遍没有任何正则特性依赖，行为完全一致。
 */
function splitAfterPunctuation(text) {
  const out = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if ('。！？；'.includes(text[i])) {
      out.push(text.slice(start, i + 1));
      start = i + 1;
    }
  }
  if (start < text.length) out.push(text.slice(start));
  return out;
}

export function connectASR() {
  if (state.asrWs) {
    try { state.asrWs.close(); } catch (e) {}
    state.asrWs = null;
  }
  state.asrReady = false;
  state.asrTaskId = 'asr_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
  renderRunStatus(); // 进入「正在连接」
  let connectionTimedOut = false;

  const proxyUrl = wsProxyUrl();
  const eng = normalizeEngine(state.asrEngine);
  const isLocal = isLocalEngine(eng);
  const connectMsg = { type: 'connect', engine: eng };
  if (eng === 'bailian') {
    if (!state.apiKey) {
      toast('请先输入 API Key');
      return;
    }
    connectMsg.url = 'wss://dashscope.aliyuncs.com/api-ws/v1/inference/?api_key=' + encodeURIComponent(state.apiKey);
  }

  const connectTimeout = setTimeout(() => {
    if (!state.asrReady && state.recording) {
      connectionTimedOut = true;
      const msg = isLocal
        ? engineStatusText(eng) + ' 服务未运行：请先执行 ./scripts/serve-local.sh 启动本地 ASR 服务，或切换至百炼引擎'
        : '百炼 ASR 连接超时，请检查 API Key 和网络连接';
      toast(msg);
      state.pcmSendBuffer = [];
      state.wantRecording = false;
      if (state.asrStopHandler) state.asrStopHandler();
    }
  }, 15000);

  try {
    state.asrWs = new WebSocket(proxyUrl);
  } catch (e) {
    clearTimeout(connectTimeout);
    toast('连接失败: ' + e.message);
    return;
  }

  state.asrWs.onopen = () => {
    state.asrWs.send(JSON.stringify(connectMsg));
  };

  state.asrWs.onmessage = async (e) => {
    try {
      let text;
      if (e.data instanceof Blob) {
        text = await e.data.text();
      } else if (e.data instanceof ArrayBuffer) {
        text = new TextDecoder().decode(e.data);
      } else {
        text = e.data;
      }
      const data = JSON.parse(text);

      if (data.type === 'connected') {
        state.asrWs.send(JSON.stringify({
          header: { action: 'run-task', task_id: state.asrTaskId, streaming: 'duplex' },
          payload: {
            task_group: 'audio', task: 'asr', function: 'recognition',
            model: 'qwen-audio-3.0-asr-flash-streaming',
            parameters: {
              format: 'pcm', sample_rate: 16000, enable_punctuation_prediction: true,
              engine: eng,   // sensevoice / qwen3 → 本地 Python 引擎切换
              qwen3_model_dir: eng === 'qwen3' && state.qwen3ModelDir ? state.qwen3ModelDir : undefined,
              vad_threshold: state.vadThreshold, silence_timeout: state.silenceTimeout,
              auto_paste: state.autoPaste,
            },
            input: {},
          },
        }));
        return;
      }

      if (data.type === 'error') {
        toast('代理错误: ' + data.message);
        return;
      }

      const event = data.header && data.header.event;
      if (event === 'task-started') {
        clearTimeout(connectTimeout);
        state.asrReady = true;
        state.pcmBufferStartTime = 0;
        renderRunStatus(); // 「正在连接」→「识别中」
      } else if (event === 'task-failed') {
        const msg = (data.payload && data.payload.message) ||
          (data.header && data.header.message) ||
          (data.header && data.header.error_message) ||
          (data.header && data.header.error_code) ||
          '未知错误';
        toast((isLocal ? engineStatusText(eng) + ' 识别失败: ' : '百炼任务失败: ') + msg);
        state.asrReady = false;
        renderRunStatus();
        if (state.recording && !isLocal) {
          setTimeout(() => {
            if (state.recording && state.asrEngine === 'bailian') connectASR();
          }, 2000);
        }
        if (state.recording && isLocal) {
          setTimeout(() => {
            if (state.recording && isLocalEngine(normalizeEngine(state.asrEngine))) connectASR();
          }, 2000);
        }
      } else if (event === 'result-generated') {
        const sentence = data.payload && data.payload.output && data.payload.output.sentence;
        if (sentence && sentence.text) handleASRResult(sentence, Date.now());
      }
    } catch (ex) {
      console.error('[ws] onmessage error:', ex);
    }
  };

  state.asrWs.onerror = () => {
    clearTimeout(connectTimeout);
    if (connectionTimedOut) return;
    toast(`连接异常：无法连接到本地代理服务 (${proxyUrl})，请确认服务已启动`);
    state.asrReady = false;
    renderRunStatus();
  };
  state.asrWs.onclose = () => {
    clearTimeout(connectTimeout);
    state.asrReady = false;
    renderRunStatus();
  };
}

export function vadSend(down, pcm) {
  let sum = 0;
  for (let i = 0; i < down.length; i++) sum += down[i] * down[i];
  const rms = Math.sqrt(sum / down.length);

  state.vadBuf.push(pcm);
  if (state.vadBuf.length > VAD_PAD_BLOCKS) state.vadBuf.shift();

  if (state.vadState === 'silent') {
    if (rms >= VAD_RMS) {
      state.vadState = 'speech';
      state.vadSilenceCount = 0;
      for (const b of state.vadBuf) sendPCM(b);
    } else {
      state.vadHeartbeat++;
      if (state.vadHeartbeat >= VAD_HEARTBEAT_BLOCKS) {
        state.vadHeartbeat = 0;
        sendPCM(pcm);
      }
    }
  } else {
    sendPCM(pcm);
    if (rms < VAD_RMS) {
      state.vadSilenceCount++;
      if (state.vadSilenceCount >= VAD_SILENCE_BLOCKS) {
        state.vadState = 'silent';
        state.vadSilenceCount = 0;
        state.vadHeartbeat = 0;
      }
    } else {
      state.vadSilenceCount = 0;
    }
  }
}

function checkSilence(pcm) {
  let sum = 0;
  const n = Math.min(pcm.length, 2000);
  for (let i = 0; i < n; i++) {
    const v = pcm[i];
    sum += v * v;
  }
  const rms = Math.sqrt(sum / n);
  if (rms < SILENCE_THRESH) {
    state.silenceChunks++;
    if (state.silenceChunks >= SILENCE_FRAMES) {
      state.silenceChunks = 0;
      finalizePending();
    }
  } else {
    state.silenceChunks = 0;
  }
}

export function sendPCM(pcm) {
  if (!state.asrWs || state.asrWs.readyState !== WebSocket.OPEN || !state.asrReady) {
    // 上行不通时先缓冲。注意这里是**滑窗丢弃**而不是直接 return：
    // 旧实现在缓冲超过 10 秒后对后续音频一律丢弃，且不告诉任何人——界面还显示「录音中」，
    // 用户对着麦克风说话，那段音频从来没离开过浏览器。现在按「只保留最近 10 秒」滑动，
    // 恢复连接后从头补发，并用一条 toast 如实说明间隙。
    if (state.pcmSendBuffer.length === 0) state.pcmBufferStartTime = Date.now();
    const bufferedMs = Date.now() - state.pcmBufferStartTime;
    if (bufferedMs > PCM_BUFFER_MAX_MS) {
      if (!state.pcmStallNotified) {
        state.pcmStallNotified = true;
        toast('识别服务响应较慢，恢复前只保留最近 10 秒音频');
      }
      const dropMs = bufferedMs - PCM_BUFFER_MAX_MS;
      const dropChunks = Math.floor(dropMs / PCM_CHUNK_MS);
      if (dropChunks > 0) {
        state.pcmSendBuffer.splice(0, Math.min(dropChunks, state.pcmSendBuffer.length));
        state.pcmBufferStartTime += dropChunks * PCM_CHUNK_MS;
      }
    }
    state.pcmSendBuffer.push(pcm);
    if (state.pcmSendBuffer.length > 500) {
      state.pcmSendBuffer.shift();
      state.pcmBufferStartTime = Date.now() - state.pcmSendBuffer.length * PCM_CHUNK_MS;
    }
    return;
  }

  state.pcmStallNotified = false;

  if (state.pcmSendBuffer.length > 0) {
    const buf = state.pcmSendBuffer;
    state.pcmSendBuffer = [];
    for (const b of buf) {
      if (state.asrEngine === 'bailian') checkSilence(b);
      state.asrWs.send(b.buffer);
    }
  }

  if (state.asrEngine === 'bailian') checkSilence(pcm);
  state.asrWs.send(pcm.buffer);
  const chunkSec = 4096 / 16000;
  state.audioDuration += chunkSec;
  if (state.asrEngine === 'bailian') {
    state.totalDuration += chunkSec;
    saveTotalDuration();
    // 徽标里只有百炼的费用文案会随计数变化；本地引擎每 256ms 重写一遍
    // 不变的 DOM 属于白干活（textContent 同值赋值仍会触发重排）。
    updateEngineBadge();
  }
}

export function disconnectBailian() {
  if (state.asrWs) {
    if (state.asrWs.readyState === WebSocket.OPEN) {
      state.asrWs.send(JSON.stringify({
        header: { action: 'finish-task', task_id: state.asrTaskId, streaming: 'duplex' },
        payload: { input: {} },
      }));
      const wsToClose = state.asrWs;
      setTimeout(() => {
        try { wsToClose.close(); } catch (e) {}
      }, 1500);
    } else {
      try { state.asrWs.close(); } catch (e) {}
    }
    state.asrWs = null;
  }
  state.asrReady = false;
  state.asrTaskId = '';
  state.asrSentenceId = null;
  state.asrLastText = '';
  renderRunStatus();
}

export function finalizePending() {
  if (!state.pendingLine) return;
  const txt = state.pendingLine.querySelector('.txt');
  const t = state.pendingLine._ptext || '';
  state.pendingLine = null;
  if (!t.trim()) return;
  txt.innerHTML = '';
  txt.textContent = t;
  txt.className = 'txt';
  state.finalizedText += t;
  state.sentCount++;
  if ($('count')) $('count').textContent = `本次 ${state.sentCount} 句`;
  saveEntry(t);
}

function handleASRResult(sentence, browserReceivedAt) {
  const text = sentence.text;
  if (!text) return;
  const isFinal = !!(sentence.end_time > 0);
  const corrected = applyCorrection(text);
  if (isFinal && tryHandleSpecialCommand(corrected)) {
    // 指令已执行（打开应用/触发回车等）。这句话仍是用户说的话，
    // 照常渲染到页面并存入历史，只是不再输出/粘贴到外部位。
    const all = $('list').querySelectorAll('.line');
    const lastTxt = all.length ? all[all.length - 1].querySelector('.txt') : null;
    if (lastTxt && lastTxt.classList.contains('interim')) {
      // 指令句若已作为临时行显示，定型为最终文本，避免重复行
      lastTxt.innerHTML = '';
      lastTxt.textContent = corrected;
      lastTxt.className = 'txt';
    } else {
      addLine(new Date(), corrected, false);
    }
    saveEntry(corrected);
    return;
  }
  if (isFinal) {
    // 本地未命中 → 异步让 LLM 判定是否打开应用指令，命中则执行并回写学习映射。
    // 不阻塞打字机流：LLM 未命中/失败时该句仍按普通文本输出。
    void learnSpecialCommand(corrected);
  }
  const segId = sentence.seg_id || null;
  const timing = sentence.timing || null;
  const context = { taskId: state.asrTaskId, segId, final: isFinal, rawText: text, text: corrected, autoPaste: state.autoPaste, engine: state.asrEngine, browserReceivedAt };
  console.log('[ASR]', JSON.stringify(context));
  if (timing) {
    const nodeSentAt = timing.node_sent_wall_ms || timing.py_flush_wall_ms || null;
    console.log('[timing-js]', JSON.stringify({
      stage: 'asr_result_received',
      taskId: state.asrTaskId,
      segId,
      text,
      browserReceivedAt,
      nodeSentAt,
      browserToNodeMs: nodeSentAt ? Math.round((browserReceivedAt - nodeSentAt) * 10) / 10 : null,
      pyInferMs: timing.py_infer_ms ?? null,
      lastSpeechToFlushMs: timing.last_speech_to_flush_ms ?? null,
      segmentWallMs: timing.segment_wall_ms ?? null,
    }));
  }

  if (state.noiseFilter) {
    const trimmed = corrected.trim();
    if (trimmed.length < 2) {
      console.log('[filter]', JSON.stringify({ ...context, rule: 'short_text' }));
      return;
    }
    if (trimmed.length < 3 && /^[a-zA-Z,.!?;:'\-\s]+$/.test(trimmed)) {
      console.log('[filter]', JSON.stringify({ ...context, rule: 'en_noise' }));
      return;
    }
    if (trimmed.length < 8 && !/[\u4e00-\u9fff\u3400-\u4dbf]/.test(trimmed) && /^[a-zA-Z,.!?;:'\-\s]+$/.test(trimmed)) {
      console.log('[filter]', JSON.stringify({ ...context, rule: 'en_short_word' }));
      return;
    }
  }

  if (isLocalEngine(normalizeEngine(state.asrEngine))) {
    const all = $('list').querySelectorAll('.line');
    const lastLine = all[all.length - 1];
    const lastTxt = lastLine ? lastLine.querySelector('.txt') : null;
    const lastIsInterim = !!(lastTxt && lastTxt.classList.contains('interim'));

    if (isFinal) {
      if (lastIsInterim) {
        lastTxt.innerHTML = '';
        lastTxt.textContent = corrected;
        lastTxt.className = 'txt';
      } else {
        addLine(new Date(), corrected, false);
      }
      state.sentCount++;
      if ($('count')) $('count').textContent = `本次 ${state.sentCount} 句`;
      saveEntry(corrected);
      if (state.autoPaste) {
        pasteToCursor(corrected, state.autoEnter);
      }
    } else {
      if (lastIsInterim) {
        lastTxt.innerHTML = esc(corrected) + '<span class="cursor"></span>';
      } else {
        addLine(new Date(), corrected, true);
      }
      scrollListToBottom();
    }
    state.asrLastText = corrected;
    return;
  }
  let delta = corrected;
  if (corrected.startsWith(state.finalizedText)) {
    delta = corrected.slice(state.finalizedText.length);
  }

  if (!delta.trim() || /^[。！？；，、\s]+$/.test(delta)) {
    if (isFinal && state.pendingLine) finalizePending();
    return;
  }

  const segs = splitAfterPunctuation(delta);
  const complete = segs.filter(s => /[。！？；]$/.test(s));
  const pending = segs.filter(s => !/[。！？；]$/.test(s)).join('');

  let firstComplete = true;
  for (const s of complete) {
    const t = s.trim();
    if (!t) continue;
    if (firstComplete && state.pendingLine) {
      const txt = state.pendingLine.querySelector('.txt');
      txt.innerHTML = '';
      txt.textContent = t;
      txt.className = 'txt';
      state.pendingLine = null;
    } else {
      addLine(new Date(), t, false);
    }
    firstComplete = false;
    saveEntry(t);
    state.sentCount++;
    if ($('count')) $('count').textContent = `本次 ${state.sentCount} 句`;
  }
  if (complete.length) {
    state.finalizedText = corrected.slice(0, corrected.length - pending.length);
  }

  if (pending.trim()) {
    if (!state.pendingLine) {
      addLine(new Date(), pending, true);
      const all = $('list').querySelectorAll('.line');
      state.pendingLine = all[all.length - 1];
    } else {
      const txt = state.pendingLine.querySelector('.txt');
      if (txt) txt.innerHTML = esc(pending) + '<span class="cursor"></span>';
    }
    state.pendingLine._ptext = pending;
  } else if (state.pendingLine) {
    state.pendingLine.remove();
    state.pendingLine = null;
  }

  if (isFinal) {
    finalizePending();
    state.finalizedText = corrected;
    if (state.autoPaste) {
      pasteToCursor(corrected.replace(/[。！？；，、\s]+$/, ''), state.autoEnter);
    }
  }
  state.asrLastText = corrected;
}
