#!/usr/bin/env node
/**
 * zsx-rtc 风格后端服务器
 * 端口 8931：HTTP 服务（前端页面）+ WebSocket 代理（引擎分流）
 *
 * 浏览器 → ws://localhost:8931 → 本服务器 → 上游引擎
 *                                      ├─ engine=bailian → wss://dashscope（百炼 ASR，过滤中间帧）
 *                                      └─ engine=local   → ws://127.0.0.1:8932（本地 SenseVoice，全转发）
 */

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');

// ========== HTTP 服务（前端页面） ==========

const PORT = Number(process.env.PORT || 8931);
const TIMING_LOGS = process.env.ASR_TIMING_LOGS === '1' || process.env.RTC_TIMING_LOGS === '1';
const DEV = process.env.RTC_DEV === '1'; // 开发模式：直接服务 src/（免 build），并提供 livereload 探针
const RELOAD_PORT = Number(process.env.RELOAD_PORT || 8935);
const DATA_ROOT = process.env.RTC_DATA_DIR || path.join(
  os.homedir(),
  'Library',
  'Application Support',
  'com.rtc.transcriber'
);
const EVENTS_DIR = path.join(DATA_ROOT, 'events');
const CONFIG_PATH = path.join(DATA_ROOT, 'config.json');
const COMMANDS_PATH = path.join(DATA_ROOT, 'commands.json');
const SCHEMA_VERSION = 1;
const SEARCH_LIMIT = 300; // 搜索命中上限：只回最新的一批，避免把全部历史一次发给前端

// 应用版本号的单一来源：package.json。前端不再各写一份（曾出现 HTML 里两处硬编码）。
// 读取失败时不抛错，回落 null，由 /api/status 如实返回。
const APP_VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf-8')).version || null;
  } catch {
    return null;
  }
})();

// 指令映射默认表：口述说法 → 应用标识（首次访问 /api/commands 时写入数据目录，
// 之后以 commands.json 为准——用户或外部 AI Agent 可直接修改该文件）。
const DEFAULT_COMMANDS = {
  version: 1,
  aliases: {
    '微信': 'WeChat',
    'weixin': 'WeChat',
    'wechat': 'WeChat',
    '钉钉': 'DingTalk',
    'dingtalk': 'DingTalk',
    '企业微信': 'WeCom',
    'wecom': 'WeCom',
    '浏览器': 'Safari',
    'safari': 'Safari',
    '谷歌浏览器': 'Google Chrome',
    'chrome': 'Google Chrome',
    '终端': 'Terminal',
    'terminal': 'Terminal',
    '访达': 'Finder',
    'finder': 'Finder',
  },
  // 动作指令：整句口述 → 动作。支持的动作：enter（触发回车发送）、meeting_summary（总结最近会议生成 Markdown）
  actions: {
    '发送': 'enter',
    '发送一下': 'enter',
    '发送吧': 'enter',
    '发出去': 'enter',
    '回车': 'enter',
    '总结会议': 'meeting_summary',
    '会议总结': 'meeting_summary',
    '总结一下会议': 'meeting_summary',
    '生成会议纪要': 'meeting_summary',
    '会议纪要': 'meeting_summary',
    '总结纪要': 'meeting_summary',
  },
};
const STATIC_ROOT = path.join(__dirname, 'dist');
const SOURCE_ROOT = path.join(__dirname, 'src');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

/**
 * 允许直接访问本服务的来源。
 *
 * 之前这里是 `Access-Control-Allow-Origin: *` + 监听 `::`（全网卡），等于把
 * 「读 API Key、清空转写、往剪贴板写任意文本、拿本机当跳板发 HTTP 请求」的全部能力
 * 开放给局域网内任何一台机器，以及用户浏览器里任何一个网页（网页能跨域读 /api/config，
 * 里面存着百炼 API Key）。这是一个本机工具，不是公共服务。
 *
 * 规则：无 Origin 头（curl / 原生 fetch / Tauri webview 的自定义协议）放行；
 * 有 Origin 则必须是本服务自己的地址。前端改用同源相对路径后，正常链路根本不发跨域请求。
 */
const ALLOWED_ORIGIN_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

function isAllowedOrigin(origin) {
  if (!origin) return true; // 非浏览器发起，或同源 GET 不带 Origin
  try {
    const u = new URL(origin);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return true; // tauri:// 等 webview 自定义协议
    return ALLOWED_ORIGIN_HOSTS.has(u.hostname) && (!u.port || Number(u.port) === PORT);
  } catch {
    return false; // 畸形 Origin 一律按不可信处理
  }
}

function localDateStamp(input) {
  const d = input instanceof Date ? input : new Date(input);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ========== 会议总结（语音指令「总结会议」→ Markdown 文件） ==========

const MEETING_SILENCE_SEC = 300; // 静默 5 分钟切分会议段（与 scripts/transcript.mjs 一致）
const MEETING_OUTPUT_DIR = process.env.RTC_MEETING_OUTPUT_DIR
  || path.join(os.homedir(), 'Documents', '会议纪要');

const pad2 = n => String(n).padStart(2, '0');

/** 兼容两种 AI 地址写法：带/不带 /chat/completions 后缀 */
function chatEndpoint(baseUrl) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  return /\/chat\/completions$/i.test(base) ? base : base + '/chat/completions';
}

// 进程级稳定会话 ID：OpenCode Zen Go 要求每个「对话」带固定的 x-opencode-session，
// 网关据此做路由与 prompt cache 优化。语音指令解析是同一套 system prompt 的连续调用，
// 复用同一个 ID 才能命中缓存；会议总结按会议段各用一个（见 meetingSessionId）。
const LLM_SESSION_ID = 'rtc-' + crypto.randomUUID();

