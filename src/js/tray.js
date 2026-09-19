/**
 * macOS 菜单栏（屏幕顶部状态栏）图标 —— 应用在后台时唯一能回答
 * 「现在到底有没有在工作、有没有听见我」的地方。
 *
 * 为什么需要它：典型用法是把本窗口丢在别的软件后面，一边在微信/浏览器里说话一边等字出来。
 * 这时候主界面状态区（footer 右侧那行字）根本看不见，用户唯一的办法是切回本窗口看一眼。
 *
 * 三条硬约束：
 * 1. **状态判断只在一处**：这里不重新判断状态，只把 ui.js 的 computeRunStatus 的结论
 *    翻译成「用哪个字形 + 什么颜色」（产品原则 3）。菜单栏和主界面说两套话比没有菜单栏更糟。
 * 2. **只放图标，不放文字**（用户 2026-09-19 明确要求）：状态全靠**图形 + 颜色**表达，
 *    那一格不占宽度。要看具体说法、原因和下一步，悬停有 tooltip，点开就是主界面。
 * 3. **旁路**：invoke 失败（网页版、Rust 侧还是旧版本、命令报错）只记一条 console 警告，
 *    绝不抛错、不弹提示、不挡录音（产品原则 4）。
 *
 * 字形资源在 Rust 侧（src-tauri/icons/tray/*.png，Lucide 图标，ISC 协议），
 * 五个字形互斥且语义各自成立 —— 图形不能说和状态相反的话：
 *   idle          待命：麦克风（没在录）
 *   dot           在录、还没听到声音：一个圆点（就是「录音灯」）
 *   speaking      正在说话：电平柱（波浪形）
 *   mic-off       输入侧异常：带斜杠的麦克风
 *   service-error 服务侧异常：警告三角
 *
 * **两个通道各管一件事**（用户 2026-09-19 定的方案：形状说「在不在录」，颜色说「有没有在说话」）：
 *   字形：麦克风 = 没在录；圆点 = 在录（录音灯）；**波浪 = 正在说话**（他说这一档用波浪更直观）
 *   颜色：无色（黑白模板）= 没听到声音；橙 = 正听到你说话；红 = 出事了
 * 为什么这样分：形状回答「在不在录」是一眼可辨的（麦克风还是圆点，两个完全不同的东西）；
 * 颜色回答「有没有在说话」。如果只靠形状（比如空心 / 实心麦克风）分前两个，那点差别
 * 在一格 18pt 的小图标上要盯着看才分得出。
 * 橙只给「正在说话」：常亮的颜色会变成背景，只有难得的颜色才是信号。
 * 红只给「出事」：三种颜色不互借，同一件事不许有两种意思。
 *
 * 「说话中」这条也是 2026-09-19 提的：菜单栏上跑着录音时长对他没有价值——
 * 他不说话时那个数字也在跑。他要的是「我的话被听见了吗」。所以时长撤掉，
 * 换成由 VAD 结论驱动的电平柱。主界面不需要它：那里有电平尺，条子随音量跳就是同一回事。
 *
 * 这里只读 state 的一个字段（speechHeardAt，说完后的「已听到」回执）；
 * 说话判定本身完全在 asr.js 的 updateSpeechState 里，不在这里。
 */
import { state } from './state.js';

const GLYPHS = {
  ready: 'idle',
  // 在录的三种说法共用同一个字形（圆点）：它们之间的差别在「听没听到声音」，
  // 那是颜色的事——实心圆点（模板）= 在录等你开口，橙色圆点 = 正在说话。
  recording: 'dot',
  recognizing: 'dot',
  connecting: 'dot',
  'mic-error': 'mic-off',
  'no-audio': 'mic-off',
  offline: 'service-error',
  'model-down': 'service-error',
};

/** 异常字形：这两类优先于一切（包括「说话中」）——出事了不许被一个“听到声音”盖过去 */
const ABNORMAL_GLYPHS = new Set(['mic-off', 'service-error']);

