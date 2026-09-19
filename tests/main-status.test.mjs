import assert from 'node:assert/strict';
import { state } from '../src/js/state.js';
import { computeRunStatus } from '../src/js/ui.js';

// 主界面状态区的说法必须诚实（core-product-principles 第 3 条 / ui-interaction-spec 第 2 节）。
//
// 这里钉的是踩过一次的坑：本地引擎（SenseVoice / Qwen3）的识别依赖本机的模型服务
// （asr_local/server.py 的 8933），它没起来时设置页的引擎行写着「模型服务未启动」，
// 主界面却照样显示「就绪」——用户可以录一整场会，一个字都不会出，事后才发现什么都没存。
// 假状态比没状态更糟，所以「空闲 + 本地引擎 + 模型服务未启动」绝不能落到「就绪」。
//
// 测试只读 state 并调用纯函数，不起服务、不碰 DOM，也不碰真实转写记录。

let passed = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { passed += 1; console.log(`  ✓ ${name}`); }
  else { failures.push(name); console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
}

/** 摆好状态机关心的那几个字段（其余分支：ws 未建立、麦克风可用） */
function setup({ serverOk, modelServiceOk, recording = false, micError = '' }) {
  state.serverOk = serverOk;
  state.modelServiceOk = modelServiceOk;
  state.recording = recording;
  state.micError = micError;
  state.asrWs = null;
  state.asrReady = false;
  // 引擎只影响 modelServiceOk 由谁写入（本地才可能为 false），状态机本身读的是结论，
  // 所以这里固定成本地引擎，与真实场景一致。
  state.asrEngine = 'sensevoice';
}

// —— 空闲态 ——
setup({ serverOk: true, modelServiceOk: true });
check('空闲 · 两个服务都正常 → 就绪', computeRunStatus().text === '就绪');

setup({ serverOk: true, modelServiceOk: false });
check(
  '空闲 · 本机模型服务未启动 → 不得显示就绪',
  computeRunStatus().text === '模型服务未启动',
  `实际=${computeRunStatus().text}`,
);
check('空闲 · 模型服务未启动时点用 err（告警色）', computeRunStatus().dot === 'err');

setup({ serverOk: true, modelServiceOk: null });
check('空闲 · 模型服务还没探出结论（或引擎是百炼）→ 仍按就绪', computeRunStatus().text === '就绪');

setup({ serverOk: false, modelServiceOk: false });
check('空闲 · 代理服务也不可达 → 说服务未连接（区分于模型服务）', computeRunStatus().text === '服务未连接');

// —— 录音态 ——
setup({ serverOk: true, modelServiceOk: false, recording: true });
check(
  '录音中 · 模型服务未启动 → 如实说卡在哪，不停在「录音中」',
  computeRunStatus().text === '模型服务未启动',
  `实际=${computeRunStatus().text}`,
);

setup({ serverOk: true, modelServiceOk: true, recording: true });
check('录音中 · 服务正常但任务未协商好 → 录音中', computeRunStatus().text === '录音中');

// —— 优先级 ——
setup({ serverOk: true, modelServiceOk: false, micError: '权限被拒' });
check('麦克风不可用优先于模型服务未启动', computeRunStatus().text === '麦克风不可用');

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('失败项:\n  - ' + failures.join('\n  - '));
  process.exit(1);
}