/**
 * 部分服务商的专属请求头。
 * OpenCode Zen Go 网关强制要求 x-opencode-session，缺失直接 400 MissingSessionID；
 * 同时要求客户端用自带 UA 标识自己，而不是 undici / node 这类通用 HTTP 库名。
 * 按 baseUrl 主机名判定而非 provider 字段，这样「预设 / 自定义 / 脚本直连」三条路径
 * 都自动命中，不必让每个调用方各自传参（漏传就是难查的 400）。
 */
function providerHeaders(baseUrl, sessionId) {
  let host = '';
  try { host = new URL(baseUrl).hostname; } catch { /* 非法地址交给 fetch 报错 */ }
  if (host === 'opencode.ai' || host.endsWith('.opencode.ai')) {
    return {
      'x-opencode-session': sessionId || LLM_SESSION_ID,
      'User-Agent': 'rtc-transcriber/1.0',
    };
  }
  return {};
}

/** 每个会议段一个稳定会话 ID（同一场会议重复总结时走同一条路由） */
function meetingSessionId(start) {
  const t = start instanceof Date ? start.getTime() : Date.parse(start);
  return 'rtc-meeting-' + (Number.isFinite(t) ? Math.floor(t / 1000) : 'x');
}

/**
 * 读取最近一场会议的转写事件（跨日期文件，按时间升序）。
 * 会议按「静默 > MEETING_SILENCE_SEC 切分」：最近一场 = 最近一次长静默之后的所有事件，
 * 所以从最新的日期文件往回扫，遇到第一个超过阈值的间隔就停，无需读全部历史。
 * 旧实现（readAllEvents）每次「总结会议」都把历史以来所有 jsonl readFileSync 读完再过滤，
 * 而逐字稿最终只保留最后一段、且截断到 50k 字符——扫全量历史属于纯浪费，
 * 与 /api/transcripts/events 轮询路径已修掉的全量读是同一个反模式。
 */
function readLastSessionEvents() {
  const events = [];
  let files = [];
  try {
    files = fs.readdirSync(EVENTS_DIR)
      .filter(f => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
      .sort()
      .reverse();
  } catch { return events; }
  let prevTs = null;
  const gapMs = MEETING_SILENCE_SEC * 1000;
  outer:
  for (const f of files) {
    let data = '';
    try { data = fs.readFileSync(path.join(EVENTS_DIR, f), 'utf-8'); } catch { continue; }
    const lines = data.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line.trim()) continue;
      let ev = null;
      try { ev = JSON.parse(line); } catch { /* 单行损坏跳过 */ }
      if (!ev || ev.type !== 'segment' || typeof ev.text !== 'string' || !ev.text.trim()) continue;
      const ts = Date.parse(ev.ts);
      if (!Number.isFinite(ts)) continue;
      if (prevTs !== null && prevTs - ts > gapMs) break outer;
      events.push(ev);
      prevTs = ts;
    }
  }
  events.reverse(); // 回溯扫描得到的是倒序，恢复为时间升序（与 detectSessions 的输入约定一致）
  return events;
}

/** 会议段检测：静默超过 silenceSec 即切分新段（与 transcript.mjs 相同算法） */
function detectSessions(events, silenceSec) {
  const sessions = [];
  let current = null;
  for (const ev of events) {
    const ts = new Date(ev.ts);
    if (!current) {
      current = { start: ts, end: ts, count: 1, texts: [ev.text] };
    } else {
      const gap = (ts - current.end) / 1000;
      if (gap > silenceSec) {
        sessions.push(current);
        current = { start: ts, end: ts, count: 1, texts: [ev.text] };
      } else {
        current.end = ts;
        current.count += 1;
        current.texts.push(ev.text);
      }
    }
  }
  if (current) sessions.push(current);
  return sessions;
}

