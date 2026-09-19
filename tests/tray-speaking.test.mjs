import assert from 'node:assert/strict';

// 说话状态（VAD）与菜单栏「说话中」的守门检查。
//
// 为什么需要（2026-09-19 用户提的需求）：
//   菜单栏上跑着录音时长对用户没有价值——他不说话时那个数字也在跑。他要的是
//   「当前我正在说话，它检测到音量，而且音量符合要求」。所以菜单栏改成由 VAD 结论
//   驱动的「说话中」。
//
// 这里钉三件事，每一件都会在安静中坏掉：
//   1) 本地引擎（SenseVoice，默认引擎）的音频**不过前端 VAD 闸门**——分段由
//      asr_local/server.py 自己那套同样的自适应 VAD 做。如果「说话状态」只在
//      云端引擎那条路径上更新，用户用默认引擎时菜单栏永远不会说「说话中」，
//      而且没有任何报错。所以 audio.js 必须为本地引擎也调 trackSpeech。
//   2) 状态翻转必须**立刻**重渲染，不能等一秒一轮的轮询：用户说完半句话菜单栏才变，
//      这个功能就白做了。
//   3) 停录时说话状态必须跟着归零：在「说话中」按下停止（或连接断了自动停），
//      菜单栏不许把「说话中」留在那里——录都没在录了还说有人说话，就是假状态。
//
// audio.js / asr.js 会（经 commands.js）碰到 document，所以给一个最小桩让模块加载起来。
// 被测的是纯函数与状态机，不读真实 DOM、不起服务、不碰转写记录。

globalThis.document = {
  readyState: 'complete',
  addEventListener() {},
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
};
// 状态翻转时会走 renderRunStatus → syncTrayStatus，它第一件事就是看有没有 Tauri。
// 网页版/测试里没有，这里给个空的（也就是「不是桌面端」这条真实分支）。
globalThis.window = { addEventListener() {}, __TAURI__: null };

const { state } = await import('../src/js/state.js');
const { trackSpeech, vadSend, resetVAD } = await import('../src/js/asr.js');
const { trayView, HEARD_GRACE_MS, TONE_SPEAKING } = await import('../src/js/tray.js');
const { computeRunStatus } = await import('../src/js/ui.js');
const fs = await import('node:fs');
const path = await import('node:path');
const { fileURLToPath } = await import('node:url');