/**
 * 正在说话时那块**背景底**的橙色（用户 2026-09-19 看到别的 App 的样式后要的「一个很大的很亮的背景色」，
 * 色值 #FF9230 也是他指定的）。形状是**胶囊**：两端的圆角半径取高度的一半，由 Rust 侧按按钮高度算。
 *
 * 它不是画在图片里的，而是画在菜单栏项自己的按钮图层上——因为**图片最高只能 18pt**
 * （tray 固定按高 18pt 渲染），而系统那块点击高亮底更高；用户要的是「和那个高度一致」，
 * 所以只能让系统自己给高度（见 src-tauri/src/lib.rs 的 paint_tray_background）。
 */
export const TONE_SPEAKING = '#FF9230';

/** 出错的深红。同样按「浅底深底都能看清」选的（浅底约 5.0:1，深底约 4.2:1）。
 *  异常不借橙色：橙已经表示「正在说话」，同一件事不许借用别人的颜色。 */
const TONE_ERROR = '#D93025';

/** 在录但安静的字形：圆点（录音灯） */
export const RECORDING_GLYPH = 'dot';

/** 正在说话的字形：电平柱（波浪形） */
export const SPEAKING_GLYPH = 'speaking';

/**
 * 正在说话时那根柱子画成白色——它是画在橙色底块上的。
 * 不用「跟随系统明暗」的黑白模板：底块是橙的，柱子必须与背景拉开对比，
 * 而黑白会跟着系统换，在浅色菜单栏上变成黑柱子压在橙底上（对比更差）。
 *
 * 注意：#FF9230 比之前的橙色浅，白柱子在它上面的对比度只有约 2:1（看着会偏"淡"）。
 * 觉得糊的话把这里换成深色（例如 #5A2A00，约 9:1）就能立起来——只改这一个值。
 */
export const SPEAKING_INK = '#FFFFFF';

/**
 * 「已听到」回执：最近一次听到声音之后这一小段时间内，菜单栏的圆点继续是橙的。
 *
 * 为什么需要（用户 2026-09-19 提的音效背后其实是同一件事）：他关心的是「我的话被听到了吗」。
 * 如果一停下就立刻变回白圆点，回馈就变成了「没了」——用户分不清是「听到了、已经结束」
 * 还是「压根没听见」。这一小段让每次说话都有一个看得见的收尾。
 * 它在状态上仍然是「识别中」（没有造新状态），只是字形多留一会儿。
 *
 * 取 1.2 秒的理由：它要盖住两件事——句间自然停顿（否则每句都闪一下），
 * 以及说完之后那 0.85 秒的「静音确认」窗口；再加上一点余量，用户才来得及看到。
 * 计时从**最近一次听到声音**算（state.speechHeardAt 每块大声都刷新），
 * 不是从起说算——否则说完一个 30 秒的长句时，时间戳已经过期，回执永远不会出现。
 */
export const HEARD_GRACE_MS = 1200;

/**
 * 菜单栏这一格要显示什么。**只有字形和颜色，没有文字**（见文件头第 2 条）。
 *
 * 空闲一个字也不写。形状：没在录 = 麦克风，在录 = 圆点。颜色：橙 = 正在说话，
 * 红 = 出事（压倒一切），其余是黑白模板图。
 *
 * @param {{key:string,text:string,time:string}} st computeRunStatus 的结论
 * @param {boolean} speaking 现在是否检测到说话（state.vadState === 'speech'）
 * @param {number} [now] 当前时刻（ms），只有测试会传——不传就用 Date.now()
 * @returns {{glyph:string, color:string|null}|null} color=null 表示黑白模板图
 */
