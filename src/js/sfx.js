/**
 * 界面提示音：用 Web Audio 现场合成，不依赖任何音频文件。
 * 这样离线（Tauri 打包后无网络、无静态资源）也能响，且不增加打包体积/请求。
 *
 * 音量刻意压得低（0.06~0.16）：录音时麦克风仍在采集，提示音太大会被 ASR 一起识别进去。
 * 约定：
 *   playStart  —— 开始录音：上行两音（确认「已开始」）
 *   playStop   —— 停止录音：下行两音（确认「已结束」）
 *   playToggle —— 开关类按钮：开=高音 tick，关=低音 tick
 *   playPaste  —— 自动粘贴已真正发出 Cmd+V
 *
 * 「听到你说话了」这一声**已经移除**（用户 2026-09-19 用完否的）——原因和当时试过的参数
 * 见文件底部的注释，不要顺手加回来。
 */
import { state } from './state.js';

let ctx = null;

/** 惰性创建 AudioContext：首次调用来自用户点击，不会被浏览器自动播放策略拦截 */
function ac() {
  if (!state.sfxOn) return null;
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try {
      ctx = new AC();
    } catch (e) {
      return null;
    }
  }
  // 长时间空闲或系统休眠后会被挂起，播放前恢复一次
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
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
function seq(steps, type) {
  const a = ac();
  if (!a) return;
  const t0 = a.currentTime + 0.01;
  let at = t0;
  for (const [freq, peak, dur] of steps) {
    note(a, freq, at, dur, peak, type);
    at += dur * 0.75;   // 略微重叠，听感更连贯
  }
}

export function playStart() {
  seq([[659.25, 0.14, 0.11], [987.77, 0.16, 0.16]]);
}

export function playStop() {
  seq([[987.77, 0.13, 0.11], [587.33, 0.14, 0.18]]);
}

export function playToggle(on) {
  seq(on ? [[880, 0.09, 0.07]] : [[523.25, 0.08, 0.07]], 'triangle');
}

/**
 * 自动粘贴成功：两声极短的高音 tick（「已送达」）。
 *
 * 音高比 playStart 更高、时长更短、峰值更低（0.07 对 0.14），因为这一声是
 * 每句话都会响的：粘贴在录音进行中触发，麦克风仍在采集，太响既会被 ASR
 * 拾进去，也会很快变成噪音。用 triangle 与录音起止的 sine 拉开音色区分。
 */
export function playPaste() {
  seq([[1046.5, 0.07, 0.045], [1567.98, 0.075, 0.07]], 'triangle');
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
