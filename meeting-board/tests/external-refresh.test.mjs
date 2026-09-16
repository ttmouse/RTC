// 「外部写完，白板自己变」的行为回归 —— 照抄 xiaoer-omia 的 T164/T165/T168 用例，
// 外加指纹本身必须与 Omia 的 sourceBytesFingerprint 逐字节等价（两边算出来不一样，
// 就会变成「每次轮询都认为变了」→ 每 2 秒重挂编辑器）。
import {
  resolveExternalFileChange,
  sourceBytesFingerprint,
  sourceContentFingerprint,
} from '../src/lib/externalRefresh.js';

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// —— 三分支 ——
check('指纹一样 → unchanged（不能每轮都重挂编辑器）',
  eq(resolveExternalFileChange({ dirty: false, baseFingerprint: 'a', diskFingerprint: 'a' }), { outcome: 'unchanged' }));

check('指纹变了 + 本地干净 → reload',
  eq(resolveExternalFileChange({ dirty: false, baseFingerprint: 'a', diskFingerprint: 'b' }), { outcome: 'reload' }));

check('指纹变了 + 本地有改动 → conflict，并且带上草稿版本',
  eq(resolveExternalFileChange({ dirty: true, baseFingerprint: 'a', diskFingerprint: 'b', draftRevision: 7 }),
    { outcome: 'conflict', draftRevision: 7 }));

check('本地脏但磁盘没变 → 不打扰（用户正在打字，别提示冲突）',
  eq(resolveExternalFileChange({ dirty: true, baseFingerprint: 'a', diskFingerprint: 'a' }), { outcome: 'unchanged' }));

// —— 指纹本身 ——
check('指纹带算法前缀和字节数（和 Omia 同格式）',
  /^fnv1a32:[0-9a-f]{8}:\d+$/.test(sourceContentFingerprint('会议记录')), sourceContentFingerprint('会议记录'));

check('同内容同指纹，改一个字就变',
  sourceContentFingerprint('同一份内容') === sourceContentFingerprint('同一份内容')
  && sourceContentFingerprint('同一份内容') !== sourceContentFingerprint('同一份内容。'));

check('空文档也有稳定指纹',
  sourceContentFingerprint('') === sourceContentFingerprint(''), sourceContentFingerprint(''));

check('UTF-8 逐字节等价于 sourceBytesFingerprint（中文不能按码元算）',
  sourceContentFingerprint('会议记录 abc') === sourceBytesFingerprint(new TextEncoder().encode('会议记录 abc')),
  sourceContentFingerprint('会议记录 abc'));

// 独立算一遍的 FNV-1a 32 向量（Python 手写同一算法得出的值），钉死“和别人算得一样”
check('向量：空 = 811c9dc5:0，0x00 = 050c5d1f:1，abc = 1a47e90b:3',
  sourceBytesFingerprint(new Uint8Array()) === 'fnv1a32:811c9dc5:0'
  && sourceBytesFingerprint(new Uint8Array([0])) === 'fnv1a32:050c5d1f:1'
  && sourceBytesFingerprint(new TextEncoder().encode('abc')) === 'fnv1a32:1a47e90b:3',
  sourceBytesFingerprint(new TextEncoder().encode('abc')));

check('向量：中文按 UTF-8 字节算，不是码元——「会议记录 abc」= 2029e808:16',
  sourceContentFingerprint('会议记录 abc') === 'fnv1a32:2029e808:16',
  sourceContentFingerprint('会议记录 abc'));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
