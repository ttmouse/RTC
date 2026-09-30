import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const root = join(import.meta.dirname, '..', '..');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}

async function jsonRequest(url, options = {}) {
  const response = await fetch(url, options);
  return { response, data: await response.json() };
}

async function waitFor(check, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await wait(50);
  }
  throw new Error('等待纪要草稿结果超时');
}

// 与 server.js formatTranscriptLines 同一套行格式（[HH:MM] 内容），用于断言 fallback 存的原文。
const pad2 = (n) => String(n).padStart(2, '0');
const formatTranscriptLines = (session) => {
  const texts = session.texts;
  const startMs = session.start.getTime();
  const endMs = session.end.getTime();
  const span = Math.max(0, endMs - startMs);
  return texts.map((text, index) => {
    const at = texts.length > 1 ? startMs + (span * index) / (texts.length - 1) : startMs;
    const d = new Date(at);
    return `[${pad2(d.getHours())}:${pad2(d.getMinutes())}] ${text}`;
  }).join('\n');
};

const dataDir = await mkdtemp(join(tmpdir(), 'rtc-preliminary-'));
const configPath = join(dataDir, 'config.json');
let rtc;
let llm;
let calls = 0;
let failLlm = false;
let lastAuth = '';
let lastModel = '';
let lastPrompt = '';
const mockDraft = '## 项目排期\n\n会上确认下周三前给出最终答案。\n\n## 待办\n\n- 未明确：给出排期答案。';

