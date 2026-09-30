import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HUMAN_ANCHOR_LIMIT,
  updateBoardProvenance,
  boardProvenance,
  droppedHumanLines,
} from '../scripts/board-provenance.cjs';

// 白板「人工内容锚点」：用户手写的内容必须能被外部 AI 认出来，且不被 AI 写回悄悄冲掉
// （产品原则 6 / 判断台账 PRD.ATTRIBUTION.001 的镜像）。唯一正本是 scripts/board-provenance.cjs，
// server.js 写侧与 meeting-board.mjs 读侧共用。
//
// 这里钉三类事：
//   1) 写侧规则：AI 写回（source=agent）与用户保存分别怎么更新锚点；
//   2) 读侧判定：brief 的人工/AI 划分，尤其「锚点为空 + AI 从未写回 = 全部人工」；
//   3) 接线：三处使用方必须真的引用正本——判定逻辑一旦分叉，两边会各说各话。
//
// 测试只调纯函数、只读源码文本：不起服务、不碰真实转写和白板。

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// —— 写侧：用户先手写（AI 生成之前的场景） ——
{
  const out = updateBoardProvenance({ prevDoc: '', prevAnchors: [], nextDoc: '我的结论：先发版\n待办：补文档', isAgent: false });
  assert.deepEqual(out.humanAnchors, ['我的结论：先发版', '待办：补文档'], '用户首次保存：所有非空行都成为锚点');
  assert.equal(out.agentDocumentAt, undefined, '用户保存不写 agentDocumentAt');
  const read = boardProvenance({ document: '我的结论：先发版\n待办：补文档' });
  assert.equal(read.allHuman, true, '锚点为空且 AI 从未写回 → 正文全部视为人工内容');
  assert.deepEqual(read.humanLines, ['我的结论：先发版', '待办：补文档']);
  // 服务端在用户保存后会把锚点落盘，此时的真实状态是「有锚点但还没有 AI 内容」：
  const readWithAnchors = boardProvenance({
    document: '我的结论：先发版\n待办：补文档',
    humanAnchors: ['我的结论：先发版', '待办：补文档'],
  });
  assert.equal(readWithAnchors.allHuman, true, '锚点覆盖全部正文（AI 还没参与）→ 仍判定为全部人工');
  assert.deepEqual(readWithAnchors.aiLines, []);
}

// —— 写侧：AI 整篇替换（契约要求原样带上人工行） ——
{
  const carried = updateBoardProvenance({
    prevDoc: '我的结论：先发版\nAI 无关行',
    prevAnchors: ['我的结论：先发版'],
    nextDoc: '## 总结\n我的结论：先发版\n补充证据……',
    isAgent: true,
  });
  assert.deepEqual(carried.humanAnchors, ['我的结论：先发版'], 'AI 原样带入的人工行保持人工身份');
  assert.ok(carried.agentDocumentAt, 'AI 写回记录 agentDocumentAt');

  const dropped = updateBoardProvenance({
    prevDoc: '我的结论：先发版',
    prevAnchors: ['我的结论：先发版'],
    nextDoc: 'AI 自己重写的版本',
    isAgent: true,
  });
  assert.deepEqual(dropped.humanAnchors, [], '被 AI 冲掉的人工行离开锚点（CLI 写回门槛负责拦截）');
}

// —— 写侧：AI --append，锚点不动 ——
{
  const out = updateBoardProvenance({
    prevDoc: '我的结论：先发版',
    prevAnchors: ['我的结论：先发版'],
    nextDoc: '我的结论：先发版\n\nAI 追加的段落',
    isAgent: true,
    isAppend: true,
  });
  assert.deepEqual(out.humanAnchors, ['我的结论：先发版'], '追加的是 AI 的话，已有锚点不变');
}

// —— 写侧：用户在 AI 正文上改一行、加一行 ——
{
  const out = updateBoardProvenance({
    prevDoc: 'AI 段落一\nAI 段落二',
    prevAnchors: [],
    nextDoc: 'AI 段落一\nAI 段落二（用户改过）\n用户补的一句话',
    isAgent: false,
  });
  assert.deepEqual(out.humanAnchors, ['AI 段落二（用户改过）', '用户补的一句话'], '用户新出现/改动的行成为锚点，AI 的行不进锚点');
}

