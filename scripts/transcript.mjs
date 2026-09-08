#!/usr/bin/env node
/**
 * rtc-transcriber 转录记录查询 CLI
 *
 * 用法：
 *   node scripts/transcript.mjs                       # 默认今天全部
 *   node scripts/transcript.mjs --minutes 10          # 最近 10 分钟
 *   node scripts/transcript.mjs --from 14:00 --to 15:00  # 指定时间段
 *   node scripts/transcript.mjs --date 2026-09-04     # 指定日期
 *   node scripts/transcript.mjs --today               # 今天全部（默认）
 *   node scripts/transcript.mjs --json                # JSON 格式输出（机器解析用）
 *   node scripts/transcript.mjs --raw                 # 每行一条原文（纯文本）
 *   node scripts/transcript.mjs --transcript          # 逐字稿格式（带时间戳 [HH:MM] + 文件头）
 *   node scripts/transcript.mjs --sessions            # 检测会议段
 *   node scripts/transcript.mjs --sessions --last     # 只看最近一个会议段
 *   node scripts/transcript.mjs --sessions --silence 300  # 自定义静默阈值（秒）
 *
 * 依赖：Node.js 18+（内置 fetch）
 */

import { readdirSync, readFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { exit } from 'process';

// ========== 配置 ==========

const DATA_ROOT = process.env.RTC_DATA_DIR || join(
  homedir(),
  'Library',
  'Application Support',
  'com.rtc.transcriber'
);
const EVENTS_DIR = join(DATA_ROOT, 'events');
const CONFIG_PATH = join(DATA_ROOT, 'config.json');
const DEFAULT_SILENCE_SECONDS = 300; // 5 分钟

// ========== 参数解析 ==========

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    minutes: 0,
    from: null,
    to: null,
    date: null,
    today: false,
    json: false,
    raw: false,
    transcript: false,
    sessions: false,
    last: false,
    silence: DEFAULT_SILENCE_SECONDS,
    content: false,
    recent: 0,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--minutes':
      case '-m':
        opts.minutes = parseInt(args[++i], 10);
        if (isNaN(opts.minutes) || opts.minutes <= 0) {
          console.error('--minutes 需要正数');
          exit(1);
        }
        break;
      case '--recent':
      case '-r':
        opts.recent = parseInt(args[++i], 10);
        if (isNaN(opts.recent) || opts.recent <= 0) {
          console.error('--recent 需要正数');
          exit(1);
        }
        break;
      case '--from':
        opts.from = args[++i];
        break;
      case '--to':
        opts.to = args[++i];
        break;
      case '--date':
      case '-d':
        opts.date = args[++i];
        break;
      case '--today':
        opts.today = true;
        break;
      case '--json':
        opts.json = true;
        break;
      case '--raw':
        opts.raw = true;
        break;
      case '--transcript':
      case '-t':
        opts.transcript = true;
        break;
      case '--sessions':
      case '-s':
        opts.sessions = true;
        break;
      case '--last':
      case '-l':
        opts.last = true;
        break;
      case '--silence':
        opts.silence = parseInt(args[++i], 10);
        if (isNaN(opts.silence) || opts.silence <= 0) {
          console.error('--silence 需要正数（秒）');
          exit(1);
        }
        break;
      case '--content':
      case '-c':
        opts.content = true;
        break;
      case '--digest':
      case '-g':
        opts.digest = true;
        break;
      case '--help':
      case '-h':
        printHelp();
        exit(0);
      default:
        console.error(`未知参数: ${args[i]}`);
        printHelp();
        exit(1);
    }
  }
  return opts;
}