function formatLocal(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** 执行会议总结：取最近一场会议 → AI 生成 Markdown → 写入 ~/Documents/会议纪要/ */
async function runMeetingSummary() {
  // 1) 读取最近一场会议的事件（从最新日期文件往回扫，遇到长静默即停，不读全量历史）
  const events = readLastSessionEvents();
  if (!events.length) throw new Error('暂无会议记录');

  // 2) 检测会议段，取最近一场
  const sessions = detectSessions(events, MEETING_SILENCE_SEC);
  const s = sessions[sessions.length - 1];

  // 3) 逐字稿（只留本段，带时间戳）
  const lines = [];
  for (const ev of events) {
    const t = new Date(ev.ts);
    if (t < s.start || t > s.end) continue;
    lines.push(`[${pad2(t.getHours())}:${pad2(t.getMinutes())}] ${ev.text}`);
  }
  const transcript = lines.join('\n').slice(0, 50000);

  // 4) AI 配置（config.json → settings.ai）
  let ai = null;
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    ai = cfg.settings && cfg.settings.ai;
  } catch { /* 未配置 */ }
  const baseUrl = ai && typeof ai.baseUrl === 'string' ? ai.baseUrl.trim() : '';
  const apiKey = ai && typeof ai.apiKey === 'string' ? ai.apiKey.trim() : '';
  const model = ai && typeof ai.model === 'string' ? ai.model.trim() : '';
  if (!baseUrl || !model) throw new Error('未配置 AI 服务商（设置 → AI 接入）');

  // 5) LLM 总结
  const system =
    '你是会议纪要整理助手。根据用户提供的会议逐字稿，生成一份结构清晰的中文 Markdown 会议纪要，包含以下小节：' +
    '## 会议概况（时间 / 时长 / 议题标题）、## 讨论要点、## 结论与共识、## 待办事项（如有明确分工或期限请列出）。' +
    '只输出 Markdown 正文，不要代码块包裹，不要客套话。如果逐字稿过短或与会议无关，如实简要说明。';
  const payload = {
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: `以下是会议逐字稿：\n${transcript}` },
    ],
    stream: false,
    max_tokens: 12000, // 思考型模型会先消耗大量 token，必须给足预算否则正文为空
  };
  let content = '';
  try {
    const upRes = await fetch(chatEndpoint(baseUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        ...providerHeaders(baseUrl, meetingSessionId(s.start)),
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(120000),
    });
    const data = await upRes.json().catch(() => ({}));
    if (!upRes.ok) {
      const detail = (data.error && (data.error.message || data.error.code))
        || `HTTP ${upRes.status}`;
      throw new Error(`AI 总结失败：${typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 200)}`);
    }
    content = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
  } catch (e) {
    if (e.name === 'TimeoutError') throw new Error('AI 总结超时，请稍后重试');
    if (e.message && e.message.startsWith('AI 总结失败')) throw e;
    throw new Error(`无法连接 AI 服务：${e.message || 'unknown'}`);
  }
  if (!content.trim()) throw new Error('AI 未返回内容，请重试');
  // 清理：去代码块包裹、去 AI 自带的一级标题（文件头已提供「# 会议纪要」），避免重复
  content = content.replace(/^```(?:markdown)?\s*|```\s*$/g, '').trim();
  content = content.replace(/^#\s+.+(\n|$)/, '');

  // 6) 写 Markdown 文件
  const startLocal = formatLocal(s.start);
  const fileName = `会议纪要_${startLocal.replace(/[-: ]/g, '').slice(0, 12)}.md`;
  fs.mkdirSync(MEETING_OUTPUT_DIR, { recursive: true });
  const filePath = path.join(MEETING_OUTPUT_DIR, fileName);
  const durMin = Math.max(1, Math.round((s.end - s.start) / 60000));
  const header = [
    '# 会议纪要',
    '',
    `> **会议时间：** ${startLocal}（约 ${durMin} 分钟）`,
    `> **转写条数：** ${s.count}`,
    '',
    '---',
    '',
  ].join('\n');
  fs.writeFileSync(filePath, header + content.replace(/^```(?:markdown)?\s*|```\s*$/g, '') + '\n');

  // 7) Finder 中显示生成的文档
  try { spawn('open', ['-R', filePath], { timeout: 3000 }); } catch { /* 忽略 */ }
  console.log(`[meeting] 会议纪要已生成: ${filePath}`);
  return { path: filePath, fileName, sessionStart: startLocal, count: s.count };
}

function appendTranscriptEvent(event, callback) {
  fs.mkdir(EVENTS_DIR, { recursive: true }, (mkdirErr) => {
    if (mkdirErr) {
      callback(mkdirErr);
      return;
    }
    const fileName = `${localDateStamp(event.ts)}.jsonl`;
    fs.appendFile(
      path.join(EVENTS_DIR, fileName),
      JSON.stringify(event) + '\n',
      callback
    );
  });
}

// ---------- config.json 写入队列 ----------
// 读-改-写整体串行 + 原子替换：多个请求同时改 config 时不会交错丢字段，
// 写一半被 kill 也不会把 config.json 截断（里面存着 API Key）。
let configWriteChain = Promise.resolve();

function enqueueConfigTask(task, callback) {
  const run = () => Promise.resolve().then(task);
  configWriteChain = configWriteChain.then(run, run);
  configWriteChain
    .then(() => callback(null), (error) => callback(error))
    .catch(() => {});
}

function readConfigFile() {
  return new Promise((resolve) => {
    fs.readFile(CONFIG_PATH, 'utf-8', (err, data) => {
      if (err) { resolve({}); return; }
      try { resolve(JSON.parse(data) || {}); } catch (e) { resolve({}); }
    });
  });
}

function writeConfigFile(config) {
  return new Promise((resolve, reject) => {
    const tmpPath = CONFIG_PATH + '.tmp';
    fs.mkdir(DATA_ROOT, { recursive: true }, (mkdirErr) => {
      if (mkdirErr) { reject(mkdirErr); return; }
      fs.writeFile(tmpPath, JSON.stringify(config, null, 2), 'utf-8', (writeErr) => {
        if (writeErr) { reject(writeErr); return; }
        fs.rename(tmpPath, CONFIG_PATH, (renameErr) => renameErr ? reject(renameErr) : resolve());
      });
    });
  });
}

/** 整体覆盖（PUT） */
function writeConfig(config, callback) {
  enqueueConfigTask(() => writeConfigFile(config), callback);
}

/**
 * 嵌套对象的深合并：PATCH 的语义是「只更新指定字段」，所以嵌套对象（如 settings.ai）
 * 必须逐层合并。浅合并会把整个子对象替换掉，让未提及的同级字段静默丢失。
 * 数组按值整体替换，不当成可合并对象。
 *
 * 注意：PATCH 的 body 是外部传入的任意 JSON，`{"__proto__":{"x":1}}` 这类键在
 * 递归赋值时会走 Object.prototype 的 setter 污染全局原型。这里的字段名全部来自
 * 白名单式的应用配置，本机低风险，但一个 sanitize 就能堵住，不值得留口子。
 */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function deepMerge(base, patch) {
  const out = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (UNSAFE_KEYS.has(key)) continue;
    const prev = base[key];
    const mergeable = value && prev &&
      typeof value === 'object' && typeof prev === 'object' &&
      !Array.isArray(value) && !Array.isArray(prev);
    out[key] = mergeable ? deepMerge(prev, value) : value;
  }
  return out;
}

