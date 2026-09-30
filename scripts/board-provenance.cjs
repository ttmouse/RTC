'use strict';

/**
 * 白板「人工内容锚点」——唯一正本。写侧（server.js 的 PUT /api/meeting-board/document）
 * 和读侧（scripts/meeting-board.mjs 的 brief / update / 写回门槛）都用这一份纯函数，
 * 禁止在别处复制逻辑：两边判定不一致时，要么 AI 写回被误拦，要么人工内容被误放行。
 *
 * 问题：白板正文只有一个字符串字段 document，用户手写的话和外部 AI 写回的话落进同一份
 * 文本后无法区分。外部 AI 拿材料时（rtc board brief）看不出哪些行是用户的现场判断；
 * 整篇替换时最容易把这些行悄悄冲掉——「我写的东西怎么没了」是查不回来的。
 *
 * 数据：meeting-board.json 的每个场次（及旧版顶层数据）多两个字段：
 *   humanAnchors    string[]  正文里可辨认的人工行（多重集合语义，同一行可出现多次）
 *   agentDocumentAt ISO 串    外部 AI 最近一次写回正文的时间；不存在 = AI 还没动过正文
 *
 * 不变量：锚点行永远来自当前正文（三条写侧规则都保证）。手动改 JSON 破坏它也不会崩——
 * 读侧按「锚点 ∩ 当前正文」判定，多余锚点行自然失效。
 */

const HUMAN_ANCHOR_LIMIT = 1000; // 锚点行数上限：正文本身有界，这里防的是历史行无限累积

function docLines(text) {
  return String(text || '')
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .filter((line) => line.trim());
}

function lineCounts(lines) {
  const counts = new Map();
  for (const line of lines) counts.set(line, (counts.get(line) || 0) + 1);
  return counts;
}

function cleanAnchors(anchors) {
  return Array.isArray(anchors)
    ? anchors.filter((line) => typeof line === 'string' && line.trim())
    : [];
}

/** anchors 中仍出现在 lines 里的行（多重集合：同名行按次数消耗，一行重复不会全算数） */
function anchorsIn(anchors, lines) {
  const remaining = lineCounts(lines);
  const kept = [];
  for (const line of anchors) {
    const n = remaining.get(line) || 0;
    if (n > 0) {
      kept.push(line);
      remaining.set(line, n - 1);
    }
  }
  return kept;
}

/**
 * 写侧更新。入参取 PUT 时刻服务端手里就有的旧值，返回要合并进 session/board 的字段。
 * agentDocumentAt 只在 AI 写回时给出新值；用户保存返回 undefined，调用方靠展开旧对象保留原值。
 */
function updateBoardProvenance({ prevDoc, prevAnchors, nextDoc, isAgent, isAppend }) {
  const anchors = cleanAnchors(prevAnchors);
  if (isAgent) {
    // AI 写回 + --append：追加的是 AI 的话，锚点不动。
    // AI 写回 + 整篇替换：brief 契约要求 AI 把人工内容原样带进新正文，带进来的行保持
    // 人工身份；没带进来的行就此离开锚点（CLI 写回前会点名警告，--force 才放行）。
    const nextAnchors = isAppend ? anchors : anchorsIn(anchors, docLines(nextDoc));
    return { humanAnchors: nextAnchors, agentDocumentAt: new Date().toISOString() };
  }
  const prev = docLines(prevDoc);
  const next = docLines(nextDoc);
  const surviving = anchorsIn(anchors, next);
  // 用户新增的行 = next 里没被「上一版正文」解释掉的部分；锚点行必来自上一版正文，
  // 已被上面的 surviving 消耗语义覆盖，不会在这里被重复计入。
  const left = lineCounts(next);
  for (const line of prev) {
    const n = left.get(line) || 0;
    if (n > 0) left.set(line, n - 1);
  }
  const added = [];
  for (const line of next) {
    const n = left.get(line) || 0;
    if (n > 0) {
      added.push(line);
      left.set(line, n - 1);
    }
  }
  return { humanAnchors: surviving.concat(added).slice(-HUMAN_ANCHOR_LIMIT), agentDocumentAt: undefined };
}

/**
 * 读侧判定。humanLines / aiLines 都按正文原有顺序给出，二者互斥且并集等于正文。
 * allHuman = 当前正文里一行 AI 内容都没有 —— 覆盖两种情形：AI 从没参与（锚点为空且无
 * agentDocumentAt，正是「AI 生成之前用户手写」的场景），以及锚点恰好覆盖了全部正文。
 */
function boardProvenance(saved) {
  const doc = typeof (saved && saved.document) === 'string' ? saved.document : '';
  const lines = docLines(doc);
  if (!lines.length) return { empty: true, allHuman: false, humanLines: [], aiLines: [] };
  const anchors = cleanAnchors(saved && saved.humanAnchors);
  const agentWrote = Boolean(saved && saved.agentDocumentAt);
  const humanLines = anchors.length ? anchorsIn(anchors, lines) : agentWrote ? [] : lines.slice();
  const humanLeft = lineCounts(humanLines);
  const aiLines = [];
  for (const line of lines) {
    const n = humanLeft.get(line) || 0;
    if (n > 0) humanLeft.set(line, n - 1);
    else aiLines.push(line);
  }
  return { empty: false, allHuman: aiLines.length === 0, humanLines, aiLines };
}

/**
 * 写回门槛用：新正文里没有原样带上的人工锚点行（去重）。按「整行包含在新正文中」判定
 * 而不是逐行 diff——宁可少报不可误拦：行文本只要还在，就不算丢。
 */
function droppedHumanLines(saved, incomingText) {
  const incoming = String(incomingText || '');
  return [...new Set(boardProvenance(saved).humanLines.filter((line) => !incoming.includes(line)))];
}

module.exports = { HUMAN_ANCHOR_LIMIT, docLines, lineCounts, updateBoardProvenance, boardProvenance, droppedHumanLines };