// —— 读侧：混合正文按原顺序划分，人工与 AI 互斥且并集等于正文 ——
{
  const read = boardProvenance({
    document: 'AI 开头\n用户手写的一句\nAI 结尾',
    humanAnchors: ['用户手写的一句'],
    agentDocumentAt: '2026-09-29T10:00:00.000Z',
  });
  assert.deepEqual(read.humanLines, ['用户手写的一句']);
  assert.deepEqual(read.aiLines, ['AI 开头', 'AI 结尾']);
  assert.equal(read.empty, false);
  assert.equal(read.allHuman, false);
}

// —— 多重集合语义：一行重复不会把所有同名行都算成人工 ——
{
  const read = boardProvenance({ document: '是\n是', humanAnchors: ['是'] });
  assert.equal(read.humanLines.length, 1, '锚点里只有一份，同名第二行不算人工');
}

// —— seed 路径：面板把外部分析垫进正文（source=agent，旧正文为空） ——
{
  const out = updateBoardProvenance({ prevDoc: '', prevAnchors: [], nextDoc: '分析生成的整篇', isAgent: true });
  assert.deepEqual(out.humanAnchors, [], 'AI 生成的正文不产生人工锚点');
  assert.ok(out.agentDocumentAt, 'seed 落盘算 AI 写回，记录时间');
  const read = boardProvenance({ document: '分析生成的整篇', humanAnchors: [], agentDocumentAt: out.agentDocumentAt });
  assert.equal(read.allHuman, false, '不能因为锚点为空就把 AI seed 的正文当成人工内容');
  assert.deepEqual(read.aiLines, ['分析生成的整篇']);
}

// —— 用户清空正文：锚点随之清空 ——
{
  const out = updateBoardProvenance({ prevDoc: '一行', prevAnchors: ['一行'], nextDoc: '', isAgent: false });
  assert.deepEqual(out.humanAnchors, []);
  assert.equal(boardProvenance({ document: '' }).empty, true);
}

// —— 写回门槛：丢人工行的检测 ——
{
  const saved = { document: '保留我\n也保留我\nAI 的行', humanAnchors: ['保留我', '也保留我'] };
  assert.deepEqual(droppedHumanLines(saved, '新正文只提到「保留我」这个词，也保留我'), [], '行文本还在就不算丢（宁可少报不可误拦）');
  assert.deepEqual(droppedHumanLines(saved, 'AI 全新正文'), ['保留我', '也保留我'], '整行消失才算丢');
}

// —— 锚点上限：防止历史行无限累积 ——
{
  const many = Array.from({ length: HUMAN_ANCHOR_LIMIT + 200 }, (_, i) => `行${i}`);
  const out = updateBoardProvenance({ prevDoc: many.join('\n'), prevAnchors: many, nextDoc: many.join('\n'), isAgent: false });
  assert.equal(out.humanAnchors.length, HUMAN_ANCHOR_LIMIT, '超出上限时保留最新的行');
}

// —— 接线：三处使用方必须引用正本 ——
const serverSrc = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
assert.ok(
  serverSrc.includes("require('./scripts/board-provenance.cjs')"),
  'server.js 必须用 board-provenance.cjs 判定来源（判定分叉 = AI 写回被误拦或人工内容被误放行）',
);
const cliSrc = fs.readFileSync(path.join(root, 'scripts/meeting-board.mjs'), 'utf8');
assert.ok(cliSrc.includes("from './board-provenance.cjs'"), 'meeting-board.mjs 读侧必须用正本，不许复制逻辑');
const uiSrc = fs.readFileSync(path.join(root, 'meeting-board/src/main.js'), 'utf8');
assert.ok(
  uiSrc.includes("source: 'agent'"),
  '面板 seedDocument 落盘必须标记 source=agent，否则外部分析生成的正文会被误认成人工内容',
);

console.log('board human-content tests passed');
