/**
 * 界面提示音统一走 Web Audio：录音开始 / 停止 / 自动粘贴成功都播放随应用打包的 WAV
 * （起止音取自 Chatterfly，粘贴成功复用停止音），只有开关反馈仍现场合成。
 * 所有资源都在本地，离线可用。
 *
 * 音量刻意压得低（0.06~0.16）：录音时麦克风仍在采集，提示音太大会被 ASR 一起识别进去。
 * 约定：
 *   playStart  —— 开始录音：确认「已开始」
 *   playStop   —— 停止录音：确认「已结束」
 *   playToggle —— 开关类按钮：开=高音 tick，关=低音 tick
 *   playPaste  —— 自动粘贴已真正发出 Cmd+V（2026-09-20 起复用停止音；
 *                 同一次录音里刚响过停止音就静默，避免连着响两下）
 *
 * 「听到你说话了」这一声**已经移除**（用户 2026-09-19 用完否的）——原因和当时试过的参数
 * 见文件底部的注释，不要顺手加回来。
 */
import { state } from './state.js';

let ctx = null;

const sampleUrls = {
  start: new URL('./assets/speech_start.wav', import.meta.url),
  stop: new URL('./assets/speech_stop.wav', import.meta.url),
};
const sampleBytes = new Map();
const sampleBuffers = new Map();

// 用户 2026-09-20 要求开始音与结束音都弱化到原来的 60%。
// 粘贴成功复用结束音，因此自然共用这个音量，不再另设一套。
export const SAMPLE_VOLUME = 0.6;

function fetchSample(name) {
  if (!sampleBytes.has(name)) {
    const url = sampleUrls[name];
    const pending = fetch(url).then((response) => {
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      return response.arrayBuffer();
    }).catch((error) => {
      sampleBytes.delete(name);
      throw error;
    });
    sampleBytes.set(name, pending);
  }
  return sampleBytes.get(name);
}

// 模块加载时只预取字节，不提前创建 AudioContext。后者必须由用户动作触发，
// 否则 WKWebView 的自动播放策略会把上下文挂起，第一次点录音反而可能没声音。
for (const name of Object.keys(sampleUrls)) void fetchSample(name).catch(() => {});

/** 惰性取得 AudioContext：优先复用已经运行的录音上下文，避免快捷键路径被静默拦截 */
function ac() {
  if (!state.sfxOn) return null;
  if (ctx && ctx.state === 'closed') ctx = null;   // 被系统判死过的上下文不能再用
  // 录音已经启动时复用其 running context，尤其覆盖原生快捷键路径：
  // 该路径没有浏览器 user activation，另建 AudioContext 会被 WKWebView 挂起。
  if (state.audioCtx && state.audioCtx.state === 'running'
      && (!ctx || ctx.state !== 'running')) {
    // 丢弃此前被快捷键路径创建、但被 WebKit 挂起的提示音上下文。
    ctx = state.audioCtx;
  }
  if (!ctx && state.audioCtx && state.audioCtx.state !== 'closed') ctx = state.audioCtx;
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try {
      ctx = new AC();
    } catch (e) {
      return null;
    }
  }
  return ctx;
}

// 只在第一次拉不回来时提醒一次，不要每句提示音都刷屏（正常说话一个人能刷出很多条）
let warnedNotRunning = false;

/**
 * 出声前把音频上下文拉回 running。返回 false 表示这一次声音不会响。
 *
 * **只认 'suspended' 是错的** —— WebKit 还有一个 'interrupted'：系统睡眠、或音频会话被
 * 别的应用抢走（开会、切会议软件）之后就是它。它不是 suspended，所以旧写法一辈子不会
 * resume，上下文从此哑着：界面一切正常，一声不响也不报错。录音那条路已经踩过同一个坑
 * （见 audio.js 顶部的 audioStateAction），这里改成与它同一套判据。
 *
 * 'interrupted' 也能被 resume() 拉回来，所以不做“重建上下文”那种自作主张的事：
 * 每次出声都拉一把，与 audio.js 的看护方式保持一致（能救就先救）。
 */
async function ready(a) {
  if (a.state === 'running') { warnedNotRunning = false; return true; }
  if (a.state === 'closed') return false;
  try { await a.resume(); } catch (e) { /* 唤醒竞态下 resume 会抛，按最终状态判 */ }
  if (a.state === 'running') { warnedNotRunning = false; return true; }
  if (!warnedNotRunning) {
    warnedNotRunning = true;
    console.warn(`[sfx] 音频上下文没回到 running（state=${a.state}）：提示音不会响。`);
  }
  return false;
}

/**
 * 单个音符：指数包络避免爆音（起音 12ms 上扬，尾音自然衰减）。
 *
 * 曾经有过一个 attack 参数，给「听到你说话了」那声柔和提示音用（45ms 慢起音去点击感）。
 * 那声已经被移除，参数一并收掉：留着就是没人用的死代码。
 */
