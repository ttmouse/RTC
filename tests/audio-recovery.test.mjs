import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { state } from '../src/js/state.js';
import { computeRunStatus } from '../src/js/ui.js';

// 睡眠唤醒之后「界面正常、其实什么都没录」这一次的守门检查
// （core-product-principles 第 3 条：每个状态只能有一个真实来源；ui-interaction-spec 第 2 节）。
//
// 现象：合上盖子再打开，WebAudio 会话 / 麦克风句柄 / ASR 连接都可能已经死了，
// 但界面照样「就绪」，点录音照样进「识别中」——用户对着它说完一整场，一个字都不会出，
// 只有重开应用才恢复。所以这里钉三件事：
//   1) 非 running 的音频上下文（含 WebKit 特有的 'interrupted'）必须被拉回 running，
//      拉不回来就得抛错——不能假装还能录；
//   2) 旧麦克风流「还活着吗」要按音轨状态判断，不能只看对象在不在；
//   3) 录音中确认没有音频输入时，状态区必须说「没有声音输入」，不许继续写「识别中」。
//
// audio.js 会（经 commands.js）碰到 document，所以这里给一个最小桩只为了让模块加载起来：
// 被测的都是纯函数，不读 DOM。

globalThis.document = {
  readyState: 'complete',
  addEventListener() {},
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
};

const { audioStateAction, streamIsDead } = await import('../src/js/audio.js');
const { isWakeGap, WAKE_GAP_MS } = await import('../src/js/lifecycle.js');

let passed = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { passed += 1; console.log(`  ✓ ${name}`); }
  else { failures.push(name); console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// —— 睡得够久才算「睡过一觉」 ——
check('定时器只跳了 1 秒 → 不算唤醒', isWakeGap(1000) === false);
check('跳变正好等于阈值 → 仍不算（阈值是「超过」）', isWakeGap(WAKE_GAP_MS) === false);
check('跳变远超阈值 → 认定为唤醒', isWakeGap(WAKE_GAP_MS + 1) === true);
check('拿不到时间差（NaN）→ 不误判成唤醒', isWakeGap(NaN) === false);

// —— 音频上下文：不是 running 就得救，救不回来要认 ——
check('running → 直接用', audioStateAction('running') === 'ok');
check('suspended（页面被挂起）→ resume', audioStateAction('suspended') === 'resume');
check(
  "interrupted（WebKit 特有，睡眠/音频会话被抢走）→ resume",
  audioStateAction('interrupted') === 'resume',
  '旧实现只认 suspended，唤醒后就是这个状态：音频图全哑，界面还写着「识别中」',
);
check('closed / 认不出的状态 → 明确当成坏的，不硬 resume', audioStateAction('closed') === 'dead');
check('undefined → dead', audioStateAction(undefined) === 'dead');

// —— 麦克风流：对象还在 ≠ 设备还在干活 ——
check('没有流 → 视为死的（要重新取）', streamIsDead(null) === true);
check('流里没有音轨 → 死的', streamIsDead({ getAudioTracks: () => [] }) === true);
check(
  '音轨全是 ended（睡眠唤醒后 macOS 的典型表现）→ 死的',
  streamIsDead({ getAudioTracks: () => [{ readyState: 'ended' }] }) === true,
);
check('音轨还活着 → 可以复用', streamIsDead({ getAudioTracks: () => [{ readyState: 'live' }] }) === false);
check(
  '一条 ended 一条 live → 还能用（不因为历史轨道就重取）',
  streamIsDead({ getAudioTracks: () => [{ readyState: 'ended' }, { readyState: 'live' }] }) === false,
);

// —— 状态区：录音中确认没声音输入时不许说「识别中」 ——
function setupRecording({ audioStalled }) {
  state.serverOk = true;
  state.modelServiceOk = true;
  state.recording = true;
  state.micError = '';
  state.asrReady = true;
  state.audioStalled = audioStalled;
  state.asrWs = { readyState: 1 };   // WebSocket.OPEN：ASR 连接看起来是好的
  state.asrEngine = 'sensevoice';
}

setupRecording({ audioStalled: true });
check(
  '录音中 · 音频回调停了（ASR 连接正常）→ 说「没有声音输入」，不许说识别中',
  computeRunStatus().text === '没有声音输入',
  `实际=${computeRunStatus().text}`,
);
check('录音中 · 没有声音输入用告警色', computeRunStatus().dot === 'err');
check('录音中 · 没有声音输入仍显示本段时长', computeRunStatus().time === 'rec');

setupRecording({ audioStalled: false });
check(
  '录音中 · 管道正常 → 仍是「识别中」（不说话不等于坏了）',
  computeRunStatus().text === '识别中',
  `实际=${computeRunStatus().text}`,
);

// 空闲时不该受这个标记影响（停录会清掉它，清了就该回到就绪）
state.recording = false;
state.audioStalled = false;
state.serverOk = true;
state.modelServiceOk = true;
state.micError = '';
state.asrWs = null;
state.asrReady = false;
check('空闲 · 标记已清 → 回到「就绪」', computeRunStatus().text === '就绪');

// —— 接线检查：函数写好了但没人调，等于没修 ——
const mainSrc = fs.readFileSync(path.join(root, 'src/js/main.js'), 'utf8');
check('main.js 真的启动了唤醒监听', /watchWake\(\s*handleSystemWake\s*\)/.test(mainSrc));
check('main.js 真的启动了音频流动看护', /startAudioFlowWatch\(\)/.test(mainSrc));
check(
  'main.js 取麦克风前先问过旧流是不是死的',
  /streamIsDead\(state\.stream\)/.test(mainSrc),
);

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('失败项：' + failures.join('、'));
  process.exit(1);
}