/** 只合并指定字段（PATCH）：read-modify-write 在队列里完成 */
function patchConfig(partial, callback) {
  enqueueConfigTask(async () => {
    const current = await readConfigFile();
    await writeConfigFile(deepMerge(current, partial));
  }, callback);
}

function readJsonBody(req, callback) {
  let body = '';
  req.on('data', chunk => {
    body += chunk;
    if (body.length > 1024 * 1024) {
      req.destroy();
    }
  });
  req.on('end', () => {
    try {
      callback(null, body ? JSON.parse(body) : {});
    } catch (e) {
      callback(e);
    }
  });
}

const server = http.createServer((req, res) => {
  // 允许 Tauri webview（tauri:// 协议）回退调用本机 HTTP 服务。
  // 只回显可信来源，不再用 `*`：`*` 会让任意网页跨域读到 /api/config 里的 API Key。
  const origin = req.headers.origin;
  if (origin && isAllowedOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  // 写操作与读配置：来源不可信直接拒绝，别指望 CORS 拦得住（CORS 只拦「读响应」，
  // 拦不住「请求已生效」——清空转写、改配置这类副作用必须在服务端拒绝）。
  if (!isAllowedOrigin(origin)) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'origin not allowed' }));
    return;
  }

  // GET /api/config — 读取本地配置
  if (req.method === 'GET' && req.url === '/api/config') {
    fs.readFile(CONFIG_PATH, 'utf-8', (err, data) => {
      if (err) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(data);
    });
    return;
  }

  // GET /api/status — 服务运行状态（uptime 单位秒），供前端判断服务是否正常
  if (req.method === 'GET' && req.url === '/api/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, uptime: Math.floor(process.uptime()), pid: process.pid, version: APP_VERSION }));
    return;
  }

  // GET /api/storage — 存储位置与文件概览（设置面板展示用）
  if (req.method === 'GET' && req.url === '/api/storage') {
    let eventFiles = 0, eventBytes = 0;
    try {
      const files = fs.readdirSync(EVENTS_DIR).filter(f => f.endsWith('.jsonl'));
      eventFiles = files.length;
      for (const f of files) {
        eventBytes += fs.statSync(path.join(EVENTS_DIR, f)).size;
      }
    } catch { /* 目录不存在视为 0 */ }
    const exists = p => { try { return fs.statSync(p).isFile(); } catch { return false; } };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      dataRoot: DATA_ROOT,
      eventsDir: EVENTS_DIR,
      configFile: CONFIG_PATH,
      commandsFile: COMMANDS_PATH,
      stats: {
        eventFiles,
        eventBytes,
        configExists: exists(CONFIG_PATH),
        commandsExists: exists(COMMANDS_PATH),
      },
    }));
    return;
  }

  // GET /api/commands — 读取指令映射表（不存在时返回内置默认表；旧文件缺 actions 自动补齐）
  if (req.method === 'GET' && req.url === '/api/commands') {
    fs.readFile(COMMANDS_PATH, 'utf-8', (err, data) => {
      if (err) {
        // 首次访问：把默认表落盘，之后以文件为准
        fs.mkdir(DATA_ROOT, { recursive: true }, () => {
          fs.writeFile(COMMANDS_PATH, JSON.stringify(DEFAULT_COMMANDS, null, 2), 'utf-8', () => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(DEFAULT_COMMANDS));
          });
        });
        return;
      }
      let parsed = {};
      try { parsed = JSON.parse(data); } catch { /* 损坏时按默认表重建 */ }
      const upgraded = !parsed.aliases || typeof parsed.aliases !== 'object';
      if (!parsed.actions || typeof parsed.actions !== 'object') {
        parsed.actions = { ...DEFAULT_COMMANDS.actions };
      }
      if (upgraded) parsed.aliases = { ...DEFAULT_COMMANDS.aliases };
      if (upgraded || JSON.stringify(parsed) !== data.replace(/\s+$/, '')) {
        fs.writeFile(COMMANDS_PATH, JSON.stringify(parsed, null, 2), 'utf-8', () => {});
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(parsed));
    });
    return;
  }

  // PUT /api/commands — 保存指令映射表（前端学习回写 / 外部工具修改）
  if (req.method === 'PUT' && req.url === '/api/commands') {
    readJsonBody(req, (err, parsed) => {
      if (err || !parsed || typeof parsed !== 'object') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'invalid json' }));
        return;
      }
      if (!parsed.aliases || typeof parsed.aliases !== 'object') {
        if (!parsed.actions || typeof parsed.actions !== 'object') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'aliases or actions object required' }));
          return;
        }
      }
      fs.mkdir(DATA_ROOT, { recursive: true }, (mkdirErr) => {
        if (mkdirErr) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: mkdirErr.message }));
          return;
        }
        fs.writeFile(COMMANDS_PATH, JSON.stringify(parsed, null, 2), 'utf-8', (writeErr) => {
          if (writeErr) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: writeErr.message }));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        });
      });
    });
    return;
  }

  // POST /key/enter — 触发回车键（语音指令「发送」用；不碰剪贴板）。
  // 需 macOS 辅助功能权限；失败降级为仅提示。
  if (req.method === 'POST' && req.url === '/key/enter') {
    const cmd = 'tell application "System Events" to keystroke return';
    const as = spawn('osascript', ['-e', cmd], {
      timeout: 2000,
      env: { ...process.env, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
    });
    as.on('exit', (code) => {
      if (code === 0) {
        console.log('[key] enter 已发送');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } else {
        console.warn('[key] enter 发送失败 (exit:', code, ') — 可能缺少辅助功能权限');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: true,
          warn: 'accessibility_permission_required',
          message: '已尝试触发回车，但可能缺少辅助功能权限',
        }));
      }
    });
    as.on('error', (e) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    });
    return;
  }

  // POST /api/llm/chat — OpenAI 兼容 Chat Completions 代理
  // 浏览器 → 本服务 → 自定义服务商（baseUrl/apiKey/model 由前端传入，Key 只在本机流转）
  if (req.method === 'POST' && req.url === '/api/llm/chat') {
    readJsonBody(req, async (err, parsed) => {
      if (err || !parsed || typeof parsed !== 'object') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'invalid json' }));
        return;
      }
      const baseUrl = typeof parsed.baseUrl === 'string' ? parsed.baseUrl.trim() : '';
      const apiKey = typeof parsed.apiKey === 'string' ? parsed.apiKey.trim() : '';
      const model = typeof parsed.model === 'string' ? parsed.model.trim() : '';
      const messages = Array.isArray(parsed.messages) ? parsed.messages : null;
      if (!baseUrl || !model || !messages || !messages.length) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'baseUrl / model / messages are required' }));
        return;
      }
      // 用 chatEndpoint 而非裸拼后缀：设置页允许直接粘贴带 /chat/completions 的完整
      // 地址，裸拼会变成 .../chat/completions/chat/completions → 404，
      // 再被 prettifyAIError 误报成「API 地址是否以 /v1 结尾」，把用户带偏。
      const endpoint = chatEndpoint(baseUrl);
      const payload = {
        model,
        messages,
        stream: false,
        max_tokens: Number.isFinite(parsed.maxTokens) ? parsed.maxTokens : 64,
      };
      try {
        const upstreamRes = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
            ...providerHeaders(baseUrl),
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(30000),
        });
        const data = await upstreamRes.json().catch(() => ({}));
        if (!upstreamRes.ok) {
          const detail = (data && data.error && (data.error.message || data.error.code || data.error.type))
            || JSON.stringify(data).slice(0, 300)
            || `HTTP ${upstreamRes.status}`;
          res.writeHead(upstreamRes.status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, status: upstreamRes.status, error: typeof detail === 'string' ? detail : String(detail) }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, data }));
      } catch (e) {
        const msg = (e && e.name === 'TimeoutError')
          ? '连接超时：请检查 API 地址与网络'
          : (e && e.cause && e.cause.code)
            ? `无法连接服务商（${e.cause.code}）：请检查 API 地址是否可访问`
            : (e.message || 'unknown error');
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: msg }));
      }
    });
    return;
  }

  // POST /api/tasks/meeting-summary — 总结最近一次会议并生成 Markdown 文件
  if (req.method === 'POST' && req.url === '/api/tasks/meeting-summary') {
    readJsonBody(req, async (err) => {
      if (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'invalid json' }));
        return;
      }
      try {
        const result = await runMeetingSummary();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, ...result }));
      } catch (e) {
        const msg = (e && e.message) || 'unknown error';
        console.warn('[meeting] 总结失败:', msg);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: msg }));
      }
    });
    return;
  }

  // PUT /api/config — 整体覆盖本地配置（保留兼容；新代码请用 PATCH）
  if (req.method === 'PUT' && req.url === '/api/config') {
    readJsonBody(req, (err, parsed) => {
      if (err || !parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'invalid config' }));
        return;
      }
      writeConfig(parsed, (writeErr) => {
        if (writeErr) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: writeErr.message }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    return;
  }

  // PATCH /api/config — 只更新指定字段
  // 前端有三类互相独立的写入者（录音计时的 totalDuration、设置项的 settings、纠错规则
  // 的 correctionRules），旧写法各自「GET 全量 → 改自己那一个字段 → PUT 全量」，两个
  // 写入者交错时后写的那个会用陈旧快照把对方刚存的字段覆盖掉（丢失更新）；而且录音中
  // 计时每 1s 就要把整份 config（含 API Key）重写一遍。合并放到服务端串行做，各写各的。
  if (req.method === 'PATCH' && req.url === '/api/config') {
    readJsonBody(req, (err, parsed) => {
      if (err || !parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'invalid config patch' }));
        return;
      }
      patchConfig(parsed, (patchErr) => {
        if (patchErr) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: patchErr.message }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    return;
  }

  // POST /api/transcripts/events — 追加结构化本地事件
  if (req.method === 'POST' && req.url === '/api/transcripts/events') {
    readJsonBody(req, (err, parsed) => {
      if (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'invalid json' }));
        return;
      }
      const incoming = parsed.event || parsed;
      const text = typeof incoming.text === 'string' ? incoming.text.trim() : '';
      if (incoming.type !== 'segment' || !text) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'event.type=segment and text are required' }));
        return;
      }
      const ts = incoming.ts ? new Date(incoming.ts) : new Date();
      if (!Number.isFinite(ts.getTime())) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'invalid ts' }));
        return;
      }
      const event = {
        schemaVersion: SCHEMA_VERSION,
        eventId: incoming.eventId || crypto.randomUUID(),
        type: 'segment',
        text,
        ts: ts.toISOString(),
        engine: incoming.engine || null,
      };
      appendTranscriptEvent(event, (writeErr) => {
        if (writeErr) {
          console.error('[transcript] append failed:', writeErr.message);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: writeErr.message }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, event }));
      });
    });
    return;
  }

  // GET /api/transcripts/events — 读取事件；支持 ?date=YYYY-MM-DD、?from&to、?q=关键词（跨全部历史）
  if (req.method === 'GET' && req.url.startsWith('/api/transcripts/events')) {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    const date = url.searchParams.get('date');
    const fromParam = url.searchParams.get('from');
    const toParam = url.searchParams.get('to');
    const q = (url.searchParams.get('q') || '').trim().toLowerCase();

    const parseEvents = data => data
      .split('\n')
      .filter(Boolean)
      .map(line => {
        try {
          return JSON.parse(line);
        } catch (e) {
          return null;
        }
      })
      .filter(Boolean);

    const sendEvents = (events, limit) => {
      events.sort((a, b) => new Date(a.ts) - new Date(b.ts));
      if (limit && events.length > limit) events = events.slice(-limit);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(events));
    };

    const readDateFile = requestedDate => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(requestedDate)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'invalid date' }));
        return;
      }
      fs.readFile(path.join(EVENTS_DIR, `${requestedDate}.jsonl`), 'utf-8', (readErr, data) => {
        sendEvents(readErr ? [] : parseEvents(data));
      });
    };

    if (date) {
      readDateFile(date);
      return;
    }

    if (!fromParam && !toParam) {
      readDateFile(localDateStamp(new Date()));
      return;
    }

    const from = fromParam ? Date.parse(fromParam) : NaN;
    const to = toParam ? Date.parse(toParam) : Infinity;
    if ((fromParam && !Number.isFinite(from)) || (toParam && !Number.isFinite(to))) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'invalid from/to' }));
      return;
    }

    fs.readdir(EVENTS_DIR, (readErr, files) => {
      if (readErr) {
        sendEvents([]);
        return;
      }
      // 文件名就是事件的本地日期（见 appendTranscriptEvent 的 `${localDateStamp}.jsonl`）。
      // 先按请求时间窗把文件裁掉，避免为了取最近 30 分钟而把历史以来的全部 jsonl
      // 读一遍、解析一遍——该接口由历史列表刷新高频调用，窗口裁剪后成本只与窗口天数相关。
      // 搜索要跨全部历史，所以带 q 时不按日期裁剪文件
      const fromDay = !q && Number.isFinite(from) ? localDateStamp(new Date(from)) : null;
      const toDay = !q && Number.isFinite(to) ? localDateStamp(new Date(to)) : null;
      const jsonlFiles = files.filter(file => {
        if (!file.endsWith('.jsonl')) return false;
        const day = file.slice(0, 10);
        // YYYY-MM-DD 字典序即时间序
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return true; // 命名异常的文件保守保留
        if (fromDay && day < fromDay) return false;
        if (toDay && day > toDay) return false;
        return true;
      });
      let pending = jsonlFiles.length;
      const allEvents = [];
      if (pending === 0) {
        sendEvents([]);
        return;
      }
      for (const file of jsonlFiles) {
        fs.readFile(path.join(EVENTS_DIR, file), 'utf-8', (fileErr, data) => {
          if (!fileErr) allEvents.push(...parseEvents(data));
          pending -= 1;
          if (pending === 0) {
            if (q) {
              sendEvents(allEvents.filter(event =>
                String(event.text || '').toLowerCase().includes(q)), SEARCH_LIMIT);
              return;
            }
            sendEvents(allEvents.filter(event => {
              const ts = Date.parse(event.ts);
              return ts >= from && ts <= to;
            }));
          }
        });
      }
    });
    return;
  }

  // DELETE /api/transcripts/events — 清空本地事件文件
  if (req.method === 'DELETE' && req.url === '/api/transcripts/events') {
    fs.rm(EVENTS_DIR, { recursive: true, force: true }, (rmErr) => {
      if (rmErr) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: rmErr.message }));
        return;
      }
      fs.mkdir(EVENTS_DIR, { recursive: true }, (mkdirErr) => {
        if (mkdirErr) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: mkdirErr.message }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    return;
  }

  // 已删除：/api/settings 与 /api/history（5 个 handler，约 85 行）。
  // 它们把 settings.json / history.json 写进 __dirname，也就是安装后的
  // Contents/Resources 或仓库根目录——打包后是只读路径，写入必然失败；开发时则往仓库里
  // 拉屎（实测 POST /api/settings 直接生成 RTC/settings.json）。前端从来不调用它们：
  // 历史在 localStorage，设置在 /api/config。留着就是纯粹的负担。
  // 如果确实需要「往数据目录写任意 JSON」，用 /api/config 或 /api/transcripts/events。

  // POST /paste — 服务端 pbcopy + osascript 模拟粘贴
  if (req.method === 'POST' && req.url === '/paste') {
    let body = '';
    let startedAt = Date.now();
    let done = false;
    const respond = (code, data) => {
      if (done) return;
      done = true;
      try { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); } catch (e) {}
    };
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      startedAt = Date.now();
      let text, autoEnter = false;
      try {
        const parsed = JSON.parse(body);
        text = (parsed.text || '').slice(0, 5000);
        autoEnter = !!parsed.autoEnter;
      } catch (e) {
        text = body.slice(0, 5000);
      }
      // 1) pbcopy 把文本写入剪贴板
      const pbcpy = spawn('pbcopy', [], {
        timeout: 2000,
        env: { ...process.env, LC_ALL: 'en_US.UTF-8' }
      });
      pbcpy.stdin.write(text);
      pbcpy.stdin.end();
      pbcpy.on('close', () => {
        if (TIMING_LOGS) console.log(`[timing-node] paste.pbcopy ${Date.now() - startedAt}ms textLen=${text.length}`);
        // pbcopy 已成功设置剪贴板，光标位置已可用
        // 2) osascript 模拟 Cmd+V 粘贴（可能因辅助功能权限失败，但剪贴板已设置）
        let cmd;
        if (autoEnter) {
          cmd = 'tell application "System Events"\n  keystroke "v" using command down\n  delay 0.3\n  keystroke return\nend tell';
        } else {
          cmd = 'tell application "System Events" to keystroke "v" using command down';
        }
        const as = spawn('osascript', ['-e', cmd], {
          timeout: 2000,
          env: { ...process.env, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }
        });
        as.on('exit', (code) => {
          if (TIMING_LOGS) console.log(`[timing-node] paste.osascript ${Date.now() - startedAt}ms code=${code}`);
          if (code === 0) {
            console.log('[paste] 成功' + (autoEnter ? ' + 回车' : '') + ':', text.slice(0, 40));
            respond(200, { ok: true });
          } else {
            // pbcopy 已写入剪贴板，osascript 失败不影响复制结果
            // 常见原因：进程未获得 macOS 辅助功能权限（仅影响自动粘贴，不影响剪贴板）
            console.warn('[paste] pbcopy 已写入剪贴板，但 osascript 自动粘贴失败 (exit:', code, ')— 用户可手动 Cmd+V');
            respond(200, { ok: true, warn: 'auto_paste_disabled', message: '已复制到剪贴板，请手动粘贴 (Cmd+V)' });
          }
        });
        as.on('error', (e) => {
          if (TIMING_LOGS) console.log(`[timing-node] paste.osascript_error ${Date.now() - startedAt}ms`);
          // osascript 启动失败，但 pbcopy 已写入剪贴板
          console.warn('[paste] pbcopy 已写入剪贴板，但 osascript 无法启动:', e.message);
          respond(200, { ok: true, warn: 'auto_paste_disabled', message: '已复制到剪贴板，请手动粘贴 (Cmd+V)' });
        });
      });
      pbcpy.on('error', (e) => {
        console.error('[paste] pbcopy 失败:', e.message);
        respond(500, { ok: false, error: e.message });
      });
    });
    req.on('error', () => respond(500, { ok: false, error: 'request error' }));
    return;
  }

  const filePath = req.url === '/' ? '/index.html' : req.url;
  if (DEV && req.url === '/__dev_reload.js') {
    // 开发模式热更新探针：连接 dev.mjs 的 WebSocket，收到 reload 即刷新页面
    res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(`(()=>{if(!window.WebSocket)return;let ws=null,retry=0;const host=location.hostname||'localhost';function connect(){try{ws=new WebSocket('ws://'+host+':'+${RELOAD_PORT});ws.onopen=()=>{retry=0};ws.onmessage=e=>{if(e.data==='reload')location.reload()};ws.onclose=()=>{ws=null;setTimeout(connect,Math.min(1000*Math.pow(2,retry++),5000))};ws.onerror=()=>{try{ws.close()}catch(_){}}}catch(_){}}connect();})();`);
    return;
  }
  const staticRoot = DEV ? SOURCE_ROOT
    : (fs.existsSync(path.join(STATIC_ROOT, 'index.html')) ? STATIC_ROOT : SOURCE_ROOT);
  const fullPath = path.join(staticRoot, filePath);

  if (!fullPath.startsWith(staticRoot)) {
    res.writeHead(403); res.end();
    return;
  }

  fs.readFile(fullPath, (err, data) => {
    if (err) {
      res.writeHead(404); res.end('Not found');
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      'Pragma': 'no-cache',
      'Expires': '0',
    });
    res.end(data);
  });
});