try {
  // 假 OpenAI 兼容端点（baseUrl 带 /v1，服务端补全 /chat/completions）。
  llm = createHttpServer(async (req, res) => {
    if (req.url !== '/v1/chat/completions') {
      res.writeHead(404);
      res.end();
      return;
    }
    calls += 1;
    lastAuth = req.headers.authorization || '';
    const body = await new Promise((resolve) => {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => { try { resolve(JSON.parse(raw)); } catch { resolve({}); } });
    });
    lastModel = body.model || '';
    lastPrompt = (body.messages || []).map((m) => String(m.content || '')).join('\n');
    await wait(120);
    if (failLlm) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'mock AI unavailable' } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: mockDraft } }] }));
  });
  const llmPort = await listen(llm);

  const start = new Date(Date.now() - 3000);
  const sessionAStart = new Date(start.getTime() - 600000); // 与 B 隔 10 分钟静默 → 两个场次
  const date = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')}`;
  const sessionA = {
    id: `rtc-meeting-${Math.floor(sessionAStart.getTime() / 1000)}`,
    start: sessionAStart,
    end: sessionAStart,
    texts: ['我们讨论了项目排期，会上确认了三件事，下周三之前要给出最终答案，由豆爸跟进落实。'],
  };
  const sessionB = {
    id: `rtc-meeting-${Math.floor(start.getTime() / 1000)}`,
    start,
    end: start,
    texts: ['我们讨论了项目排期，会上确认了三件事，下周三之前要给出最终答案，由豆爸跟进落实。'],
  };
  const eventLine = (session, eventId) => JSON.stringify({
    schemaVersion: 1,
    eventId,
    type: 'segment',
    text: session.texts[0],
    ts: session.start.toISOString(),
  });
  const eventsPath = join(dataDir, 'events', `${date}.jsonl`);
  await mkdir(join(dataDir, 'events'), { recursive: true });
  const rawEvents = `${eventLine(sessionA, 'event-a')}\n${eventLine(sessionB, 'event-b')}\n`;
  await writeFile(eventsPath, rawEvents, 'utf8');
  // B 场次的正文是用户手写的：草稿绝不能覆盖它；A 场次没有正文：草稿应该直接落进去。
  const originalDocument = '# 用户白板\n\n用户自己写的内容。\n';
  await writeFile(join(dataDir, 'meeting-board.json'), JSON.stringify({
    sessions: { [sessionB.id]: { document: originalDocument } },
  }), 'utf8');
  const writeAiConfig = () => writeFile(configPath, JSON.stringify({
    settings: { ai: { baseUrl: `http://127.0.0.1:${llmPort}/v1`, apiKey: 'test-key', model: 'test-model' } },
  }), 'utf8');
  await writeAiConfig();

  const port = 18931 + Math.floor(Math.random() * 1000);
  rtc = spawn(process.execPath, [join(root, 'server.js')], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      RTC_DATA_DIR: dataDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let ready = false;
  for (let i = 0; i < 100 && !ready; i += 1) {
    try {
      ready = (await fetch(`http://127.0.0.1:${port}/api/status`)).ok;
    } catch { await wait(30); }
  }
  assert.equal(ready, true, 'RTC server should start');
  const base = `http://127.0.0.1:${port}`;
  const definitionOf = async (id) => (await jsonRequest(`${base}/api/meeting-board/definition?sessionId=${id}`)).data;

  // 未配置 AI：零副作用地指路，不碰上游、不写白板数据。
  await rm(configPath);
  const unconfigured = await jsonRequest(`${base}/api/meeting-board/preliminary?sessionId=${sessionB.id}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  assert.equal(unconfigured.response.status, 200);
  assert.equal(unconfigured.data.ok, false);
  assert.equal(unconfigured.data.status, 'unconfigured');
  assert.match(unconfigured.data.error, /设置/);
  assert.equal(calls, 0, '未配置 AI 时不该有上游调用');
  await writeAiConfig();

  // 并发去重：同一场次进行中的起草只保留一份。
  const firstRequests = await Promise.all([
    jsonRequest(`${base}/api/meeting-board/preliminary?sessionId=${sessionB.id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }),
    jsonRequest(`${base}/api/meeting-board/preliminary?sessionId=${sessionB.id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }),
  ]);
  assert.equal(firstRequests[0].response.status, 202);
  assert.equal(firstRequests[1].response.status, 202);
  let previousUpdatedAt = '';
  await waitFor(async () => {
    const board = await definitionOf(sessionB.id);
    if (board.preliminary?.status !== 'ready') return null;
    previousUpdatedAt = board.preliminary.updatedAt;
    return board;
  });
  assert.equal(calls, 1, '同一份转写的并发触发只能请求一次上游');
  assert.equal(lastAuth, 'Bearer test-key', '草稿要用设置里的 apiKey');
  assert.equal(lastModel, 'test-model', '草稿要用设置里的 model');

  let board = await definitionOf(sessionB.id);
  assert.equal(board.document, originalDocument, '草稿不能覆盖用户白板正文');
  assert.equal(board.preliminary.text, mockDraft);
  assert.equal(board.preliminary.model, 'test-model');

  // 面板起草必须参考用户手写的内容：正文进提示词，手写行标成人工锚点。
  // 症状（2026-09-30）：这条路径以前只喂逐字稿，用户手写的字一个都进不去。
  assert.match(lastPrompt, /用户自己写的内容/, '手写的正文要进起草提示词，不能只喂逐字稿');
  assert.match(lastPrompt, /人工锚点/, '手写的行要标成人工锚点交给 AI');
  assert.match(lastPrompt, /原样出现在你的草稿里/, '要要求 AI 原样保留手写的句子，不改写不润色');

  // 手动重跑没有指纹缓存：同样的转写再点一次，就是真实再调一次。
  await jsonRequest(`${base}/api/meeting-board/preliminary?sessionId=${sessionB.id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  await waitFor(async () => {
    const next = await definitionOf(sessionB.id);
    return next.preliminary?.status === 'ready' && next.preliminary.updatedAt !== previousUpdatedAt ? next : null;
  });
  assert.equal(calls, 2, '手动触发必须真实重跑，不走指纹缓存');

  // 自动触发已移除：转写新增之后，不点按钮就不会有新的上游调用。
  const secondEvent = { schemaVersion: 1, eventId: 'event-b2', type: 'segment', text: '散会前大家确认下周三交初稿。', ts: new Date(start.getTime() + 1000).toISOString() };
  const rawAfterAppend = `${rawEvents}${JSON.stringify(secondEvent)}\n`;
  await writeFile(eventsPath, rawAfterAppend, 'utf8');
  await wait(800);
  board = await definitionOf(sessionB.id);
  assert.equal(board.preliminary.sourceCount, 1, '转写新增不该自动触发起草');
  assert.equal(calls, 2, '转写新增不该自动请求上游');

  // 失败回退：fallback 存格式化原文（不冒充草稿），正文与 events 一个字不动。
  sessionB.end = new Date(start.getTime() + 1000);
  sessionB.texts = [...sessionB.texts, secondEvent.text];
  failLlm = true;
  await jsonRequest(`${base}/api/meeting-board/preliminary?sessionId=${sessionB.id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  await waitFor(async () => {
    const next = await definitionOf(sessionB.id);
    return next.preliminary?.status === 'fallback' ? next : null;
  });
  board = await definitionOf(sessionB.id);
  assert.equal(board.document, originalDocument, '起草失败也不能覆盖用户白板正文');
  assert.equal(board.preliminary.text, formatTranscriptLines(sessionB));
  assert.match(board.preliminary.error, /mock AI unavailable/);
  assert.equal(await readFile(eventsPath, 'utf8'), rawAfterAppend, '原始转写文件保持不变');

  // 正文为空的场次：草稿应该直接落进 document，白板立刻有内容可看。
  failLlm = false;
  await jsonRequest(`${base}/api/meeting-board/preliminary?sessionId=${sessionA.id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  await waitFor(async () => {
    const next = await definitionOf(sessionA.id);
    return next.preliminary?.status === 'ready' ? next : null;
  });
  board = await definitionOf(sessionA.id);
  assert.equal(board.document, mockDraft, '正文为空时草稿直接写进白板正文');

  // 没有手写正文的场次不能凭空多出一段材料（提示词只多给真实存在的东西）。
  assert.ok(!lastPrompt.includes('白板正文'), '正文为空时不该凭空加一段「白板正文」');

  // AI 自己写回的正文不是人工锚点：不能把上一版 AI 的产物当成用户的现场判断。
  const boardPath = join(dataDir, 'meeting-board.json');
  const storedBoard = JSON.parse(await readFile(boardPath, 'utf8'));
  storedBoard.sessions[sessionA.id] = {
    ...storedBoard.sessions[sessionA.id],
    document: '# AI 上一版\n\n这是 AI 上次写回的纪要。\n',
    humanAnchors: [],
    agentDocumentAt: new Date().toISOString(),
  };
  await writeFile(boardPath, JSON.stringify(storedBoard), 'utf8');
  await jsonRequest(`${base}/api/meeting-board/preliminary?sessionId=${sessionA.id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  await waitFor(async () => {
    const next = await definitionOf(sessionA.id);
    return next.preliminary?.status === 'ready' ? next : null;
  });
  assert.match(lastPrompt, /全部是 AI 上次写回的/, 'AI 写回的正文要如实标成 AI 的，不能冒充人工锚点');
  assert.ok(!/原样出现在你的草稿里/.test(lastPrompt), '没有人工锚点时不该要求原样保留');

  console.log('  ✓ 会议纪要草稿：手动触发、未配置指路、并发去重、无缓存重跑、不自动触发、失败回退和正文保护');
} finally {
  if (rtc) rtc.kill('SIGTERM');
  if (llm) await new Promise((resolve) => llm.close(resolve));
  await rm(dataDir, { recursive: true, force: true });
}
