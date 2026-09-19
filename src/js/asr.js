import { wsProxyUrl } from './api.js';
import { state, isLocalEngine, normalizeEngine, engineStatusText } from './state.js';
import { $, esc, toast, addLine, scrollListToBottom, renderRunStatus } from './ui.js';
import { applyCorrection } from './correction.js';
import { pasteToCursor } from './clipboard.js';
import { getFrontmostApp } from './frontmost.js';
import { tryHandleSpecialCommand, learnSpecialCommand, consumeCommandMode, runCommandMode, isLikelyCommandText } from './commands.js';
import { saveEntry } from './history.js';
import { saveTotalDuration, updateEngineBadge, shouldAutoPaste, shouldAutoEnter } from './settings.js';
import { setLineTargets, setLinePasteState, specFromActiveApp } from './pastebadge.js';
import { AdaptiveVAD } from './vad.js';

// 这一批「去向还没确定」的记录行：本地引擎一句一行，百炼是几段一起粘。决策一回来就把
// 去向贴到这些行上（见 pastebadge.js），然后清空。
let pendingPasteLines = [];
function trackPasteLine(el) {
  if (el) pendingPasteLines.push(el);
  return el;
}

const VAD_SILENCE_BLOCKS = 10;
// 起说门槛：连着这么多块都在门槛以上，才认「有人说话」。
// 为什么不是一块就认（2026-09-19 用户提的）：一块就认的话，一瞬的噪声——敲键盘、
// 碰一下麦克风、鼠标点击、桌椅响——就能让菜单栏闪一下「说话中」。那种闪烁不是信息，是干扰。
// 门槛取 3 块是故意的：音频回调约 11.7 次/秒（4096 采样 @48k），3 块 ≈ 0.26 秒墙钟、
// 对应的真实音频约 85ms（降采样到 16k 后每块 256ms 的 1/3）。这个延迟人耳几乎察觉不到，
// 但足以滤掉一次性的爆音；真要挡住一秒的关门声，代价是说话后近一秒菜单栏才变，得不偿失。
const VAD_ONSET_BLOCKS = 3;
const VAD_PAD_BLOCKS = 3;
const VAD_HEARTBEAT_BLOCKS = 54;
const SILENCE_FRAMES = 16;
const SILENCE_THRESH = 300;
// 上行不通时的音频缓冲上限。单个 chunk 是 4096 字节 PCM16@16k ≈ 128ms；
// 只保留最近 10 秒，恢复连接后补发，超出部分丢弃并明确告知用户。
const PCM_BUFFER_MAX_MS = 10000;
const PCM_CHUNK_MS = 4096 / 16000 * 1000;
let adaptiveVAD = null;