function note(a, freq, at, dur, peak, type) {
  const osc = a.createOscillator();
  const gain = a.createGain();
  osc.type = type || 'sine';
  osc.frequency.setValueAtTime(freq, at);
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(peak, at + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  osc.connect(gain).connect(a.destination);
  osc.start(at);
  osc.stop(at + dur + 0.02);
}

/** 依次播放一串 [频率, 峰值, 时长] */
async function seq(steps, type) {
  const a = ac();
  if (!a || !(await ready(a))) return;
  const t0 = a.currentTime + 0.01;
  let at = t0;
  for (const [freq, peak, dur] of steps) {
    note(a, freq, at, dur, peak, type);
    at += dur * 0.75;   // 略微重叠，听感更连贯
  }
}

function decodeSample(a, bytes) {
  // Safari 旧版只走回调，新版返回 Promise；这里兼容两种，而且防止新版两边同时完成。
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    try {
      const result = a.decodeAudioData(bytes.slice(0), done, fail);
      if (result && typeof result.then === 'function') result.then(done, fail);
    } catch (error) {
      fail(error);
    }
  });
}

function loadSample(a, name) {
  if (!sampleBuffers.has(name)) {
    const pending = fetchSample(name)
      .then((bytes) => decodeSample(a, bytes))
      .catch((error) => {
        sampleBuffers.delete(name); // 临时加载失败后，下一次操作会重新请求并解码
        throw error;
      });
    sampleBuffers.set(name, pending);
  }
  return sampleBuffers.get(name);
}

function playSample(name) {
  const a = ac();
  if (!a) return;
  void loadSample(a, name).then(async (buffer) => {
    // 解码是异步的，这一小段时间里音频会话可能又被系统拿走了（用户切去开会），
    // 所以指定到真正要出声这一刻再确认一次上下文还能动。
    if (!(await ready(a))) return;
    const source = a.createBufferSource();
    const gain = a.createGain();
    source.buffer = buffer;
    gain.gain.setValueAtTime(SAMPLE_VOLUME, a.currentTime);
    source.connect(gain).connect(a.destination);
    source.start();
  }).catch((error) => {
    console.warn(`[sfx] ${name} 音效加载失败:`, error);
  });
}

// 手动停止录音后，服务端可能还会返回最后一句并粘贴。结束音与粘贴音是
// 同一段 WAV，所以只静音紧跟着的**一次**粘贴，消费后立即恢复。
//
// 按住说话不能借用这个全局标记：它松手后底层录音继续，没有下一次 playStart
// 来复位。那一句是否静音由识别结果自己携带（clipboard.js 的 suppressSound）。
let suppressNextPasteSound = false;

export function playStart() {
  suppressNextPasteSound = false;
  playSample('start');
}

export function playStop({ suppressNextPaste = true } = {}) {
  suppressNextPasteSound = suppressNextPaste;
  playSample('stop');
}

export function playToggle(on) {
  // seq 现在是 async（出声前要先确认音频上下文还活着），这里不接它的返回值：
  // 接住了也不会有额外好处，但漏掉 catch 会在控制台留一条 unhandled rejection。
  void seq(on ? [[880, 0.09, 0.07]] : [[523.25, 0.08, 0.07]], 'triangle').catch(() => {});
}

/**
 * 自动粘贴成功：与停止录音共用同一段 WAV。
 *
 * 2026-09-20 用户的决定：原来现场合成的两声高音 tick 撤掉，粘贴成功直接播停止音。
 * 这样「一句话落地」的两个时刻（停录、上屏）听感一致，也少维护一种自造音色。
 *
 * 按住说话的结果显式传 suppress=true：松手已经响过结束音，该句上屏不重复响。
 * 手动停录的兼容标记只消费一次；不得把后续连续听写的粘贴音永久压住。
 */
export function playPaste({ suppress = false } = {}) {
  if (suppress) return;
  if (suppressNextPasteSound) {
    suppressNextPasteSound = false;
    return;
  }
  playSample('stop');
}

// ---------------------------------------------------------------------------
// 「听到你说话了」那一声为什么没有了
//
// 2026-09-19 用户提的需求：「判定到确实有在输入时，给我一个弱的音效，表示当前正在录」。
// 做了两版，两版都被他否了：
//   v1  880Hz 三角波，12ms 起音，50ms，峰值 0.05  → 「太轻，而且声音的方式我不喜欢」
//   v2  740Hz 正弦，45ms 起音，200ms，峰值 0.11    → 「太明显了，把音效移除掉吧」
// 他最终要的是「没有」——所以现在起说时**不响任何声音**，只靠菜单栏那个橙色胶囊。
//
// 这条要留着的原因（不要顺手把它加回来）：
//   1. 这一声**每句话开头都会响**，频次和你的句子一样高。一段话里每句都被打断一次，
//      存在感会迅速盖过它携带的信息——「柔和的三个条件」（正弦 / 慢起音 / 长尾巴）
//      解决的是「刺耳」，解决不了「每句都来一下」；
//   2. 它想回答的问题（我的话被听到了吗）菜单栏已经在答：那片区域永久可见、且不占听觉，
//      而提示音占的是听觉——一个会反复响的东西，代价比一块常驻的像素大得多；
//   3. 麦克风此时在采集，提示音本身有被录进转写的风险（靠 EchoCancellation 抵消，
//      而用户关掉降噪时它就失效）。
// 如果以后真要把它加回来（比如只在不看窗口时响），v2 的参数在上面，直接拿。
// ---------------------------------------------------------------------------