function printHelp() {
  console.log(`
用法: node scripts/transcript.mjs [选项]

查询选项:
  -m, --minutes <N>   最近 N 分钟的记录
  -r, --recent <N>    最近 N 条记录（最新 N 条，时间升序）
  --from <时间>        起始时间（如 "14:00" 或 "2026-09-04T14:00:00"）
  --to <时间>          结束时间
  -d, --date <日期>    指定日期（如 "2026-09-04"）
  --today             今天全部记录（默认）

输出格式:
  --json              JSON 格式输出（机器解析用）
  --raw               每行一条原文
  -t, --transcript    逐字稿格式（带时间戳 [HH:MM] + 文件头）
  -g, --digest        结构化会议洞察（话题分段/共识/争议/待办）

会议段检测:
  -s, --sessions      检测会议段（按静默间隔自动切分）
  -l, --last          只看最近一个会议段
  --silence <秒>      静默阈值（默认 300 秒=5 分钟）
  -c, --content       （与 --sessions 连用）输出段内全部记录原文

环境变量:
  RTC_DATA_DIR        覆盖数据目录（默认: ~/Library/Application Support/com.rtc.transcriber）

示例:
  node scripts/transcript.mjs --minutes 10
  node scripts/transcript.mjs --recent 5 --json
  node scripts/transcript.mjs --from 14:00 --to 15:00
  node scripts/transcript.mjs --date 2026-09-04 --json
  node scripts/transcript.mjs --sessions
  node scripts/transcript.mjs --sessions --last
  node scripts/transcript.mjs --sessions --silence 180
  node scripts/transcript.mjs --minutes 30 --digest
  node scripts/transcript.mjs --from 14:00 --to 15:00 -t   # 逐字稿导出
`);
}

// ========== 时间工具 ==========

function now() {
  return new Date();
}

function todayStr() {
  const d = now();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function parseTime(input) {
  // 完整 ISO 格式
  const iso = Date.parse(input);
  if (!isNaN(iso)) return new Date(iso);

  // 只有时间 "HH:MM" → 补今天日期
  const m = input.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (m) {
    const d = now();
    d.setHours(parseInt(m[1], 10), parseInt(m[2], 10), m[3] ? parseInt(m[3], 10) : 0, 0);
    return d;
  }

  return null;
}

// ========== 数据读取 ==========

function loadEvents() {
  if (!existsSync(EVENTS_DIR)) {
    return [];
  }

  const files = readdirSync(EVENTS_DIR)
    .filter(f => f.endsWith('.jsonl'))
    .sort();

  const all = [];
  for (const file of files) {
    const content = readFileSync(join(EVENTS_DIR, file), 'utf-8');
    for (const line of content.trim().split('\n')) {
      if (!line) continue;
      try {
        const ev = JSON.parse(line);
        if (ev.type === 'segment') {
          all.push(ev);
        }
      } catch {
        // 跳过损坏行
      }
    }
  }

  return all;
}

// ========== 关键词替换（correctionRules） ==========

function loadCorrectionRules() {
  if (!existsSync(CONFIG_PATH)) return [];

  try {
    const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
    const raw = config.correctionRules || '';
    const rules = [];

    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.includes('=>')) continue;

      const idx = trimmed.indexOf('=>');
      const left = trimmed.slice(0, idx).trim();
      const right = trimmed.slice(idx + 2).trim();

      if (left.startsWith('(') && left.endsWith(')')) {
        // 正则规则: (错误1|错误2) => 正确词
        const inner = left.slice(1, -1);
        try {
          rules.push({ re: new RegExp(inner, 'g'), replacement: right });
        } catch { /* 跳过无效正则 */ }
      } else {
        // 精确匹配: 错误词 => 正确词
        const escaped = left.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        try {
          rules.push({ re: new RegExp(escaped, 'g'), replacement: right });
        } catch { /* 跳过无效正则 */ }
      }
    }

    return rules;
  } catch {
    return [];
  }
}

function applyCorrections(text, rules) {
  if (!rules || rules.length === 0) return text;
  let result = text;
  for (const { re, replacement } of rules) {
    result = result.replace(re, replacement);
  }
  return result;
}

// ========== 过滤 ==========

function filterEvents(events, opts) {
  const now_ = now();

  // 计算时间范围
  let fromDate = null;
  let toDate = null;

  if (opts.minutes > 0) {
    fromDate = new Date(now_.getTime() - opts.minutes * 60 * 1000);
    toDate = now_;
  } else if (opts.from || opts.to) {
    if (opts.from) {
      fromDate = parseTime(opts.from);
      if (!fromDate) {
        console.error(`无法解析 --from 时间: "${opts.from}"`);
        exit(1);
      }
    }
    if (opts.to) {
      toDate = parseTime(opts.to);
      if (!toDate) {
        console.error(`无法解析 --to 时间: "${opts.to}"`);
        exit(1);
      }
    }
  } else if (opts.date) {
    fromDate = new Date(`${opts.date}T00:00:00`);
    toDate = new Date(`${opts.date}T23:59:59`);
  } else {
    // 默认今天
    const today = todayStr();
    fromDate = new Date(`${today}T00:00:00`);
    toDate = now_;
  }

  // 按时间过滤
  let filtered = events.filter(ev => {
    const ts = new Date(ev.ts);
    if (fromDate && ts < fromDate) return false;
    if (toDate && ts > toDate) return false;
    return true;
  });

  // 按时间排序
  filtered.sort((a, b) => new Date(a.ts) - new Date(b.ts));

  // 取最新 N 条（时间排序后的最后 N 条，保持时间升序输出）
  if (opts.recent > 0) {
    filtered = filtered.slice(-opts.recent);
  }

  return filtered;
}