let passed = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { passed += 1; console.log(`  ✓ ${name}`); }
  else { failures.push(name); console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readSrc = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

// —— 摆好录音中、服务正常的状态 ——
function setupRecording() {
  state.serverOk = true;
  state.modelServiceOk = true;
  state.recording = true;
  state.micError = '';
  state.audioStalled = false;
  state.asrEngine = 'sensevoice';
  state.asrReady = true;
  state.asrWs = { readyState: 1, send() {} };
  state.vadMode = 'manual';
  state.vadThreshold = 0.006;
  state.vadState = 'silent';
  state.vadSilenceCount = 0;
  state.vadHeartbeat = 0;
  state.vadBuf.length = 0;
  resetVAD();
}

const loud = new Float32Array(4096).fill(0.05);
const quiet = new Float32Array(4096).fill(0.0001);
const pcm = new Int16Array(4096);

// —— 0) 起说门槛：一瞬的噪声不许点亮「说话中」（用户 2026-09-19 提的）——
// 一块大声 = 约 85ms 真实音频，人耳几乎察觉不到，但敲键盘/碰麦克风就是这种长度。
setupRecording();
trackSpeech(loud);
check('单独一块大声（约 85ms 噪声）→ 还不算说话中', state.vadState === 'silent');
check(
  '于是菜单栏仍是黑白圆点（没换成波浪、也没变橙）',
  trayView(computeRunStatus(), state.vadState === 'speech').glyph === 'dot'
    && trayView(computeRunStatus(), state.vadState === 'speech').color === null,
);
trackSpeech(quiet);
for (let i = 0; i < 2; i++) trackSpeech(loud);
check('噪声断开后又来两块 → 计数从头数，仍不算', state.vadState === 'silent');
trackSpeech(loud);
check('连着 3 块过门槛 → 认「说话中」', state.vadState === 'speech');

// —— 1) 本地引擎也能得出「说话中」——
setupRecording();
for (let i = 0; i < 3; i++) trackSpeech(quiet);
check('安静时 vadState 保持 silent', state.vadState === 'silent');
for (let i = 0; i < 3; i++) trackSpeech(loud);
check('连续 3 块大声 → vadState = speech（本地引擎靠 trackSpeech）', state.vadState === 'speech');
check(
  '于是菜单栏换成橙色波浪（字形和颜色一起变）',
  trayView(computeRunStatus(), state.vadState === 'speech', Date.now() + 60_000).glyph === 'speaking'
    && trayView(computeRunStatus(), state.vadState === 'speech', Date.now() + 60_000).background === TONE_SPEAKING,
);

// —— 说完之后的「已听到」回执：字没了但电平柱留一小会儿 ——
setupRecording();
for (let i = 0; i < 3; i++) trackSpeech(loud);
for (let i = 0; i < 10; i++) trackSpeech(quiet);
const stAfter = computeRunStatus();
check('说完 10 块后回到 silent', state.vadState === 'silent');
check(
  '刚说完的一瞬：橙色底波浪还留着（「已听到」的回执）',
  trayView(stAfter, false).glyph === 'speaking' && trayView(stAfter, false).background === TONE_SPEAKING,
);
check(
  '回执过期后回到实心麦克风 + 服务状态（不会一直留着）',
  (() => {
    const future = Date.now() + 60_000;
    const v = trayView(stAfter, false, future);
    return v.glyph === 'dot' && v.background === null;
  })(),
);

// 长句也要有回执：计时从「最近一次听到声音」算，不是从起说算。
// （曾经的写法只在起说时记一次时间戳——说完一个 30 秒的长句时它早已过期，回执永远不出现。）
setupRecording();
for (let i = 0; i < 3; i++) trackSpeech(loud);
const longSt = computeRunStatus();
state.speechHeardAt = Date.now(); // 模拟「刚才一直在说」
check(
  '刚说完一个长句也有回执',
  trayView(longSt, false).background === TONE_SPEAKING,
);
check(
  '回执窗口只按最近一次出声算，与句子多长无关',
  trayView(longSt, false, Date.now() + HEARD_GRACE_MS + 100).color === null,
);

// 说完：连续静音 VAD_SILENCE_BLOCKS(10) 块才退回，句间呼吸不停闪
setupRecording();
for (let i = 0; i < 3; i++) trackSpeech(loud);
for (let i = 0; i < 9; i++) trackSpeech(quiet);
check('静了 9 块（不到 0.85 秒）仍算说话中：句间停顿不让字闪', state.vadState === 'speech');
trackSpeech(quiet);
check('静满 10 块 → 退回 silent', state.vadState === 'silent');
check(
  '退回后变回黑白圆点（底色撤掉）',
  trayView(computeRunStatus(), state.vadState === 'speech', Date.now() + 60_000).glyph === 'dot'
    && trayView(computeRunStatus(), state.vadState === 'speech', Date.now() + 60_000).background === null,
);

// —— 2) 本地引擎的发送行为没被改坏（trackSpeech 只更新状态，不发送）——
setupRecording();
let sent = 0;
state.asrWs = { readyState: 1, send() { sent++; } };
for (let i = 0; i < 5; i++) trackSpeech(loud);
check('trackSpeech 一块都不发送（本地引擎的发送仍走 audio.js 的 sendPCM）', sent === 0);

// —— 3) 云端引擎那条路径的分块行为原样保留 ——
setupRecording();
sent = 0;
state.asrWs = { readyState: 1, send() { sent++; } };
for (let i = 0; i < 5; i++) vadSend(quiet, pcm);
check('安静 5 块：不发送（心跳 54 块才到点）', sent === 0);
for (let i = 0; i < 3; i++) vadSend(loud, pcm);
// 前置缓冲只留最近 3 块（VAD_PAD_BLOCKS），而它恰好就是刚起说的这 3 块：
// 确认说话那一刻一次性补发，所以「连 3 块才认」不会把开头那三个字丢掉。
check('起说要连 3 块才认，认到后把开头这 3 块一并送达（首字不丢）', sent === 3);
sent = 0;
for (let i = 0; i < 10; i++) vadSend(quiet, pcm);
check('说完后的 10 块静音照送（服务侧要静音尾巴判句尾）', sent === 10);
check('这 10 块之后回到 silent', state.vadState === 'silent');
sent = 0;
for (let i = 0; i < 54; i++) vadSend(quiet, pcm);
check('长期安静：每 54 块送一次心跳（连接别被判死）', sent === 1);

// —— 4) 源码层面的硬约束（行为测试覆盖不到的接线）——
const audioSrc = readSrc('src/js/audio.js');
const asrSrc = readSrc('src/js/asr.js');
// 只看 updateSpeechState 这个函数体，免得断言被同文件其它地方的写法满足
const speechFn = asrSrc.slice(
  asrSrc.indexOf('function updateSpeechState'),
  asrSrc.indexOf('export function trackSpeech'),
);
check(
  '本地引擎分支里调了 trackSpeech（漏了就是「默认引擎下菜单栏永远不说说话中」）',
  /isLocalEngine[\s\S]{0,400}trackSpeech\(/.test(audioSrc),
);
check('停录时说话状态归零（否则菜单栏会把「说话中」留在那里）', /export function stopRec[\s\S]{0,800}vadState = 'silent'/.test(audioSrc));
check(
  '说话状态翻转时立刻重渲染（等一秒轮询就失去意义）',
  /vadState = 'speech';[\s\S]*?renderRunStatus\(\)/.test(speechFn),
);
check(
  '起说时**不响**任何音效（用户 2026-09-19 用完否掉的两版都在这里留痕，不要加回来）',
  !/playHeard|play[A-Z]\w*\(\)/.test(speechFn),
);

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('失败项:\n  - ' + failures.join('\n  - '));
  process.exit(1);
}