export function setAsrStopHandler(handler) {
  state.asrStopHandler = handler;
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
  let ws = null;   // 本次连接的 socket；回调里一律认它，不认 state.asrWs

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
    if (state.asrWs !== ws) return;   // 这条连接早就不作数了（已停录或已重连）
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
    ws = new WebSocket(proxyUrl);
  } catch (e) {
    clearTimeout(connectTimeout);
    toast('连接失败: ' + e.message);
    return;
  }
  state.asrWs = ws;

  // 这一条连接的三个回调都只跟**自己这条 socket** 说话，不再回头去读 state.asrWs。
  // 因为 state.asrWs 随时可能已经换成下一条：停录后就没了、重连后就是新的。
  // 老写法（回调里写 state.asrWs.send / 直接改 state）在「刚连上就停录、或马上重连」时
  // 会拿到 null 或拿到新连接——轻则控制台一条 TypeError（用户看不见但没人知道它坏了），
  // 重则把旧连接的状态写回 state，把新连接误报成「没连上」。这正是「等待之后要重新确认
  // 对象身份」的那条规则：对象可能已经不是刚才那一个了。
  ws.onopen = () => {
    ws.send(JSON.stringify(connectMsg));
  };

  ws.onmessage = async (e) => {
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

      if (data.type === 'bailian-interim') {
        if (data.sentence && data.sentence.text) {
          handleASRResult(data.sentence, Date.now(), eng);
        }
        return;
      }

      if (data.type === 'connected') {
        ws.send(JSON.stringify({
          header: { action: 'run-task', task_id: state.asrTaskId, streaming: 'duplex' },
          payload: {
            task_group: 'audio', task: 'asr', function: 'recognition',
            model: 'qwen-audio-3.0-asr-flash-streaming',
            parameters: {
              format: 'pcm', sample_rate: 16000, enable_punctuation_prediction: true,
              engine: eng,   // sensevoice / qwen3 → 本地 Python 引擎切换
              qwen3_model_dir: eng === 'qwen3' && state.qwen3ModelDir ? state.qwen3ModelDir : undefined,
              vad_threshold: state.vadThreshold, vad_mode: state.vadMode,
              silence_timeout: state.silenceTimeout,
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
        if (sentence && sentence.text) handleASRResult(sentence, Date.now(), eng);
      }
    } catch (ex) {
      console.error('[ws] onmessage error:', ex);
    }
  };

  ws.onerror = () => {
    if (state.asrWs !== ws) return;   // 已经是下一条连接的事了，别把它的状态写坏
    clearTimeout(connectTimeout);
    if (connectionTimedOut) return;
    toast(`连接异常：无法连接到本地代理服务 (${proxyUrl})，请确认服务已启动`);
    state.asrReady = false;
    renderRunStatus();
  };
  ws.onclose = () => {
    if (state.asrWs !== ws) return;   // 同上：旧连接的关闭不代表现在这条断了
    clearTimeout(connectTimeout);
    state.asrReady = false;
    renderRunStatus();
  };
}

export function resetVAD() {
  adaptiveVAD = new AdaptiveVAD({ threshold: state.vadThreshold, mode: state.vadMode });
}

/**
 * 电平 → 说话状态（**唯一判断处**）。返回这次的电平与生效门槛，调用方再决定要不要送音频。
 *
 * 为什么单独抽出来：本地引擎（SenseVoice）的音频不走前端 VAD 闸门（分段由
 * asr_local/server.py 自己那套同样的自适应 VAD 做），但菜单栏的「说话中」需要同一套结论。
 * 两处各写一份判断，迟早出现「电平尺在跳、菜单栏说没人说话」。
 *
 * 起说与结束都带时间门槛（VAD_ONSET_BLOCKS / VAD_SILENCE_BLOCKS），
 * 所以菜单栏不会因为一下噪声就闪。状态真的翻转时才调 renderRunStatus()：
 * 平时状态区一秒一轮，而说话状态必须即时映上去（说完半句话才变就失去意义了）。
 */
function updateSpeechState(down) {
  let sum = 0;
  for (let i = 0; i < down.length; i++) sum += down[i] * down[i];
  const rms = Math.sqrt(sum / down.length);
  if (!adaptiveVAD) resetVAD();
  const threshold = adaptiveVAD.update(rms);
  if (state.vadMode === 'auto') state.vadThreshold = threshold;
  // 让云端引擎也使用同一套自适应门槛；手动模式则保持用户设置。
  const vadRms = state.vadMode === 'auto' ? threshold : state.vadThreshold;
  const loud = rms >= vadRms;

  if (state.vadState === 'silent') {
    // 起说要连着几块都过门槛（见 VAD_ONSET_BLOCKS）；中间掉一块就从头数，
    // 所以一瞬的爆音连不起来，不会把菜单栏点亮。
    if (loud) {
      state.vadSpeechBlocks++;
      if (state.vadSpeechBlocks >= VAD_ONSET_BLOCKS) {
        state.vadState = 'speech';
        state.vadSpeechBlocks = 0;
        state.vadSilenceCount = 0;
        // 「最近听到」的计时从**确认说话**才开始（不是每块大声都记）：
        // 否则一次 85ms 的噪声也会让菜单栏留 1.2 秒的回执——正是用户要避开的闪烁。
        state.speechHeardAt = Date.now();
        // 这里**故意不响音效**：试过两版（三角波短 tick / 正弦慢起音）用户都不要，
        // 理由与当时用过的参数写在 src/js/sfx.js 底部，不要顺手加回来。
        renderRunStatus(); // 菜单栏换成「说话中」
      }
    } else {
      state.vadSpeechBlocks = 0;
    }
  } else if (!loud) {
    state.vadSilenceCount++;
    if (state.vadSilenceCount >= VAD_SILENCE_BLOCKS) {
      state.vadState = 'silent';
      state.vadSilenceCount = 0;
      state.vadHeartbeat = 0;
      state.vadSpeechBlocks = 0;
      // 说完一句（静了约 0.85 秒）才退回：句间自然的呼吸停顿不会让字在两说法间闪
      renderRunStatus();
    }
  } else {
    // 说话中且仍在出声：刷新「最近听到」的时刻。
    // 菜单栏的「已听到」回执按它算，所以说完 30 秒的长句和说一个短词都能拿到回执；
    // 只在起说时记一次的话，长句结束时这个时间戳已经过期，回执永远不会出现。
    state.vadSilenceCount = 0;
    state.speechHeardAt = Date.now();
  }
  return { rms, threshold: vadRms };
}

/**
 * 只更新「现在有没有人在说话」，不碰发送（本地引擎用）。
 * 菜单栏的「说话中」靠它——本地引擎的音频不过前端 VAD 闸门，但说话状态是共用的。
 */
export function trackSpeech(down) {
  updateSpeechState(down);
}

export function vadSend(down, pcm) {
  const wasSilent = state.vadState === 'silent';
  updateSpeechState(down);
  const speaking = state.vadState === 'speech';

  state.vadBuf.push(pcm);
  if (state.vadBuf.length > VAD_PAD_BLOCKS) state.vadBuf.shift();

  if (wasSilent && !speaking) {
    // 一直安静：隔一阵送一块当心跳，让服务侧知道连接还活着
    state.vadHeartbeat++;
    if (state.vadHeartbeat >= VAD_HEARTBEAT_BLOCKS) {
      state.vadHeartbeat = 0;
      sendPCM(pcm);
    }
    return;
  }
  if (wasSilent && speaking) {
    // 刚起说：静默期攒下的前置音频一起送出去，首字不被切掉
    for (const b of state.vadBuf) sendPCM(b);
    return;
  }
  // 本来就在说话（含刚静下来的这一块）：照送——静音尾巴是服务侧判断句尾的依据
  sendPCM(pcm);
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

// 定型时同时保存说话时的前台应用和独立的粘贴状态。
export function finalizePending(activeApp, status) {
  if (!state.pendingLine) return;
  if (activeApp === undefined) activeApp = getFrontmostApp();
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
  saveEntry(t, activeApp, status);
}

/**
 * 这次定型粘不粘、粘给谁。一个决策两处用：真的把字送出去（applyPaste），以及随记录
 * 入库的 `activeApp` 与 `pasteStatus`。两处必须来自同一次判定，所以这里只问一次
 * 前台应用，把结果复用出去。
 *
 * 名单是按应用分的（settings.shouldAutoPaste），所以粘贴判定必须等目标回来；
 * 前台快照本身则无论自动粘贴开关是否打开都要记录。
 */
function resolvePaste(activeApp) {
  return Promise.resolve(activeApp)
    .catch(() => null)
    .then(app => ({ app, paste: !!state.autoPaste && shouldAutoPaste(app) }));
}

/** 只记录粘贴动作是否被执行，前台应用另由 activeApp 保存。 */
function deferredStatus() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

/**
 * 真的把字送出去，或者按名单决定不送。
 *
 * 不在自动粘贴名单里 → **什么都不做**：不按 Cmd+V、也不碰剪贴板，字只留在 RTC 的
 * 记录里（用户选的语义，和关掉自动粘贴一样）。在名单里 → 先 Cmd+V，再按自动发送
 * 名单决定要不要跟一个回车。
 */
function applyPaste(text, paste, lineOverride = null) {
  // 先把这一批行拿过来并清空：决策是异步的，这中间可能已经开始下一批了。
  // 指令模式的普通话使用 lineOverride，避免把这句混进下一批普通转写。
  const lines = lineOverride || pendingPasteLines;
  if (!lineOverride) pendingPasteLines = [];
  if (!paste) {
    setLinePasteState(lines, false);
    return Promise.resolve('not-pasted');
  }
  return paste
    .then(d => {
      // 图标表示说话时的前台应用，文本颜色表示是否执行自动粘贴。
      setLineTargets(lines, specFromActiveApp(d.app));
      if (!d.paste) {
        setLinePasteState(lines, false);
        return 'not-pasted';
      }
      return pasteToCursor(text, shouldAutoEnter(d.app))
        .then(status => {
          const pasted = status === 'ok';
          setLinePasteState(lines, pasted);
          return pasted ? 'pasted' : 'not-pasted';
        })
        .catch(() => {
          setLinePasteState(lines, false);
          return 'not-pasted';
        });
    })
    .catch(e => {
      setLinePasteState(lines, false);
      console.error('[paste] 粘贴决策失败，这句没有粘出去:', e);
      return 'not-pasted';
    });
}

function handleASRResult(sentence, browserReceivedAt, resultEngine) {
  const text = sentence.text;
  if (!text) return;
  const localResult = isLocalEngine(normalizeEngine(resultEngine || state.asrEngine));
  const isFinal = localResult
    ? !!(sentence.end_time > 0)
    : !!(sentence.sentence_end === true || sentence.end_time > 0);
  const corrected = applyCorrection(text);
  if (isFinal && consumeCommandMode()) {
    // 指令模式先判断：已有指令执行；普通话则继续走自动粘贴，不能因为开了指令模式而丢掉原有工作流。
    const all = $('list').querySelectorAll('.line');
    const lastLine = all.length ? all[all.length - 1] : null;
    const lastTxt = lastLine ? lastLine.querySelector('.txt') : null;
    const activeApp = getFrontmostApp();
    const statusGate = deferredStatus();
    let line = lastLine;
    if (lastTxt && lastTxt.classList.contains('interim')) {
      lastTxt.innerHTML = '';
      lastTxt.textContent = corrected;
      lastTxt.className = 'txt';
    } else {
      line = addLine(new Date(), corrected, false);
    }
    if (line) setLinePasteState([line], false);
    Promise.resolve(activeApp).then(app => {
      if (line) setLineTargets([line], specFromActiveApp(app));
    });
    saveEntry(corrected, activeApp, statusGate.promise, resultEngine);
    if (!isLikelyCommandText(corrected)) {
      // 明显是普通话时不请求模型，立即恢复自动粘贴的原有时序。
      const paste = resolvePaste(activeApp);
      applyPaste(corrected.replace(/[。！？；，、\s]+$/, ''), paste, line ? [line] : [])
        .then(status => statusGate.resolve(status));
      return;
    }
    void runCommandMode(corrected).then(handled => {
      if (handled) {
        statusGate.resolve('not-pasted');
        return;
      }
      const paste = resolvePaste(activeApp);
      applyPaste(corrected.replace(/[。！？；，、\s]+$/, ''), paste, line ? [line] : [])
        .then(status => statusGate.resolve(status));
    }).catch(() => {
      const paste = resolvePaste(activeApp);
      applyPaste(corrected, paste, line ? [line] : [])
        .then(status => statusGate.resolve(status));
    });
    return;
  }
  if (isFinal && tryHandleSpecialCommand(corrected)) {
    // 指令已执行（打开应用/触发回车等）。这句话仍是用户说的话，
    // 照常渲染到页面并存入历史，只是不再输出/粘贴到外部位。
    const all = $('list').querySelectorAll('.line');
    const lastLine = all.length ? all[all.length - 1] : null;
    const lastTxt = lastLine ? lastLine.querySelector('.txt') : null;
    const activeApp = getFrontmostApp();
    let line = lastLine;
    if (lastTxt && lastTxt.classList.contains('interim')) {
      // 指令句若已作为临时行显示，定型为最终文本，避免重复行
      lastTxt.innerHTML = '';
      lastTxt.textContent = corrected;
      lastTxt.className = 'txt';
    } else {
      line = addLine(new Date(), corrected, false);
    }
    if (line) setLinePasteState([line], false);
    Promise.resolve(activeApp).then(app => {
      if (line) setLineTargets([line], specFromActiveApp(app));
    });
    saveEntry(corrected, activeApp, 'not-pasted', resultEngine);
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

  if (localResult) {
    const all = $('list').querySelectorAll('.line');
    const lastLine = all[all.length - 1];
    const lastTxt = lastLine ? lastLine.querySelector('.txt') : null;
    const lastIsInterim = !!(lastTxt && lastTxt.classList.contains('interim'));

    if (isFinal) {
      let lineEl = null;
      if (lastIsInterim) {
        lastTxt.innerHTML = '';
        lastTxt.textContent = corrected;
        lastTxt.className = 'txt';
        lineEl = lastLine;
      } else {
        lineEl = addLine(new Date(), corrected, false);
      }
      trackPasteLine(lineEl);
      state.sentCount++;
      if ($('count')) $('count').textContent = `本次 ${state.sentCount} 句`;
      // 会粘出去：提前发起「现在最前面是谁」的查询，把目标随这句话一起记下（见
      // frontmost.js）。查询与粘贴是并行的两条路，谁也不等谁，粘贴的手感不变。
      // 粘不粘由名单定（resolvePaste / applyPaste）。
      const activeApp = getFrontmostApp();
      const paste = resolvePaste(activeApp);
      const pasteResult = applyPaste(corrected, paste);
      saveEntry(corrected, activeApp, pasteResult, resultEngine);
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
  // 百炼中间帧只更新一条临时行，不保存、不计数、不粘贴；最终帧再一次性定型。
  // sentence_id 只用来区分当前 VAD 段，不把它当中文自然句边界。
  const sentenceId = sentence.sentence_id ?? null;
  if (state.asrSentenceId !== sentenceId) {
    if (state.pendingLine) state.pendingLine.remove();
    state.pendingLine = null;
    state.asrSentenceId = sentenceId;
  }

  if (!isFinal) {
    if (!state.pendingLine) {
      state.pendingLine = addLine(new Date(), corrected, true);
    } else {
      const txt = state.pendingLine.querySelector('.txt');
      if (txt) txt.innerHTML = esc(corrected) + '<span class="cursor"></span>';
    }
    state.pendingLine._ptext = corrected;
    scrollListToBottom();
    state.asrLastText = corrected;
    return;
  }

  const activeApp = getFrontmostApp();
  const paste = resolvePaste(activeApp);
  const statusGate = deferredStatus();
  let line = state.pendingLine;
  if (line) {
    const txt = line.querySelector('.txt');
    txt.innerHTML = '';
    txt.textContent = corrected;
    txt.className = 'txt';
    state.pendingLine = null;
  } else {
    line = addLine(new Date(), corrected, false);
  }
  trackPasteLine(line);
  state.sentCount++;
  if ($('count')) $('count').textContent = `本次 ${state.sentCount} 句`;
  saveEntry(corrected, activeApp, statusGate.promise, resultEngine);
  applyPaste(corrected.replace(/[。！？；，、\s]+$/, ''), paste)
    .then(status => statusGate.resolve(status));
  state.asrLastText = corrected;
}
