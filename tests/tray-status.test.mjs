import assert from 'node:assert/strict';
import { state } from '../src/js/state.js';
import { computeRunStatus } from '../src/js/ui.js';
import { trayGlyphFor, trayView, RECORDING_GLYPH, SPEAKING_GLYPH, SPEAKING_INK, TONE_SPEAKING, TRAY_GLYPHS } from '../src/js/tray.js';

// 两个通道各管一件事：**字形说「在不在录」，颜色说「有没有在说话」**
// （用户 2026-09-19 定的方案：默认白麦克风 / 识别中白圆点 / 说话橙色波浪）
//   没在录 → 麦克风 + 黑白  在录未说话 → 圆点 + 黑白  正在说话 → 波浪 + 橙  出事 → 红
const IDLE_COLOR = null;
const ERROR = '#D93025';

// 菜单栏（macOS 顶部状态栏）图标：应用在后台时唯一能看到「现在到底有没有在工作」的地方。
//
// 这里钉的不是「图标好不好看」，而是两件会在安静中坏掉的事：
//   1. 状态机以后加了新状态，菜单栏却什么都不显示 —— 用户以为程序没在录，其实在录（或反过来）。
//      所以两头都要对上：状态机产出的每个 key 都得有字形，字形表里也不许留已经没人用的 key。
//   2. 图标和文字说相反的话：麦克风坏了却给一个「服务」图标，服务挂了却给「麦克风」图标。
//      字形按「输入侧 / 服务侧」分开，就是为了让图标至少不说谎。
//
// 测试只读 state 并调用纯函数，不起服务、不碰 DOM、不碰真实转写记录。

let passed = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { passed += 1; console.log(`  ✓ ${name}`); }
  else { failures.push(name); console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
}

// ui.js 的 serverReachable() 会读 WebSocket.OPEN。node 22+ 自带 WebSocket，
// 老版本没有 —— 补一个常量，免得测试因为环境差异报 ReferenceError。
if (typeof globalThis.WebSocket === 'undefined') {
  globalThis.WebSocket = { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 };
}
const WS_CONNECTING = 0;
const WS_OPEN = 1;

/** 摆好状态机关心的字段 */
function setup({ serverOk, modelServiceOk, recording = false, micError = '', noAudio = false, asrReady = false, ws = null }) {
  state.serverOk = serverOk;
  state.modelServiceOk = modelServiceOk;
  state.recording = recording;
  state.micError = micError;
  state.audioStalled = noAudio;
  state.asrReady = asrReady;
  state.asrWs = ws === null ? null : { readyState: ws };
  state.asrEngine = 'sensevoice';
}

// —— 把状态机所有分支跑一遍，收集它真的会产出的 key ——
const scenarios = {
  ready: () => setup({ serverOk: true, modelServiceOk: true }),
  'connecting（空闲起步）': () => setup({ serverOk: null, modelServiceOk: null }),
  'mic-error': () => setup({ serverOk: true, modelServiceOk: true, micError: '权限被拒' }),
  offline: () => setup({ serverOk: false, modelServiceOk: true }),
  'model-down': () => setup({ serverOk: true, modelServiceOk: false }),
  'no-audio': () => setup({ serverOk: true, modelServiceOk: true, recording: true, noAudio: true }),
  'offline（录音中）': () => setup({ serverOk: false, modelServiceOk: true, recording: true }),
  'model-down（录音中）': () => setup({ serverOk: true, modelServiceOk: false, recording: true }),
  'connecting（录音中）': () => setup({ serverOk: true, modelServiceOk: true, recording: true, ws: WS_CONNECTING }),
  'connecting（任务协商中）': () => setup({ serverOk: true, modelServiceOk: true, recording: true, ws: WS_OPEN, asrReady: false }),
  recording: () => setup({ serverOk: true, modelServiceOk: true, recording: true }),
  recognizing: () => setup({ serverOk: true, modelServiceOk: true, recording: true, asrReady: true, ws: WS_OPEN }),
};

const produced = new Map(); // key → 一次真实结论
for (const [label, run] of Object.entries(scenarios)) {
  run();
  const st = computeRunStatus();
  if (!produced.has(st.key)) produced.set(st.key, st);
  else console.log(`  · ${label} 落到已见过的状态 ${st.key}（正常，状态机有优先级）`);
}

// —— 1) 每个状态都得有字形 ——
for (const [key, st] of produced) {
  check(`状态 ${st.text}（${key}）在菜单栏有对应图标`, !!trayGlyphFor(key), '字形表漏了这个状态，菜单栏会停在旧图标上');
}

// —— 2) 两头都不许多：字形表里不留没人用的 key（状态改名后最容易留下僵尸映射）——
const unused = Object.keys(TRAY_GLYPHS).filter((k) => !produced.has(k));
check('字形表没有多余 / 已废弃的 key', unused.length === 0, `多余: ${unused.join(', ')}`);

// —— 3) 菜单栏那一格只放图标：没有文字，状态靠字形 + 颜色 ——
// （用户 2026-09-19 要求：图标边上的文字全部去掉，默认状态的文字也不要）
setup({ serverOk: true, modelServiceOk: true });
check('① 没在录：麦克风 + 黑白（软件开着但没按录音）', trayView(computeRunStatus()).glyph === 'idle' && trayView(computeRunStatus()).color === IDLE_COLOR);
check('任何状态都不带文字（返回值里根本没有 title 这个字段）', !('title' in trayView(computeRunStatus())));