/**
 * 只给本地 Python 引擎看的参数，不能出现在发给百炼的 parameters 里。
 *
 * 前端用同一段代码构造 run-task：`engine` / `vad_threshold` / `silence_timeout` /
 * `auto_paste` 是「本地引擎切换 + 本地 VAD 调参」用的，百炼那边没有任何对应概念。
 * 用户可见的 auto_paste 保留（前端要读回），其余在百炼分支剥掉。
 */
const LOCAL_ONLY_PARAMS = ['engine', 'qwen3_model_dir', 'vad_threshold', 'silence_timeout'];

/** 百炼分支的 run-task 清洗：剥掉本地专用参数，其余字段原样保留。 */
function sanitizeBailianTask(text) {
  try {
    const parsed = JSON.parse(text);
    const params = parsed && parsed.payload && parsed.payload.parameters;
    if (!params || typeof params !== 'object') return text;
    let changed = false;
    for (const key of LOCAL_ONLY_PARAMS) {
      if (key in params) {
        delete params[key];
        changed = true;
      }
    }
    return changed ? JSON.stringify(parsed) : text;
  } catch (e) {
    return text; // 非 JSON 一律原样转发，别在代理层引入新的失败点
  }
}

// ========== WebSocket 代理（引擎分流） ==========

const LOCAL_ASR_URL = process.env.LOCAL_ASR_URL || 'ws://127.0.0.1:8932';

