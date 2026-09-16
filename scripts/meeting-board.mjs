#!/usr/bin/env node
/**
 * 会议白板 CLI —— 外部 AI 与白板之间的唯一通道。
 *
 * 白板分两层：应用只管「记录、保存、加载、展示」，理解会议这件事交给外部 AI。
 * 这个脚本把外部 AI 那半条链路工程化，让「更新最新一场会议」变成可重复的两步：
 *
 *   brief  拿材料  → 会前定义 + 该场逐字稿 + 写回格式（一次拿全，外部 AI 不用自己拼）
 *   write-* 写结果 → 写回白板，面板 2 秒内自动刷新，不用复制场次 ID
 *
 * 用法:
 *   node scripts/meeting-board.mjs sessions [--date D] [--json]      当天会议场次列表
 *   node scripts/meeting-board.mjs latest [--date D]                 最近一场的场次 ID（纯文本，可直接喂给别的命令）
 *   node scripts/meeting-board.mjs brief [场次ID] [--date D]         给外部 AI 的完整材料（定义 + 逐字稿 + 写回说明）
 *   node scripts/meeting-board.mjs transcript [场次ID] [--date D]    该场逐字稿（每行 [HH:MM] 内容）
 *   node scripts/meeting-board.mjs show [场次ID] [--json]            该场已保存的定义 / 分析 / 正文
 *   node scripts/meeting-board.mjs write-analysis <JSON文件> [场次ID]
 *   node scripts/meeting-board.mjs write-definition <JSON文件> [场次ID]
 *   node scripts/meeting-board.mjs write-document <Markdown文件> [场次ID]
 *
 * 场次 ID 省略时默认取「最近一场」，不必手工复制。
 * 环境变量: RTC_DATA_DIR 数据目录 · RTC_URL / RTC_PORT 服务地址（默认 http://127.0.0.1:8931）
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DATA_ROOT = process.env.RTC_DATA_DIR || join(
  homedir(),
  'Library',
  'Application Support',
  'com.rtc.transcriber',
);
const EVENTS_DIR = join(DATA_ROOT, 'events');
const BOARD_PATH = join(DATA_ROOT, 'meeting-board.json');
const BASE = (process.env.RTC_URL || `http://127.0.0.1:${process.env.RTC_PORT || 8931}`).replace(/\/+$/, '');

// 下面三样必须与 server.js 的 MEETING_SILENCE_SEC / detectSessions / meetingSessionId 逐字一致。
// 场次 ID 是「这一场第一句的时间戳」，CLI 与面板各算一遍；算法一旦漂移，写回的场次在面板里
// 就不存在——数据没丢，但用户看不到，排查成本极高。
const SILENCE_SEC = 300;
const ID_PREFIX = 'rtc-meeting-';

function fail(msg, code = 1) {
  console.error(`[board] ${msg}`);
  process.exit(code);
}

const pad2 = (n) => String(n).padStart(2, '0');

/** 与 server.js 的 localDateStamp 一致：事件按「本地日期」分文件，不是 UTC */
function localDateStamp(input) {
  const d = input instanceof Date ? input : new Date(input);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function fmtTime(ts) {
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function fmtDateTime(ts) {
  const d = new Date(ts);
  return `${localDateStamp(d)} ${fmtTime(d)}`;
}

function fmtDuration(ms) {
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min}分钟`;
  return `${Math.floor(min / 60)}小时${pad2(min % 60)}分`;
}

function sessionIdOf(start) {
  return ID_PREFIX + Math.floor(new Date(start).getTime() / 1000);
}

// ---------- 本地读取（不依赖应用是否在运行） ----------

function readDayEvents(date) {
  const file = join(EVENTS_DIR, `${date}.jsonl`);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf-8').split('\n').filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter((ev) => ev && ev.type === 'segment' && typeof ev.text === 'string' && ev.text.trim());
}

function detectSessions(events) {
  const sessions = [];
  let cur = null;
  for (const ev of events) {
    const ts = new Date(ev.ts);
    if (!cur) {
      cur = { start: ts, end: ts, count: 1, events: [ev] };
    } else if ((ts - cur.end) / 1000 > SILENCE_SEC) {
      sessions.push(cur);
      cur = { start: ts, end: ts, count: 1, events: [ev] };
    } else {
      cur.end = ts;
      cur.count += 1;
      cur.events.push(ev);
    }
  }
  if (cur) sessions.push(cur);
  return sessions.map((s) => ({ ...s, id: sessionIdOf(s.start) }));
}

function sessionsOf(date) {
  return detectSessions(readDayEvents(date));
}

function readBoard() {
  if (!existsSync(BOARD_PATH)) return {};
  try { return JSON.parse(readFileSync(BOARD_PATH, 'utf-8')) || {}; } catch { return {}; }
}

/** 读取某场已保存的白板内容（兼容第一阶段没有场次概念的顶层数据） */
function boardOf(id) {
  const board = readBoard();
  const saved = id && board.sessions && board.sessions[id];
  if (saved) return saved;
  if (!id || id === board.activeSessionId) {
    return { definition: board.definition, analysis: board.analysis, document: board.document };
  }
  return {};
}

/**
 * 场次 ID 省略时取最近一场；给了 ID 就从 ID 反推日期再定位（不必搜全盘）。
 * 反推是关键：用户上一句说「更新最新会议」，下一句可能已经是另一天了。
 */
function resolveSession(arg, date) {
  if (arg) {
    const m = new RegExp(`^${ID_PREFIX}(\\d+)$`).exec(arg);
    if (!m) fail(`场次 ID 格式不对: ${arg}（形如 ${ID_PREFIX}1789541878）`);
    const day = localDateStamp(new Date(Number(m[1]) * 1000));
    const found = sessionsOf(day).find((s) => s.id === arg);
    if (!found) fail(`找不到场次 ${arg}（${day} 的记录里没有这一场，可能记录已被清理）`);
    return found;
  }
  const day = date || localDateStamp(new Date());
  const all = sessionsOf(day);
  if (!all.length) fail(`${day} 没有转写记录。先确认在录音，或用 --date 指定别的日期`);
  return all.at(-1);
}

function transcriptText(session) {
  return session.events.map((ev) => `[${fmtTime(ev.ts)}] ${ev.text}`).join('\n');
}

// ---------- 输出 ----------

function printSessions(date) {
  const all = sessionsOf(date);
  const board = readBoard();
  const stored = board.sessions || {};
  if (!all.length) {
    console.log(`${date} 没有转写记录`);
    return;
  }
  console.log(`${date} 共 ${all.length} 场（静默超过 ${SILENCE_SEC} 秒自动切分）`);
  all.forEach((s, i) => {
    const mark = i === all.length - 1 ? '*' : ' ';
    const saved = stored[s.id] || {};
    const state = saved.analysis ? `有分析 · ${saved.analysis._updatedAt ? fmtDateTime(saved.analysis._updatedAt) : '时间未知'}` : '无分析';
    console.log(`${mark}#${i + 1}  ${fmtTime(s.start)} — ${fmtTime(s.end)}  (${fmtDuration(s.end - s.start)})  ${s.count}条  ${state}`);
    console.log(`     ID ${s.id}`);
  });
  console.log('\n* = 最近一场（不写场次 ID 时默认写给它）');
}