export function trayView(st, speaking = false, now = Date.now()) {
  const glyph = trayGlyphFor(st.key);
  if (!glyph) return null; // 没见过的状态：不猜（维持上一次的图标，也比给个可能相反的图好）
  // 出事：红压倒一切，包括「正在说话」
  if (ABNORMAL_GLYPHS.has(glyph)) return { glyph, color: TONE_ERROR, background: null };
  // 没在录：黑白模板图（麦克风），也没有底色
  if (st.time !== 'rec') return { glyph, color: null, background: null };
  // 在录：安静是黑白圆点（= 在等你开口）；听到声音就换成白柱子 + 橙色底块
  // （说完的一小段沿用，就是「已听到」的回执）
  const heardRecently = state.speechHeardAt > 0 && now - state.speechHeardAt < HEARD_GRACE_MS;
  if (speaking || heardRecently) {
    return { glyph: SPEAKING_GLYPH, color: SPEAKING_INK, background: TONE_SPEAKING };
  }
  return { glyph, color: null, background: null };
}

/**
 * 是否处于「已听到」回执窗口（供 syncTrayStatus 排到期定时器用）
 * @param {number} now
 */
export function inHeardGrace(now = Date.now()) {
  return state.speechHeardAt > 0 && now - state.speechHeardAt < HEARD_GRACE_MS;
}

/** 状态 key → 字形名；没见过的 key 返回 null（不猜，测试会兜住新增状态漏配） */
export function trayGlyphFor(key) {
  return GLYPHS[key] || null;
}

/** 导出给测试用：状态的 key 清单和字形表必须一一对应（多一个少一个都是漏配） */
export const TRAY_GLYPHS = GLYPHS;

/** 上一次真正推给菜单栏的内容，用来去重（空闲时每秒重渲染一次，不能每秒都发 IPC） */
let lastSent = null;
let warned = false;
// 「已听到」回执到期后要把菜单栏改回去，但那一刻可能没有任何事件来触发渲染
// （用户已经安静了，音频回调里也不会翻转状态），所以自己排一个定时器。
// 它只是「让下一次渲染发生」，渲染逻辑仍然只有 renderRunStatus 一处。
let graceTimer = null;

/**
 * 把当前状态推到菜单栏。由 ui.js 的 renderRunStatus 调用（那是唯一的状态渲染入口），
 * 以及 asr.js 的 updateSpeechState 在说话/安静切换时调用（说话要即时映上去，不等秒级轮询）。
 * @param {{key:string,text:string,time:string}} st computeRunStatus 的结论
 * @param {{speaking?:boolean, onExpire?:() => void}} [opts]
 *   speaking = 现在是否检测到说话；onExpire = 「已听到」回执到期时叫谁重渲染一次
 */
export function syncTrayStatus(st, { speaking = false, onExpire } = {}) {
  const invoke = window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke;
  if (!invoke) return; // 网页版没有系统菜单栏，静默跳过
  const now = Date.now();
  const view = trayView(st, speaking, now);
  if (!view) return;

  // 回执期间字形留着不变（没有文字可掉），到期时自己叫一次重渲染——
  // 那一刻用户已经安静，音频回调里不会再翻转状态，没有别的机会把图标改回去。
  if (inHeardGrace(now) && !speaking && st.time === 'rec' && onExpire) {
    const left = Math.max(0, HEARD_GRACE_MS - (now - state.speechHeardAt));
    if (graceTimer) clearTimeout(graceTimer);
    graceTimer = setTimeout(() => { graceTimer = null; onExpire(); }, left + 40);
  }

  // tooltip 是唯一能写字的地方（图标边上不放文字）：把状态说清楚，异常还带下一步去哪
  const tooltip = `实时逐字稿 · ${st.text}｜点击打开主界面`;
  const sig = `${view.glyph}|${view.color || 'mono'}|${view.background || 'none'}|${tooltip}`;
  if (sig === lastSent) return;
  invoke('set_tray_status', {
    glyph: view.glyph,
    color: view.color,
    background: view.background,
    tooltip,
  })
    .then(() => { lastSent = sig; })
    .catch((e) => {
      // 只喊一次：开发模式下 Rust 侧改了但没整体重启时，这条会每秒命中一次
      if (!warned) {
        warned = true;
        console.warn('[tray] 菜单栏状态更新失败（改过 Rust 后需要整体重启 dev）:', e);
      }
    });
}