const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
  let upstream = null;
  let engine = null;
  let closed = false;

  const close = () => {
    if (closed) return;
    closed = true;
    if (upstream) {
      try { upstream.close(); } catch (e) {}
      upstream = null;
    }
    try { ws.close(); } catch (e) {}
  };

  // 第一步：等待浏览器发送 connect 消息
  ws.once('message', async (data) => {
    let connectMsg;
    try {
      connectMsg = JSON.parse(data);
    } catch (e) {
      ws.send(JSON.stringify({ type: 'error', message: 'invalid connect message' }));
      return close();
    }

    if (connectMsg.type !== 'connect') {
      ws.send(JSON.stringify({ type: 'error', message: 'expected connect message' }));
      return close();
    }

    engine = connectMsg.engine || 'bailian';
    // 本地类引擎（sensevoice/qwen3 等）统一连本地 Python ASR 服务；bailian 走云端 URL
    const isLocal = engine !== 'bailian';
    const upstreamUrl = isLocal
      ? LOCAL_ASR_URL
      : connectMsg.url; // bailian: wss://dashscope...?api_key=...

    if (!isLocal && !upstreamUrl) {
      ws.send(JSON.stringify({ type: 'error', message: 'missing upstream url' }));
      return close();
    }

    console.log(`[server] engine=${engine} connecting to ${isLocal ? LOCAL_ASR_URL : '百炼'}`);

    // 第二步：连接上游引擎
    try {
      upstream = new WebSocket(upstreamUrl);
    } catch (e) {
      ws.send(JSON.stringify({ type: 'error', message: `上游连接失败: ${e.message}` }));
      return close();
    }

    upstream.on('open', () => {
      console.log(`[server] ${engine} connected`);
      ws.send(JSON.stringify({ type: 'connected' }));
    });

    upstream.on('error', (err) => {
      console.log(`[server] ${engine} error:`, err.message);
      ws.send(JSON.stringify({ type: 'error', message: `${isLocal ? '本地ASR' : '百炼'}错误: ${err.message}` }));
      close();
    });

    upstream.on('close', () => {
      console.log(`[server] ${engine} disconnected`);
      close();
    });

    // 第三步：上游 → 浏览器
    upstream.on('message', (upData) => {
      if (closed) return;

      // 统一转为字符串（上游返回的可能是二进制帧，浏览器收到 Blob 后 JSON.parse 会失败）
      const text = typeof upData === 'string' ? upData : upData.toString('utf-8');

      try {
        const parsed = JSON.parse(text);
        const event = parsed.header && parsed.header.event;

        if (event === 'result-generated') {
          const sentence = parsed.payload && parsed.payload.output && parsed.payload.output.sentence;
          const textContent = sentence && sentence.text;

          if (TIMING_LOGS && sentence) {
            const nodeReceivedAt = Date.now();
            if (!sentence.timing) sentence.timing = {};
            sentence.timing.node_received_wall_ms = nodeReceivedAt;
            sentence.timing.node_sent_wall_ms = nodeReceivedAt;
            console.log(`[timing-node] asr_result_received engine=${engine} taskId=${parsed.header.task_id} segId=${sentence.seg_id || ''} textLen=${(textContent || '').length}`);
          }

          if (isLocal) {
            // 本地引擎（sensevoice/qwen3）：Python 端已只发完整句，全转发
            if (textContent) {
              console.log(`[server] ${engine} result: ${textContent.slice(0, 40)}...`);
              ws.send(TIMING_LOGS ? JSON.stringify(parsed) : text);
            }
          } else {
            // 百炼：所有有文本的结果都转发（中间帧用于前端临时行显示，完整句带 end_time 用于定型）
            if (textContent) {
              console.log(`[server] bailian result: ${textContent.slice(0, 40)}...`);
              ws.send(TIMING_LOGS ? JSON.stringify(parsed) : text);
            } else {
              console.log(`[server] skip interim (no text)`);
            }
          }
        } else {
          // 其他事件（task-started, task-finished 等）→ 转发
          console.log(`[server] event=${event}`);
          ws.send(text);
        }
      } catch (e) {
        // 非 JSON 消息，转发
        console.log(`[server] non-json message, forwarding`);
        ws.send(text);
      }
    });

    // 第四步：浏览器 → 上游（原样转发）
    ws.on('message', (browserData, isBinary) => {
      if (closed || !upstream) {
        console.log('[server] drop msg: closed or no upstream');
        return;
      }
      if (upstream.readyState !== WebSocket.OPEN) {
        console.log('[server] drop msg: upstream not open, readyState=' + upstream.readyState);
        return;
      }

      // 二进制帧（PCM 音频）→ 原样转发，必须保持二进制帧类型！
      if (isBinary) {
        upstream.send(browserData, { binary: true });
        return;
      }

      // 文本帧 → 处理 JSON 消息
      const text = typeof browserData === 'string' ? browserData : browserData.toString('utf-8');

      // 跳过 connect 消息（已经处理过了）
      try {
        const parsed = JSON.parse(text);
        if (parsed.type === 'connect') {
          console.log('[server] skip connect msg');
          return;
        }
      } catch (e) {}

      // 发送给上游（字符串 → 文本帧）
      const outgoing = isLocal ? text : sanitizeBailianTask(text);
      console.log(`[server] forward to ${engine}: ${outgoing.slice(0, 60)}...`);
      try {
        upstream.send(outgoing);
      } catch (e) {
        console.log('[server] upstream.send error:', e.message);
      }
    });

    ws.on('close', close);
    ws.on('error', close);
  });

  // 30 秒超时：如果浏览器没发 connect 消息，断开
  setTimeout(() => {
    if (!upstream) {
      ws.close();
    }
  }, 30000);
});