function printShow(session, wantJson) {
  const saved = boardOf(session.id);
  if (wantJson) {
    console.log(JSON.stringify({
      sessionId: session.id,
      start: session.start.toISOString(),
      end: session.end.toISOString(),
      count: session.count,
      definition: saved.definition || null,
      analysis: saved.analysis || null,
      document: saved.document || '',
    }, null, 2));
    return;
  }
  const def = saved.definition || {};
  console.log(`场次 ${session.id}  ${fmtDateTime(session.start)} — ${fmtTime(session.end)}  ${session.count}条`);
  console.log(`\n## 会前定义\n${formatDefinition(def)}`);
  console.log(`\n## 分析结果\n${saved.analysis ? JSON.stringify(saved.analysis, null, 2) : '（无，等外部 AI 写入）'}`);
  console.log(`\n## 白板正文\n${(saved.document || '').trim() || '（空）'}`);
}

/**
 * 文本字段的收口。定义里的 background/expectedOutput/roles/boundary 都只能是字符串，
 * 传对象数组进来会被 String() 悄悄变成「[object Object],[object Object]」写进文件——
 * 落盘之后原文就永久丢了（实测发生过：线上 roles 字段现在就是五个 [object Object]）。
 * 所以这里宁可拒收，也不允许不可读的东西进白板。
 */