// ========== 会议段检测 ==========

function detectSessions(events, silenceSec) {
  const sessions = [];
  let current = null;

  for (const ev of events) {
    const ts = new Date(ev.ts);
    const text = ev.text || '';

    if (current === null) {
      current = { start: ts, end: ts, count: 1, texts: [text], times: [ts] };
    } else {
      const gap = (ts - current.end) / 1000;
      if (gap > silenceSec) {
        // 结束当前段
        sessions.push(current);
        // 开始新段
        current = { start: ts, end: ts, count: 1, texts: [text], times: [ts] };
      } else {
        current.end = ts;
        current.count += 1;
        current.texts.push(text);
        current.times.push(ts);
      }
    }
  }

  if (current) {
    sessions.push(current);
  }

  return sessions;
}

// ========== 输出 ==========

function formatTime(ts) {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function formatTimeLocal(ts) {
  // ISO 时间 → 本地时区 HH:MM 格式，AI 解析不用再换算
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatDateTimeLocal(ts) {
  // ISO 时间 → 本地时区完整 YYYY-MM-DD HH:MM，避免跨天/时区误判
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatDate(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function formatDuration(seconds) {
  const total = Math.round(seconds);
  if (total < 60) return `${total}秒`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m < 60) return s > 0 ? `${m}分${s}秒` : `${m}分钟`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm > 0 ? `${h}时${rm}分` : `${h}小时`;
}

function output(events, opts) {
  if (opts.json) {
    // JSON 输出（包含本地时间）
    const withLocal = events.map(ev => ({
      ...ev,
      timeLocal: formatTimeLocal(ev.ts),
    }));
    console.log(JSON.stringify(withLocal, null, 2));
    return;
  }

  if (opts.raw) {
    // 纯文本原文
    for (const ev of events) {
      console.log(ev.text);
    }
    return;
  }

  // 默认：人类可读
  if (events.length === 0) {
    console.log('该时间段暂无记录');
    return;
  }

  // 按日期分组
  let currentDate = '';
  for (const ev of events) {
    const d = formatDate(ev.ts);
    if (d !== currentDate) {
      currentDate = d;
      // 如果是多天，显示日期分隔
      const isMultiDay = events.length > 0 && (
        formatDate(events[0].ts) !== formatDate(events[events.length - 1].ts)
      );
      if (isMultiDay) {
        console.log(`\n--- ${d} ---`);
      }
    }
    console.log(`  [${formatTime(ev.ts)}] ${ev.text}`);
  }

  console.log(`\n共 ${events.length} 条记录`);
}

function outputTranscript(events) {
  // 逐字稿格式：Markdown 格式，带时间戳和文件头
  if (events.length === 0) {
    console.log('该时间段暂无记录');
    return;
  }

  const first = new Date(events[0].ts);
  const last = new Date(events[events.length - 1].ts);
  const dur = Math.round((last - first) / 1000);
  const durStr = formatDuration(dur);

  console.log('# 逐字稿\n');
  console.log(`**日期:** ${formatDate(first)}`);
  console.log(`**时间:** ${formatTimeLocal(events[0].ts)} — ${formatTimeLocal(events[events.length - 1].ts)}  (${durStr})`);
  console.log(`**总记录数:** ${events.length} 条\n`);
  console.log('---\n');

  for (const ev of events) {
    const t = formatTimeLocal(ev.ts);
    console.log(`[${t}] ${ev.text}`);
  }

  console.log(`\n---\n共 ${events.length} 条记录`);
}

function outputSessions(sessions, opts) {
  const filtered = opts.last ? sessions.slice(-1) : sessions;

  if (opts.json) {
    const data = filtered.map(s => {
      const base = {
        start: s.start.toISOString(),
        end: s.end.toISOString(),
        startLocal: formatDateTimeLocal(s.start),
        endLocal: formatDateTimeLocal(s.end),
        durationSec: Math.round((s.end - s.start) / 1000),
        count: s.count,
        firstText: s.texts[0] || '',
        lastText: s.texts[s.texts.length - 1] || '',
      };
      if (opts.content) {
        base.entries = s.texts.map((text, j) => {
          const time = s.times && s.times[j] ? s.times[j].toISOString() : null;
          return {
            time,
            timeLocal: time ? formatTimeLocal(time) : null,
            text,
          };
        });
      }
      return base;
    });
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  if (opts.content) {
    // 输出段内全部记录原文（含时间戳）
    for (const s of filtered) {
      const startStr = formatTime(s.start);
      const dur = (s.end - s.start) / 1000;
      const durStr = formatDuration(dur);
      console.log(`--- ${startStr}  (${durStr})  ${s.count}条 ---`);
      for (let j = 0; j < s.texts.length; j++) {
        const t = s.times && s.times[j] ? formatTime(s.times[j]) : '??:??:??';
        console.log(`[${t}] ${s.texts[j]}`);
      }
      console.log();
    }
    return;
  }

  if (filtered.length === 0) {
    console.log('未检测到会议段');
    return;
  }

  const label = opts.last ? '最近一个会议段' : `共 ${sessions.length} 个会议段（静默超过 ${opts.silence} 秒自动切分）`;
  console.log(label);
  console.log();

  for (let i = 0; i < filtered.length; i++) {
    const s = filtered[i];
    const dur = (s.end - s.start) / 1000;
    const durStr = formatDuration(dur);
    const startStr = formatTime(s.start);
    const firstText = s.texts[0] || '';
    const lastText = s.texts[s.texts.length - 1] || '';

    console.log(`  #${i + 1}  ${startStr}  (${durStr})  ${s.count}条`);
    if (firstText) {
      const preview = firstText.length > 60 ? firstText.slice(0, 60) + '…' : firstText;
      console.log(`     首句: ${preview}`);
    }
    if (lastText && lastText !== firstText) {
      const preview = lastText.length > 60 ? lastText.slice(0, 60) + '…' : lastText;
      console.log(`     末句: ${preview}`);
    }
    console.log();
  }
}

// ========== 会议洞察 (digest) ==========

// 话题边界标记（仅当出现在句首时才触发，避免日常口语误触）
const TOPIC_BOUNDARY = /(?:^|[。！？；])\s*(?:讲一下|接下来|我讲一下|我们说一下|我们来讲|关于|回到|补充一下|核心问题|还有一点|最后一点|我们的目标|要解决的问题|先讲|我先说|再讲一下|重点讲|核心是|一方面是|另外一方面|主要讲|主要说|好接下来|那接下来)/;

// 共识信号（句首同意）
const CONSENSUS_PATTERNS = [
  /^可以[的，]/, /^没问题/, /^就这样/, /^同意/,
  /^行[，。]/, /^可以了/, /^没问题了/,
];

// 争议信号
const CONTROVERSY_PATTERNS = [
  /不对[，。]/, /不是[，。]/, /不同意/, /有问题/,
  /不行[，。]/, /不是这样的/, /这样不行/,
  /我不同意/, /这个不对/, /不是这个意思/,
  /那不对/, /那不行/,
];

// 待办信号
const ACTION_TRIGGERS = [
  '去梳理', '去完成', '去处理', '去负责', '去输出',
  '要梳理', '要输出', '要完成', '要处理', '要负责',
  '梳理', '输出', '完成',
  '月底', '下周', '这周', '这两周',
];

// 责任人模式
const WHO_PATTERN = /([^，。！？、；：]{1,4})(?:你去|你来|你负责|你梳理|你去梳理)/;

// ─── 话题分段 ───

function segmentTopics(events) {
  if (events.length < 5) {
    return [{ start: new Date(events[0].ts), end: new Date(events[events.length - 1].ts), label: '讨论', records: events }];
  }
  
  // 1. 用句首话题标记切分
  const boundaries = [0];
  for (let i = 1; i < events.length; i++) {
    if (TOPIC_BOUNDARY.test(events[i].text)) {
      boundaries.push(i);
    }
  }
  boundaries.push(events.length);
  
  // 2. 构建段
  const segments = [];
  for (let i = 0; i < boundaries.length - 1; i++) {
    const start = boundaries[i];
    const end = boundaries[i + 1];
    if (end > start) {
      segments.push(events.slice(start, end));
    }
  }
  
  // 3. 合并短段（< 3 条）
  if (segments.length > 1) {
    const merged = [segments[0]];
    for (let i = 1; i < segments.length; i++) {
      if (segments[i].length < 3) {
        merged[merged.length - 1] = merged[merged.length - 1].concat(segments[i]);
      } else {
        merged.push(segments[i]);
      }
    }
    
    // 4. 如果段过多，按时间均匀合并
    if (merged.length > 15) {
      const N = Math.min(15, Math.ceil(merged.length / 2));
      const segSize = Math.ceil(merged.length / N);
      const remerged = [];
      for (let i = 0; i < merged.length; i += segSize) {
        const end = Math.min(i + segSize, merged.length);
        remerged.push(merged.slice(i, end).flat());
      }
      return remerged.map(toSegment);
    }
    
    return merged.map(toSegment);
  }
  
  // 无标记时，按时间均匀分段（最多 12 段）
  const N = Math.min(12, Math.ceil(events.length / 10));
  const segSize = Math.ceil(events.length / N);
  const fallback = [];
  for (let i = 0; i < events.length; i += segSize) {
    fallback.push(events.slice(i, Math.min(i + segSize, events.length)));
  }
  return fallback.map(toSegment);
}

function toSegment(records) {
  const start = new Date(records[0].ts);
  const end = new Date(records[records.length - 1].ts);
  
  // 提取话题标签
  let label = '';
  for (const ev of records) {
    const m = ev.text.match(TOPIC_BOUNDARY);
    if (m) {
      const after = ev.text.slice(m.index + m[0].length).replace(/[，。！？、；：""''（）【】《》嗯呃啊]/g, '').slice(0, 15);
      if (after.length > 0) {
        label = after;
        break;
      }
    }
  }
  if (!label) {
    label = records[0].text.replace(/[，。！？、；：""''（）【】《》嗯呃啊]/g, '').slice(0, 18);
  }
  
  return { start, end, label, records };
}

// ─── 共识提取 ───

function findConsensus(events) {
  const items = [];
  for (let i = 1; i < events.length; i++) {
    if (!CONSENSUS_PATTERNS.some(p => p.test(events[i].text))) continue;
    const prev = events[i - 1].text.replace(/[，。！？、；：""''（）【】《》]/g, '').slice(-30);
    if (prev.length < 6) continue;
    const key = prev.slice(-10);
    if (!items.some(it => it.prev.includes(key) || key.includes(it.prev))) {
      items.push({ prev });
    }
  }
  return items.slice(0, 5);
}

// ─── 争议提取 ───

function findControversies(events) {
  const items = [];
  for (let i = 0; i < events.length; i++) {
    const cur = events[i].text;
    let matched = false;
    let focus = '';
    for (const p of CONTROVERSY_PATTERNS) {
      const m = cur.match(p);
      if (m) {
        const idx = cur.indexOf(m[0]);
        focus = cur.slice(Math.max(0, idx - 8), idx + 15).replace(/[，。！？、；：""''（）【】《》]/g, '');
        matched = true;
        break;
      }
    }
    if (!matched) continue;
    const key = focus.slice(-10);
    if (!items.some(it => it.key.includes(key) || key.includes(it.key))) {
      items.push({ key, focus });
    }
  }
  return items.slice(0, 4);
}

// ─── 待办提取 ───

function findActionItems(events) {
  const items = [];
  const seen = new Set();
  
  for (const ev of events) {
    const text = ev.text;
    let what = '';
    let who = '';
    
    // 责任人
    const whoMatch = text.match(WHO_PATTERN);
    if (whoMatch) {
      who = whoMatch[1].trim();
      const after = text.slice(whoMatch.index + whoMatch[0].length).replace(/[，。！？、；：]/g, '').slice(0, 12);
      what = (whoMatch[0] + after).slice(0, 20);
    }
    
    // 动作触发词
    if (!what) {
      for (const w of ACTION_TRIGGERS) {
        const idx = text.indexOf(w);
        if (idx < 0) continue;
        const before = text.slice(Math.max(0, idx - 6), idx);
        const after = text.slice(idx + w.length, idx + w.length + 12);
        what = (before + w + after).replace(/[，。！？、；：""''（）【】《》]/g, '').slice(0, 20);
        break;
      }
    }
    
    if (!what || what.length < 3) continue;
    const key = what.slice(-8);
    if (seen.has(key)) continue;
    seen.add(key);
    
    const hasDeadline = /月底|下周|这两周|这个月|这周|两周|今天/.test(text);
    items.push({ who, what, deadline: hasDeadline });
  }
  
  return items.slice(0, 6);
}

// ─── 输出 ───

function generateDigest(events, opts) {
  if (events.length < 3) {
    console.log('\n记录太少（< 3 条），无法生成洞察\n');
    return;
  }
  
  const first = new Date(events[0].ts);
  const last = new Date(events[events.length - 1].ts);
  const dur = Math.round((last - first) / 1000);
  const title = opts.last || opts.sessions ? '会议洞察' : '记录洞察';
  
  console.log(`\n=== ${title} ===\n`);
  console.log(`  时间: ${formatTime(events[0].ts)} - ${formatTime(events[events.length - 1].ts)}  (${formatDuration(dur)})  ${events.length} 条`);
  console.log();
  
  // 讨论脉络
  const topics = segmentTopics(events);
  console.log(`  ├─ 讨论脉络（${topics.length} 段）`);
  console.log();
  for (const t of topics) {
    console.log(`  │  ${formatTime(t.start)}  ${t.label}`);
    console.log();
  }
  
  // 共识
  const consensus = findConsensus(events);
  if (consensus.length > 0) {
    console.log(`  ├─ 已达成共识`);
    console.log();
    for (const item of consensus) {
      console.log(`  │  ✓ ${item.prev.slice(0, 30)}`);
      console.log();
    }
  }
  
  // 争议
  const controversies = findControversies(events);
  if (controversies.length > 0) {
    console.log(`  ├─ 争议 / 未解决`);
    console.log();
    for (const item of controversies) {
      console.log(`  │  ✗ ${item.focus.slice(0, 25)}`);
      console.log();
    }
    console.log();
  }
  
  // 待办
  const actions = findActionItems(events);
  if (actions.length > 0) {
    console.log('  └─ 待办事项');
    console.log();
    for (const item of actions) {
      const who = item.who ? `[${item.who}] ` : '';
      const deadline = item.deadline ? ' ⏰' : '';
      console.log(`     ▶ ${who}${item.what}${deadline}`);
      console.log();
    }
  }
}

// ========== 主入口 ==========

function main() {
  const opts = parseArgs();

  // 加载关键词替换规则
  const rules = loadCorrectionRules();
  if (rules.length > 0) {
    // 仅通过 RTC_DATA_DIR 环境变量或 --raw 参数跳过替换
    if (!process.env.RTC_RAW) {
      opts._correctionRules = rules;
    }
  }

  const events = loadEvents();
  const filtered = filterEvents(events, opts);

  // 应用关键词替换（对每个事件的 text 字段）
  if (opts._correctionRules && opts._correctionRules.length > 0) {
    for (const ev of filtered) {
      ev.text = applyCorrections(ev.text, opts._correctionRules);
    }
  }

  if (opts.digest) {
    // 如果指定了 --sessions --last，用最近会议段
    if (opts.sessions && opts.last) {
      const sessions = detectSessions(filtered, opts.silence);
      if (sessions.length > 0) {
        const last = sessions[sessions.length - 1];
        generateDigest(last.texts.map((text, i) => ({ text, ts: last.times[i] })), opts);
      } else {
        console.log('未检测到会议段');
      }
    } else {
      generateDigest(filtered, opts);
    }
    return;
  }

  if (opts.transcript) {
    // 如果指定了 --sessions --last，用最近会议段
    if (opts.sessions && opts.last) {
      const sessions = detectSessions(filtered, opts.silence);
      if (sessions.length > 0) {
        const last = sessions[sessions.length - 1];
        const mapped = last.texts.map((text, i) => ({ text, ts: last.times[i] }));
        outputTranscript(mapped);
      } else {
        console.log('未检测到会议段');
      }
    } else {
      outputTranscript(filtered);
    }
    return;
  }

  if (opts.sessions) {
    const sessions = detectSessions(filtered, opts.silence);
    outputSessions(sessions, opts);
  } else {
    output(filtered, opts);
  }
}

main();