/**
 * 启动监听。
 *
 * 两处刻意的改动：
 * 1) 只绑 127.0.0.1。原来绑 `::`（所有网卡），配合 `Access-Control-Allow-Origin: *`
 *    等于把一个能读 API Key、能操作剪贴板的服务暴露给整个局域网。Node 的 127.0.0.1
 *    在 macOS 上同时接受 IPv4/IPv6 回环连接，`localhost` 解析成 ::1 也能连上。
 * 2) 不再自动抢端口。原来端口被占时会 `lsof -ti tcp:PORT | kill -9` 无条件杀掉占用者——
 *    那是别人的进程。端口冲突应该报错让人看见，而不是静默谋杀。Tauri 侧已经在启动前
 *    清理自己上一轮的残留进程（kill_previous_processes），这里不需要第二把刀。
 */
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[server] 端口 ${PORT} 已被占用。请先退出正在运行的 RTC / 开发服务，或换端口：PORT=8933 node server.js`);
  } else {
    console.error(`[server] 启动失败: ${err.message}`);
  }
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Server running at http://localhost:${PORT}`);
  console.log(`WebSocket proxy at ws://localhost:${PORT}`);
  console.log(`Engines: bailian (cloud) / local (SenseVoice @ ${LOCAL_ASR_URL})`);
});