function toText(value, field) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (item === null || item === undefined) return '';
      if (typeof item === 'object') {
        fail(`${field} 的每一项都必须是字符串，收到对象：${JSON.stringify(item).slice(0, 120)}\n` +
          '  如果那是一组结构化的角色，请拼成「文杰（产品）· 负责报价口径」这样的字符串。');
      }
      return String(item);
    }).filter(Boolean).join('、');
  }
  fail(`${field} 必须写成字符串，收到 ${typeof value}`);
}

/** 展示用：历史数据里已经存过 [object Object] 这种字符串，读的时候只能如实显出来 */
function showText(value) {
  if (typeof value === 'string') return value.trim() || '（未定义）';
  if (Array.isArray(value)) return value.map((v) => (v && typeof v === 'object' ? JSON.stringify(v) : String(v))).join('、') || '（未定义）';
  if (value && typeof value === 'object') return JSON.stringify(value);
  return value === undefined || value === null || value === '' ? '（未定义）' : String(value);
}

function formatDefinition(def) {
  return `- 讨论背景：${showText(def.background)}\n- 预期产出：${showText(def.expectedOutput)}\n- 参与角色：${showText(def.roles)}\n- 讨论边界：${showText(def.boundary)}`;
}

// 这段「要写什么」的说明是白板与外部 AI 之间的接口契约，字段名对应
// meeting-board/src/main.js 的 analysisToMarkdown()。改那边就得改这里，否则外部分析
// 写进去了但正文生成不出来——面板上看起来就是「什么都没发生」。
function printBrief(session) {
  const saved = boardOf(session.id);
  const def = saved.definition || {};
  const existingDoc = typeof saved.document === 'string' ? saved.document.trim() : '';
  console.log(`# 会议白板 · 待分析材料\n`);
  console.log(`## 场次\n- 场次 ID：${session.id}`);
  console.log(`- 时间：${fmtDateTime(session.start)} — ${fmtTime(session.end)}（${fmtDuration(session.end - session.start)}）`);
  console.log(`- 记录条数：${session.count}`);
  console.log(`- 已有分析：${saved.analysis ? `有（${saved.analysis._updatedAt || '时间未知'}），本次写入会覆盖它` : '无'}`);
  console.log(`- 白板正文：${existingDoc ? `${existingDoc.length} 字。write-document 是**整篇替换**，要留着就把它带进新正文，或写回时加 --append` : '空，分析结果会自动生成一版正文'}`);
  console.log(`\n## 会前定义\n${formatDefinition(def)}`);
  console.log(`\n## 逐字稿\n\n${transcriptText(session)}\n`);
  if (existingDoc) {
    // 把现有正文一并交出来，外部 AI 才有机会合并而不是默默抹掉用户写过的东西。
    console.log(`## 已有正文（写回时要么带上它，要么用 --append）\n\n${existingDoc}\n`);
  }
  console.log(`## 写回方式（照做即可，白板 2 秒内自己刷新）

面板上真正被人看到的是「白板正文」，不是 analysis。所以一次完整的更新要写两样：

1. 结构化结果（机器可读，供后续比对和生成正文）写成 JSON 文件，字段：
   - title              一句话标题
   - currentTopic       当前话题
   - decisionsReached   已形成结论（数组）
   - openQuestions      待决问题（数组）
   - actionItems        行动项（数组，建议「谁 · 做什么 · 何时」）
   - alignmentStatus    { backgroundCovered, boundaryRespected, roleClarity, expectedOutputProgress }
   - summary            一句话总结
   缺的可以省略，数组元素写成字符串最省事。

2. 正文（Markdown，这就是用户在面板里看到的）写成 .md 文件。

写回（场次 ID 省略就是最近一场，这里带上更稳）：

    rtc board write-analysis <结果.json> ${session.id}
    rtc board write-document <正文.md>  ${session.id}            # 整篇替换，会抵掉已有正文
    rtc board write-document <正文.md>  ${session.id} --append   # 保留已有正文，接在后面

注：只有该场正文还是空的时候，应用才会拿 analysis 自动生成一版正文；正文一旦有内容，
就只靠 write-document 更新。要改会前定义用 write-definition。`);
}

/**
 * update — 外部 AI 迭代白板的单一入口。
 *
 * 输出 Brief 材料后直接以 JSON 结尾放写回指令，外部 AI 只需：
 *   1. 读取 stdout 中的材料
 *   2. 生成两个临时文件
 *   3. 执行 write-back 命令
 */
