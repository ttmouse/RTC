#!/usr/bin/env node
/**
 * rtc — RTC 逐字稿的 CLI 开放入口（供外部 AI / Agent / 脚本调用）
 *
 * 设计原则：软件只做「数据采集 + 动作执行 + 配置存储」，智能层全部外置。
 * 外部 agent（Claude Code / Codex / 自定义脚本）通过本 CLI 读取聊天记录、
 * 查看/修改配置、调用已配置的 LLM 服务商、执行系统动作。
 *
 * 子命令:
 *   rtc status                         服务状态
 *   rtc transcript [--minutes N] ...   转写记录查询（直通 scripts/transcript.mjs）
 *   rtc config get [path]              读配置，path 支持点路径如 ai.baseUrl
 *   rtc config set k=v k2=v2 ...       写配置（支持嵌套路径），外部 agent 帮配置服务商
 *   rtc config test-llm                测试已配置的 AI 服务商连通性
 *   rtc llm chat "问题" [--system 系统提示]  用已配置服务商对话（JSON 输出）
 *   rtc act paste "文本" [--enter]     复制并粘贴到光标位置
 *   rtc act open "应用名" [--app 英文名] 激活应用（不做白名单，任意已安装应用）
 *   rtc help / --help
 *
 * 环境变量:
 *   RTC_DATA_DIR   覆盖数据目录（默认 ~/Library/Application Support/com.rtc.transcriber）
 *   RTC_PORT       后端端口（默认 8931）
 *
 * 全局可用：npm link 或 alias rtc="node /path/to/scripts/rtc.mjs"
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_PORT = 8931;
const BASE = `http://127.0.0.1:${process.env.RTC_PORT || DEFAULT_PORT}`;
const DATA_ROOT = process.env.RTC_DATA_DIR || join(
  homedir(),
  'Library',
  'Application Support',
  'com.rtc.transcriber'
);
const CONFIG_PATH = join(DATA_ROOT, 'config.json');
const COMMANDS_PATH = join(DATA_ROOT, 'commands.json');
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

function fail(msg, code = 1) {
  console.error(`[rtc] ${msg}`);
  process.exit(code);
}

// 以下两个 helper 与 server.js 的 chatEndpoint / providerHeaders 是同一套规则。
// CLI 是 ESM、server.js 是 CJS，共享模块会连带改动 Tauri 资源清单，因此刻意重复；
// 改一边记得同步另一边，否则「GUI 可用、CLI 报 400」这种不一致极难定位。

/** 兼容带/不带 /chat/completions 后缀的 baseUrl */
function vendorEndpoint(baseUrl) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  return /\/chat\/completions$/i.test(base) ? base : base + '/chat/completions';
}

/** OpenCode Zen Go 网关强制要求 x-opencode-session，缺失会直接 400 MissingSessionID */
function vendorHeaders(baseUrl) {
  let host = '';
  try { host = new URL(baseUrl).hostname; } catch { /* 非法地址交给 fetch 报错 */ }
  if (host === 'opencode.ai' || host.endsWith('.opencode.ai')) {
    return { 'x-opencode-session': 'rtc-cli-' + process.pid, 'User-Agent': 'rtc-transcriber-cli/1.0' };
  }
  return {};
}