function recordingState() {
  setup({ serverOk: true, modelServiceOk: true, recording: true, asrReady: true, ws: WS_OPEN });
  return computeRunStatus();
}

check('② 在录但还没说话：圆点 + 黑白（按了录音、等你开口）', trayView(recordingState(), false).glyph === RECORDING_GLYPH && trayView(recordingState(), false).color === IDLE_COLOR);
check('③ 正在说话：换成白波浪 + 橙色底块', trayView(recordingState(), true).glyph === SPEAKING_GLYPH
  && trayView(recordingState(), true).color === SPEAKING_INK
  && trayView(recordingState(), true).background === TONE_SPEAKING);
check('② 在录、安静时没有底色（底色只表示「听到你说话了」）', trayView(recordingState(), false).background === null);
check('① 没在录也没有底色', trayView(computeRunStatus()).background === null);
setup({ serverOk: true, modelServiceOk: true });
check('没在录：黑白', trayView(computeRunStatus()).color === IDLE_COLOR);
check(
  '①②③ 三个状态两两可分（字形与颜色至少有一处不同）',
  (() => {
    setup({ serverOk: true, modelServiceOk: true });
    const s1 = trayView(computeRunStatus());
    const s2 = trayView(recordingState(), false);
    const s3 = trayView(recordingState(), true);
    const same = (a, b) => a.glyph === b.glyph && a.color === b.color;
    return !same(s1, s2) && !same(s2, s3) && !same(s1, s3);
  })(),
);
check(
  '① 和 ② 只差字形（麦克风 vs 圆点），② 和 ③ 字形与颜色都变——三种状态各自一眼可辨',
  (() => {
    setup({ serverOk: true, modelServiceOk: true });   // 先摆好 ① 再取快照：
    const s1 = trayView(computeRunStatus());            // recordingState() 会改 state，
    const s2 = trayView(recordingState(), false);       // 不先取快照的话后面读到的就不是 ① 了
    const s3 = trayView(recordingState(), true);
    return s1.color === s2.color && s1.glyph !== s2.glyph
      && s2.color !== s3.color && s2.glyph !== s3.glyph;
  })(),
);
check('橙色底块只给「正在说话」：在录但没说话不沾它', trayView(recordingState(), false).background === null);

setup({ serverOk: true, modelServiceOk: true, micError: '权限被拒' });
check('麦克风不可用：带斜杠的麦克风 + 红', trayView(computeRunStatus()).glyph === 'mic-off' && trayView(computeRunStatus()).color === ERROR);
check('异常不带橙色底块（红与橙不混用）', trayView(computeRunStatus(), true).background === null);
check('异常的红压倒「说话中」（不许被一个“听到声音”盖过去）', trayView(computeRunStatus(), true).color === ERROR && trayView(computeRunStatus(), true).glyph === 'mic-off');

setup({ serverOk: true, modelServiceOk: false });
check('模型服务未启动：警告三角 + 红', trayView(computeRunStatus()).glyph === 'service-error' && trayView(computeRunStatus()).color === ERROR);

setup({ serverOk: null, modelServiceOk: null });
check('启动瞬间的「正在连接」保持黑白（不闪一下色）', trayView(computeRunStatus()).color === null);

// 录音中还在协商（连 ASR 任务都没就绪）：麦克风确实听到了声音，所以照样上橙——
// 电平柱说的只是「麦克风听到了声音」，这件事在连接完成前就已经是真的。
// 卡在哪由 tooltip 和主界面负责说（菜单栏已经没有文字了）。
setup({ serverOk: true, modelServiceOk: true, recording: true, ws: WS_CONNECTING });
check(
  '录音中还在连接、但确实听到声音：仍然是橙底白波浪',
  trayView(computeRunStatus(), true).glyph === SPEAKING_GLYPH
    && trayView(computeRunStatus(), true).background === TONE_SPEAKING,
);
check('录音中还在连接、没听到声音：圆点 + 黑白（在录这件事已经成立）', trayView(computeRunStatus(), false).glyph === RECORDING_GLYPH && trayView(computeRunStatus(), false).color === IDLE_COLOR);

// —— 4) 图标不能说和状态相反的话 ——
// —— 4) 图标不能说和文字相反的话 ——
const cases = [
  ['麦克风不可用', { serverOk: true, modelServiceOk: true, micError: '权限被拒' }, 'mic-off'],
  ['没有声音输入', { serverOk: true, modelServiceOk: true, recording: true, noAudio: true }, 'mic-off'],
  ['服务未连接', { serverOk: false, modelServiceOk: true }, 'service-error'],
  ['模型服务未启动', { serverOk: true, modelServiceOk: false }, 'service-error'],
  ['就绪', { serverOk: true, modelServiceOk: true }, 'idle'],
];
for (const [label, input, want] of cases) {
  setup(input);
  const got = trayGlyphFor(computeRunStatus().key);
  check(`${label} → ${want}`, got === want, `实际=${got}`);
}

// 没见过的状态：不猜（宁可停在旧图标，也不给一个可能相反的字形）
check('未知状态不给字形', trayGlyphFor('some-future-state') === null);

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('失败项:\n  - ' + failures.join('\n  - '));
  process.exit(1);
}
