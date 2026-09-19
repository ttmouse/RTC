import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { explainServiceFailure } from '../src/js/model.js';

// 「模型服务未启动」必须有下文（core-product-principles 第 3 条 / ui-interaction-spec 第 2 节）。
//
// 这里钉两件事：
//   1) 日志尾部 → 人话的翻译：说得出就说具体原因（缺依赖 / 端口被占 / 内存），
//      说不出来就如实回最后一行，绝不编一个原因出来。
//   2) 设置页那个「重启模型服务」按钮调的命令，Rust 侧真的注册了。
//      命令名对不上时前端只会在点击后静默失败（invoke 被 catch 吞掉），
//      界面照样是「点了没反应」——那正是这次要修的毛病本身。
//
// 测试只读文件、调纯函数：不起服务、不碰 DOM，也不碰真实转写记录。

let passed = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { passed += 1; console.log(`  ✓ ${name}`); }
  else { failures.push(name); console.log(`  ✗ ${name}${detail ? `
      ${detail}` : ''}`); }
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// —— 日志 → 原因 ——
const missingDep = explainServiceFailure([
  'Traceback (most recent call last):',
  '  File "asr_local/server.py", line 12, in <module>',
  '    import sherpa_onnx',
  "ModuleNotFoundError: No module named 'sherpa_onnx'",
]);
check('缺依赖 → 说得出是哪个模块', /sherpa_onnx/.test(missingDep.reason), missingDep.reason);
check('缺依赖 → 给出可复制的安装命令', /pip install/.test(missingDep.fix), missingDep.fix);

const portBusy = explainServiceFailure([
  'OSError: [Errno 48] Address already in use',
]);
check('端口被占用 → 认得出', /端口/.test(portBusy.reason), portBusy.reason);
check('端口被占用 → 给出查占用的命令', /lsof/.test(portBusy.fix), portBusy.fix);

const oom = explainServiceFailure(['MemoryError', 'Killed']);
check('内存不足 → 认得出', /内存/.test(oom.reason), oom.reason);

const unknown = explainServiceFailure(['model dir missing: /x/y.onnx']);
check(
  '模型文件缺失 → 指向模型卡片而不是编一个原因',
  /模型|missing/.test(unknown.reason),
  unknown.reason,
);

const noIdea = explainServiceFailure(['something totally unexpected happened']);
check(
  '认不出来 → 原样回最后一行，不编原因',
  noIdea.reason === 'something totally unexpected happened' && noIdea.fix === '',
  JSON.stringify(noIdea),
);

const empty = explainServiceFailure([]);
check('一行日志都没有 → 原因留空（由界面另说「没有留下日志」）', empty.reason === '', JSON.stringify(empty));

const blankTail = explainServiceFailure(['boom', '   ', '']);
check('尾部空行不算原因 → 回最后一行有内容的', blankTail.reason === 'boom', blankTail.reason);

// —— 前端按钮 ↔ Rust 命令 ——
const modelSrc = fs.readFileSync(path.join(root, 'src/js/model.js'), 'utf8');
const rustSrc = fs.readFileSync(path.join(root, 'src-tauri/src/lib.rs'), 'utf8');
// 只看 generate_handler! 那段：整份文件里出现同名函数定义不算注册
const handlerBlock = rustSrc.slice(rustSrc.indexOf('generate_handler!'));
for (const cmd of ['local_asr_status', 'restart_local_asr']) {
  check(
    `设置页调的命令 ${cmd} 在 Rust 侧注册了`,
    new RegExp(`\\b${cmd}\\b`).test(handlerBlock),
    'generate_handler! 里没有它',
  );
  check(`前端确实会调 ${cmd}`, modelSrc.includes(`invokeTauri('${cmd}'`));
}

check(
  '模型服务未启动时渲染的是「待办」而不是一句话（有按钮、有日志）',
  modelSrc.includes('重启模型服务') && modelSrc.includes('查看服务日志'),
);

console.log(`
${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('失败项:\n  - ' + failures.join('\n  - '));
  process.exit(1);
}