function loadConfig() {
  if (!existsSync(CONFIG_PATH)) return {};
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

function saveConfig(config) {
  mkdirSync(DATA_ROOT, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
}

/** 点路径取值：get('settings.ai.baseUrl') */
function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

/** 点路径赋值（支持创建中间对象） */
function setPath(obj, path, value) {
  const keys = path.split('.');
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    if (typeof cur[k] !== 'object' || cur[k] === null) cur[k] = {};
    cur = cur[k];
  }
  cur[keys[keys.length - 1]] = value;
  return obj;
}

function parseValue(raw) {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null') return null;
  if (raw !== '' && !Number.isNaN(Number(raw))) return Number(raw);
  return raw;
}

// ---------- rtc status ----------

async function cmdStatus() {
  try {
    const r = await fetch(`${BASE}/api/status`);
    const data = await r.json();
    console.log(JSON.stringify({ ok: true, server: 'running', ...data, dataRoot: DATA_ROOT }, null, 2));
  } catch {
    console.log(JSON.stringify({ ok: false, server: 'stopped', dataRoot: DATA_ROOT }, null, 2));
    process.exit(1);
  }
}

// ---------- rtc transcript ----------

function cmdTranscript(args) {
  const script = join(SCRIPT_DIR, 'transcript.mjs');
  const r = spawnSync(process.execPath, [script, ...args], { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}

// ---------- rtc config ----------

function cmdConfigGet(path) {
  const config = loadConfig();
  const value = path ? getPath(config, path) : config;
  if (value === undefined) fail(`路径不存在: ${path}`);
  console.log(JSON.stringify(value, null, 2));
}

function cmdConfigSet(pairs) {
  const config = loadConfig();
  for (const pair of pairs) {
    const idx = pair.indexOf('=');
    if (idx <= 0) fail(`格式应为 key=value，收到: ${pair}`);
    const key = pair.slice(0, idx).trim();
    const raw = pair.slice(idx + 1).trim();
    setPath(config, key, parseValue(raw));
    console.error(`  ✓ ${key} = ${/key|token|secret/i.test(key) ? '******' : raw}`);
  }
  saveConfig(config);
  console.log('[rtc] 配置已保存');
}

async function cmdConfigTestLlm() {
  const cfg = loadConfig();
  const ai = cfg.settings && cfg.settings.ai;
  if (!ai || !ai.baseUrl || !ai.model) {
    fail('未配置 AI 服务商（缺 baseUrl/model）。可用: rtc config set settings.ai.baseUrl=... settings.ai.model=...');
  }
  const body = {
    baseUrl: ai.baseUrl,
    apiKey: ai.apiKey || '',
    model: ai.model,
    messages: [{ role: 'user', content: 'ping' }],
    maxTokens: 1,
  };
  try {
    const r = await fetch(`${BASE}/api/llm/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.ok) {
      fail(`连接失败: ${data.error || ('HTTP ' + r.status)}`);
    }
    const reply = data.data?.choices?.[0]?.message?.content || '';
    console.log(JSON.stringify({ ok: true, provider: ai.provider || 'custom', model: ai.model, reply: String(reply).slice(0, 40) }, null, 2));
  } catch (e) {
    fail(`无法连接本地服务（${e.message}），请先启动 server.js 或 Tauri 应用`);
  }
}

// ---------- rtc llm chat ----------

async function cmdLlmChat(args) {
  const cfg = loadConfig();
  const ai = cfg.settings && cfg.settings.ai;
  const prompt = args.find(a => !a.startsWith('--'));
  const systemIdx = args.indexOf('--system');
  const system = systemIdx >= 0 ? args[systemIdx + 1] : '';

  if (!prompt) fail('用法: rtc llm chat "问题" [--system 系统提示]');
  if (!ai || !ai.baseUrl || !ai.model) {
    fail('未配置 AI 服务商。外部 agent 可以这样帮用户配置：\n' +
      '  rtc config set settings.ai.provider=openai settings.ai.baseUrl=https://api.openai.com/v1 settings.ai.model=gpt-4o-mini settings.ai.apiKey=sk-xxx\n' +
      '  然后 rtc config test-llm 验证');
  }

  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: prompt });

  // 优先走本地代理（server 运行中，无需直连上游、Key 不重复下发流程）
  const body = { baseUrl: ai.baseUrl, apiKey: ai.apiKey || '', model: ai.model, messages, maxTokens: 4096 };

  const callUpstream = async (endpoint, payload, headers = {}) => {
    const r = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(60000),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    return data;
  };

  let data;
  try {
    data = await callUpstream(`${BASE}/api/llm/chat`, body);
    data = data.data;
  } catch (e) {
    // server 不可达时直连上游（CLI 独立于 GUI 运行）
    try {
      data = await callUpstream(
        vendorEndpoint(ai.baseUrl),
        { model: ai.model, messages, stream: false, max_tokens: 4096 },
        { ...(ai.apiKey ? { Authorization: `Bearer ${ai.apiKey}` } : {}), ...vendorHeaders(ai.baseUrl) }
      );
    } catch (e2) {
      fail(`LLM 调用失败: ${e2.message}`);
    }
  }

  const content = data?.choices?.[0]?.message?.content ?? '';
  const usage = data?.usage || {};
  console.log(content);
  if (usage && (usage.prompt_tokens || usage.completion_tokens)) {
    console.error(`[rtc] tokens: in=${usage.prompt_tokens} out=${usage.completion_tokens}`);
  }
}

// ---------- rtc act ----------

async function cmdActPaste(text, args) {
  const autoEnter = args.includes('--enter');
  if (!text) fail('用法: rtc act paste "文本" [--enter]');
  try {
    const r = await fetch(`${BASE}/paste`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, autoEnter }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    console.log(JSON.stringify({ ok: true, warn: data.warn || null }, null, 2));
  } catch {
    // server 未运行 → 降级为纯剪贴板
    const r = spawnSync('pbcopy', [], { input: text, env: { ...process.env, LC_ALL: 'en_US.UTF-8' } });
    if (r.status !== 0) fail('本地服务未运行且 pbcopy 失败（请先启动应用）');
    console.log(JSON.stringify({ ok: true, degraded: 'clipboard_only', note: '服务未运行，仅复制到剪贴板（请手动 Cmd+V）' }, null, 2));
  }
}

function cmdActOpen(name, args) {
  if (!name) fail('用法: rtc act open "应用名" [--app 英文标识]');
  const explicit = args.findIndex(a => a === '--app');
  const appName = explicit >= 0 ? args[explicit + 1] : name;

  // 宽松别名映射（仅帮助记忆，不构成白名单；任意英文 app 名均可直传）
  const APP_ALIASES = {
    '微信': 'WeChat', 'weixin': 'WeChat', 'wechat': 'WeChat',
    '钉钉': 'DingTalk', 'dingtalk': 'DingTalk', '企业微信': 'WeCom',
    'wecom': 'WeCom', '浏览器': 'Safari', 'safari': 'Safari',
    '谷歌浏览器': 'Google Chrome', 'chrome': 'Google Chrome',
    '终端': 'Terminal', 'terminal': 'Terminal', '访达': 'Finder',
    'finder': 'Finder', '邮件': 'Mail', 'mail': 'Mail', '备忘录': 'Notes',
    'notes': 'Notes', '日历': 'Calendar', '日历': 'Calendar',
    'wps': 'wpsoffice', 'word': 'Microsoft Word', 'excel': 'Microsoft Excel',
  };
  const resolved = explicit >= 0 ? appName : (APP_ALIASES[name] || name);

  const r = spawnSync('open', ['-a', resolved], { stdio: 'inherit' });
  if (r.status === 0) {
    console.log(JSON.stringify({ ok: true, app: resolved }, null, 2));
  } else {
    // open -a 中文名失败时尝试映射后的英文名（如直接传了中文）
    if (APP_ALIASES[name] && APP_ALIASES[name] !== resolved) {
      const r2 = spawnSync('open', ['-a', APP_ALIASES[name]], { stdio: 'inherit' });
      if (r2.status === 0) {
        console.log(JSON.stringify({ ok: true, app: APP_ALIASES[name] }, null, 2));
        return;
      }
    }
    fail(`无法打开「${name}」（${resolved}），请确认应用已安装，或指定 --app 英文标识`);
  }
}

// ---------- rtc commands ----------

// 与 server.js 内置默认表一致：仅当 commands.json 缺失时作为种子
const DEFAULT_COMMANDS = {
  '微信': 'WeChat', 'weixin': 'WeChat', 'wechat': 'WeChat',
  '钉钉': 'DingTalk', 'dingtalk': 'DingTalk',
  '企业微信': 'WeCom', 'wecom': 'WeCom',
  '浏览器': 'Safari', 'safari': 'Safari',
  '谷歌浏览器': 'Google Chrome', 'chrome': 'Google Chrome',
  '终端': 'Terminal', 'terminal': 'Terminal',
  '访达': 'Finder', 'finder': 'Finder',
};

// 默认动作指令：整句口述 → 动作（enter = 触发回车发送；meeting_summary = 总结最近会议生成 Markdown）
const DEFAULT_ACTIONS = {
  '发送': 'enter', '发送一下': 'enter', '发送吧': 'enter', '发出去': 'enter', '回车': 'enter',
  '总结会议': 'meeting_summary', '会议总结': 'meeting_summary', '总结一下会议': 'meeting_summary',
  '生成会议纪要': 'meeting_summary', '会议纪要': 'meeting_summary', '总结纪要': 'meeting_summary',
};

function loadCommands() {
  if (!existsSync(COMMANDS_PATH)) return { aliases: DEFAULT_COMMANDS, actions: DEFAULT_ACTIONS };
  try {
    const data = JSON.parse(readFileSync(COMMANDS_PATH, 'utf-8'));
    return {
      aliases: (data && data.aliases && typeof data.aliases === 'object') ? data.aliases : DEFAULT_COMMANDS,
      actions: (data && data.actions && typeof data.actions === 'object') ? data.actions : DEFAULT_ACTIONS,
    };
  } catch {
    return { aliases: DEFAULT_COMMANDS, actions: DEFAULT_ACTIONS };
  }
}

function saveCommands(data) {
  mkdirSync(DATA_ROOT, { recursive: true });
  writeFileSync(COMMANDS_PATH, JSON.stringify({ version: 1, ...data }, null, 2), 'utf-8');
}

function cmdCommandsGet() {
  const data = loadCommands();
  console.log(JSON.stringify(data, null, 2));
}

function cmdCommandsList() {
  const { aliases, actions } = loadCommands();
  if (Object.keys(aliases).length) {
    const w = Math.max(...Object.keys(aliases).map(k => k.length), 1);
    console.log('打开应用指令（口述说法 -> 应用标识）');
    console.log('-'.repeat(w + 30));
    for (const k of Object.keys(aliases)) console.log(`  ${k}${' '.repeat(w - k.length)}  ->  ${aliases[k]}`);
    console.log();
  }
  if (Object.keys(actions).length) {
    const w = Math.max(...Object.keys(actions).map(k => k.length), 1);
    console.log('动作指令（整句话 -> 动作）');
    console.log('-'.repeat(w + 20));
    for (const k of Object.keys(actions)) console.log(`  ${k}${' '.repeat(w - k.length)}  ->  ${actions[k]}`);
    console.log();
  }
  console.log(`共 ${Object.keys(aliases).length} 条打开指令 / ${Object.keys(actions).length} 条动作指令。文件: ${COMMANDS_PATH}`);
}

function cmdCommandsSet(pairs) {
  const data = loadCommands();
  for (const pair of pairs) {
    const idx = pair.indexOf('=');
    if (idx <= 0) fail(`格式应为 说法=应用标识，收到: ${pair}`);
    const k = pair.slice(0, idx).trim();
    const v = pair.slice(idx + 1).trim();
    if (!k || !v) fail(`说法与应用标识不能为空: ${pair}`);
    if (!/^[\u4e00-\u9fa5A-Za-z0-9 _\-.]*$/.test(v)) fail(`应用标识含非法字符: ${v}`);
    data.aliases[k] = v;
    console.error(`  ✓ "${k}" -> ${v}`);
  }
  saveCommands(data);
  console.log(`[rtc] 已保存 ${Object.keys(data.aliases).length} 条指令映射 → ${COMMANDS_PATH}`);
}

function cmdCommandsRemove(names) {
  const data = loadCommands();
  for (const n of names) {
    if (data.aliases[n] !== undefined) {
      delete data.aliases[n];
      console.error(`  ✗ 已删除 "${n}"`);
    } else {
      console.error(`  - 未找到 "${n}"`);
    }
  }
  saveCommands(data);
}

/** actions 子命令：rtc commands actions set 发送=enter / remove 发送 */
function cmdCommandsActions(sub, args) {
  const data = loadCommands();
  if (!data.actions) data.actions = {};
  if (sub === 'set') {
    for (const pair of args) {
      const idx = pair.indexOf('=');
      if (idx <= 0) fail(`格式应为 整句话=动作，收到: ${pair}`);
      const k = pair.slice(0, idx).trim();
      const v = pair.slice(idx + 1).trim();
      if (!/^[a-z_]+$/.test(v)) fail(`动作应为小写英文标识（如 enter），收到: ${v}`);
      data.actions[k] = v;
      console.error(`  ✓ "${k}" -> ${v}`);
    }
    saveCommands(data);
    console.log(`[rtc] 已保存 ${Object.keys(data.actions).length} 条动作指令`);
  } else if (sub === 'remove') {
    for (const n of args) {
      if (data.actions[n] !== undefined) { delete data.actions[n]; console.error(`  ✗ 已删除 "${n}"`); }
      else console.error(`  - 未找到 "${n}"`);
    }
    saveCommands(data);
  } else {
    fail('actions 子命令: set | remove');
  }
}

// ---------- main ----------

function printHelp() {
  console.log(`
rtc — RTC 逐字稿 CLI 开放入口（数据/配置/动作，供外部 AI 与脚本调用）

用法:
  rtc status
  rtc transcript [--minutes 10 | --date 2026-09-04 | --json | --transcript | ...]
  rtc config get [settings.ai.baseUrl]
  rtc config set settings.ai.baseUrl=https://api.openai.com/v1 settings.ai.model=gpt-4o-mini
  rtc config test-llm
  rtc llm chat "问题" [--system "系统提示"]
  rtc act paste "文本" [--enter]
  rtc act open "微信" [--app WeChat]
  rtc commands get | list | set "说法=应用" | remove 说法

transcript 子命令直通 scripts/transcript.mjs 的全部选项（--sessions / --digest / --raw 等）。

commands 操作的是指令映射配置文件（默认 ~/Library/Application Support/com.rtc.transcriber/commands.json）：
前端语音指令与 rtc 共用此文件，可直接把内容发给外部 AI Agent 参考或代为维护。

环境变量: RTC_DATA_DIR 数据目录 · RTC_PORT 后端端口(默认 8931)
`);
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    printHelp();
    return;
  }

  switch (cmd) {
    case 'status':
      await cmdStatus();
      break;
    case 'transcript':
      cmdTranscript(args);
      break;
    case 'config': {
      const sub = args[0];
      if (sub === 'get') {
        if (args.length < 2) fail('用法: rtc config get [path]');
        cmdConfigGet(args[1]);
      } else if (sub === 'set') {
        if (args.length < 2) fail('用法: rtc config set key=value ...');
        cmdConfigSet(args.slice(1));
      } else if (sub === 'test-llm') {
        await cmdConfigTestLlm();
      } else {
        fail('config 子命令: get | set | test-llm');
      }
      break;
    }
    case 'llm':
      if (args[0] === 'chat') await cmdLlmChat(args.slice(1));
      else fail('llm 子命令: chat');
      break;
    case 'commands':
      if (args[0] === 'get') cmdCommandsGet();
      else if (args[0] === 'list') cmdCommandsList();
      else if (args[0] === 'set') {
        if (args.length < 2) fail('用法: rtc commands set "说法=应用标识" ...');
        cmdCommandsSet(args.slice(1));
      } else if (args[0] === 'remove') {
        if (args.length < 2) fail('用法: rtc commands remove 说法 [说法2]');
        cmdCommandsRemove(args.slice(1));
      } else if (args[0] === 'actions') {
        if (args.length < 2) fail('用法: rtc commands actions set 发送=enter | remove 发送');
        cmdCommandsActions(args[1], args.slice(2));
      } else fail('commands 子命令: get | list | set | remove | actions');
      break;
    case 'act':
      if (args[0] === 'paste') await cmdActPaste(args[1], args);
      else if (args[0] === 'open') cmdActOpen(args[1], args);
      else fail('act 子命令: paste | open');
      break;
    default:
      fail(`未知命令: ${cmd}（rtc --help 查看用法）`);
  }
}

main().catch(e => {
  console.error('[rtc]', e.message || e);
  process.exit(1);
});