function printUpdate(session) {
  printBrief(session);
  const sid = session.id;
  const tag = `[board-update:${sid}]`;
  console.log(`${tag}
---
## ✓ 材料已就绪

场次 ${sid} 的材料已输出完毕。现在的工作流：

### 1️⃣ 分析
基于上面的会前定义和逐字稿，生成两个文件：

### 2️⃣ 写回
执行以下两条命令回写白板（白板 2 秒内自动刷新）：

    rtc board write-analysis <结果.json> ${sid}
    rtc board write-document <正文.md> ${sid}
${boardOf(sid).document ? '    rtc board write-document <正文.md> ' + sid + ' --append  （已有正文，用 --append 保留）' : ''}

字段要求和注意事项见上文「写回方式」一节。
`);
}

// ---------- 写回（走本地服务，服务端串行合并，避免覆盖别的写入者） ----------

const ENDPOINTS = {
  'write-analysis': { path: '/api/meeting-board/analysis', kind: 'json', label: '分析结果' },
  'write-definition': { path: '/api/meeting-board/definition', kind: 'json', label: '会前定义' },
  'write-document': { path: '/api/meeting-board/document', kind: 'markdown', label: '白板正文' },
};

async function writeBack(command, file, sessionArg, date, append) {
  const spec = ENDPOINTS[command];
  if (!file) fail(`用法: node scripts/meeting-board.mjs ${command} <文件> [场次ID]`);
  if (!existsSync(file)) fail(`找不到文件：${file}`);

  let body;
  try {
    body = spec.kind === 'markdown'
      ? { document: readFileSync(file, 'utf-8') }
      : JSON.parse(readFileSync(file, 'utf-8'));
  } catch (error) {
    fail(`无法读取${spec.kind === 'markdown' ? ' Markdown' : ' JSON'} 文件：${error.message}`);
  }
  if (spec.kind === 'json' && (typeof body !== 'object' || body === null || Array.isArray(body))) {
    fail(`${file} 应该是一个 JSON 对象`);
  }

  // 写回一律落到具体场次：不带场次 ID 的写入会落到没有场次概念的顶层数据上，
  // 面板打开的是场次视图，会看不出变化。
  const session = resolveSession(sessionArg, date);
  const endpoint = `${spec.path}?sessionId=${encodeURIComponent(session.id)}`;

  if (command === 'write-document') {
    // write-document 是整篇替换，而面板上的正文可能是用户自己写的。
    // 不拦，但一定要说清楚 —— 「我写的东西怎么没了」是查不回来的。
    const current = boardOf(session.id).document;
    const existing = typeof current === 'string' ? current.trim() : '';
    if (append) {
      body = { document: existing ? `${existing}\n\n${String(body.document).trim()}\n` : body.document };
    } else if (existing) {
      console.error(`[board] 提醒：原有正文 ${existing.length} 字被整篇替换（想保留加 --append）`);
    }
  }

  if (command === 'write-definition') {
    body = {
      background: toText(body.background, 'background'),
      expectedOutput: toText(body.expectedOutput, 'expectedOutput'),
      roles: toText(body.roles, 'roles'),
      boundary: toText(body.boundary, 'boundary'),
    };
  } else if (command === 'write-analysis') {
    // 数组字段传成字符串会被 analysisToMarkdown 当成「没有内容」静默丢掉，这里补成数组；
    // 字符串字段传成对象，生成正文时会变成 [object Object]，一并收口。
    const asList = (value) => {
      if (value === undefined || value === null || value === '') return [];
      if (Array.isArray(value)) return value.filter((v) => v !== null && v !== undefined && v !== '');
      return [value];
    };
    const status = body.alignmentStatus && typeof body.alignmentStatus === 'object' ? body.alignmentStatus : {};
    body = {
      ...body,
      title: toText(body.title, 'title'),
      currentTopic: toText(body.currentTopic, 'currentTopic'),
      summary: toText(body.summary, 'summary'),
      decisionsReached: asList(body.decisionsReached),
      openQuestions: asList(body.openQuestions),
      actionItems: asList(body.actionItems),
      alignmentStatus: {
        backgroundCovered: status.backgroundCovered === true,
        boundaryRespected: status.boundaryRespected === true,
        roleClarity: status.roleClarity === true,
        expectedOutputProgress: toText(status.expectedOutputProgress, 'alignmentStatus.expectedOutputProgress'),
      },
    };
  }

  let result;
  try {
    const response = await fetch(BASE + endpoint, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    result = await response.json().catch(() => ({}));
    if (!response.ok || !result.ok) fail(result.error || `写入失败：HTTP ${response.status}`);
  } catch (error) {
    // 应用没开的时候最常见，单独给一句能照做的提示；其他错误原样抛给外层。
    if (/fetch failed|ECONNREFUSED|socket hang up/i.test(error?.message || '')) {
      fail(`连不上本地服务（${BASE}）。请先打开 RTC 应用或启动 server.js，再重试`);
    }
    throw error;
  }
  console.log(`已写入白板：${spec.label} → 场次 ${session.id}（${fmtDateTime(session.start)}）`);
}

// ---------- 入口 ----------

function printHelp() {
  console.log(`
会议白板 CLI —— 外部 AI 读写白板的通道

  sessions [--date D] [--json]      当天会议场次列表（* 标出最近一场）
  latest [--date D]                 打印最近一场的场次 ID（纯文本）
  update [场次ID] [--date D]         全链路迭代：输出材料 → 等外部 AI 分析 → 写回白板
                                      等价于 brief + write-analysis + write-document
  外部 AI 完整工作流：
    rtc board update                   # 只要这一句，一次完成读 → 分析 → 写回
  transcript [场次ID] [--date D]    该场逐字稿（每行 [HH:MM] 内容）
  show [场次ID] [--json]            该场已保存的定义 / 分析 / 正文
  write-analysis <JSON文件> [场次ID]     写入外部分析结果
  write-definition <JSON文件> [场次ID]   写入会前定义
  write-document <Markdown文件> [场次ID] [--append]
                                      写入白板正文（整篇替换；--append 则保留原文接在后面）

「把最新一场会议的记录写进白板」的做法（外部 AI 只用记这一句）：
  rtc board update                         # 读材料 → 分析 → 回写，一步到位
  背后等价于：brief → 生成分析 → write-analysis → write-document

场次 ID 省略时默认取最近一场。也可直接用脚本：node scripts/meeting-board.mjs <子命令>
环境变量: RTC_DATA_DIR 数据目录 · RTC_URL / RTC_PORT 服务地址（默认 http://127.0.0.1:8931）
`);
}

async function main() {
  const argv = process.argv.slice(2);
  const command = argv[0];
  const positionals = [];
  let date = '';
  let json = false;
  let append = false;

  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--date' || a === '-d') {
      date = argv[++i] || '';
    } else if (a === '--json') {
      json = true;
    } else if (a === '--append') {
      append = true;
    } else if (a === '--help' || a === '-h') {
      printHelp();
      return;
    } else if (a.startsWith('-')) {
      fail(`未知选项: ${a}`);
    } else {
      positionals.push(a);
    }
  }

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    printHelp();
    return;
  }
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) fail(`--date 格式应为 YYYY-MM-DD，收到: ${date}`);

  switch (command) {
    case 'sessions': {
      const day = date || localDateStamp(new Date());
      if (json) {
        const board = readBoard();
        const stored = board.sessions || {};
        console.log(JSON.stringify({
          date: day,
          sessions: sessionsOf(day).map((s, i, arr) => ({
            id: s.id,
            start: s.start.toISOString(),
            end: s.end.toISOString(),
            count: s.count,
            firstText: s.events[0].text,
            latest: i === arr.length - 1,
            hasAnalysis: !!stored[s.id]?.analysis,
          })),
        }, null, 2));
      } else {
        printSessions(day);
      }
      break;
    }
    case 'latest': {
      const session = resolveSession('', date);
      if (json) {
        console.log(JSON.stringify({
          id: session.id,
          start: session.start.toISOString(),
          end: session.end.toISOString(),
          count: session.count,
        }, null, 2));
      } else {
        console.log(session.id);
      }
      break;
    }
    case 'update':
      printUpdate(resolveSession(positionals[0], date));
      break;
    case 'brief':
      printBrief(resolveSession(positionals[0], date));
      break;
    case 'transcript':
      console.log(transcriptText(resolveSession(positionals[0], date)));
      break;
    case 'show':
      printShow(resolveSession(positionals[0], date), json);
      break;
    case 'write-analysis':
    case 'write-definition':
      await writeBack(command, positionals[0], positionals[1], date, false);
      break;
    case 'write-document':
      await writeBack(command, positionals[0], positionals[1], date, append);
      break;
    default:
      fail(`未知命令: ${command}（不带参数运行可看用法）`);
  }
}

main().catch((error) => fail(error.message || String(error)));
