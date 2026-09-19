import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

// 白板在 AI 出结果之前就该显示逐字稿原文：这些断言盯的是「原文从哪来、什么时候有、
// 以及它绝不能影响 AI 那条链路和白板正文」。
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

const dataDir = await mkdtemp(join(tmpdir(), 'rtc-transcript-'));
let rtc;
let ollama;
// 让 Ollama 永远不返回：这样整场测试都处在「AI 还没出结果」的状态，
// 也就是这个功能真正要解决的场景。
let releaseOllama;

try {
  ollama = createHttpServer(async (req, res) => {
    if (req.url !== '/api/chat') {
      res.writeHead(404);
      res.end();
      return;
    }
    await new Promise((resolve) => { releaseOllama = resolve; });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    // 必须像一份真的整理稿：服务端有「原文保真校验」，凭空生成的内容会被判失败并回退原文。
    res.end(JSON.stringify({ message: { content: '第一句原话。第二句原话。第三句原话。' } }));
  });
  const ollamaPort = await listen(ollama);

  const start = new Date(Date.now() - 3000);
  const date = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')}`;
  const sessionId = `rtc-meeting-${Math.floor(start.getTime() / 1000)}`;
  const event = (text, offsetMs, id) => ({
    schemaVersion: 1,
    eventId: id,
    type: 'segment',
    text,
    ts: new Date(start.getTime() + offsetMs).toISOString(),
  });
  const eventsPath = join(dataDir, 'events', `${date}.jsonl`);
  await mkdir(join(dataDir, 'events'), { recursive: true });
  await writeFile(eventsPath, `${JSON.stringify(event('第一句原话。', 0, 'e1'))}\n${JSON.stringify(event('第二句原话。', 1000, 'e2'))}\n`, 'utf8');
  const originalDocument = '# 用户白板\n\n用户自己写的内容。\n';
  await writeFile(join(dataDir, 'meeting-board.json'), JSON.stringify({
    sessions: { [sessionId]: { document: originalDocument } },
  }), 'utf8');

  const port = 19931 + Math.floor(Math.random() * 1000);
  rtc = spawn(process.execPath, [join(root, 'server.js')], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      RTC_DATA_DIR: dataDir,
      RTC_OLLAMA_URL: `http://127.0.0.1:${ollamaPort}`,
      RTC_PRELIMINARY_MODEL: 'minicpm5-meeting',
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
  const definition = `${base}/api/meeting-board/definition?sessionId=${sessionId}`;

  // 1) 没有 AI 结果时，逐字稿原文必须已经可读——这正是白板打开瞬间要显示的东西。
  let board = (await jsonRequest(definition)).data;
  assert.equal(board.preliminary, null, '这一刻还没有 AI 结果');
  assert.equal(typeof board.transcript, 'string', 'transcript 字段必须存在');
  assert.equal(board.transcript, `[${String(start.getHours()).padStart(2, '0')}:${String(start.getMinutes()).padStart(2, '0')}] 第一句原话。\n[${String(new Date(start.getTime() + 1000).getHours()).padStart(2, '0')}:${String(new Date(start.getTime() + 1000).getMinutes()).padStart(2, '0')}] 第二句原话。`);
  assert.equal(board.document, originalDocument, '读原文不能影响白板正文');

  // 2) 新增转写后跟着更新，且不影响 AI 链路。
  await writeFile(eventsPath, `${JSON.stringify(event('第一句原话。', 0, 'e1'))}\n${JSON.stringify(event('第二句原话。', 1000, 'e2'))}\n${JSON.stringify(event('第三句原话。', 2000, 'e3'))}\n`, 'utf8');
  board = (await jsonRequest(definition)).data;
  assert.ok(board.transcript.includes('第三句原话。'), '新增的转写要出现在原文里');

  // 3) 触发整理但让 Ollama 挂着：这正是用户盯着空面板等 AI 的时刻。
  await jsonRequest(`${base}/api/meeting-board/preliminary?sessionId=${sessionId}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  board = (await jsonRequest(definition)).data;
  assert.equal(board.preliminary, null, 'AI 还在跑');
  assert.ok(board.transcript.includes('第三句原话。'), 'AI 挂起期间原文照样可读');

  // 4) AI 出结果之后，原文仍在（面板靠它做「这次整理基于什么」的对照）。
  // 服务端是异步发起 Ollama 请求的，等到它真的挂在 mock 上再放行。
  for (let i = 0; i < 100 && !releaseOllama; i += 1) await wait(20);
  assert.equal(typeof releaseOllama, 'function', '整理请求应该已经打到 mock Ollama');
  releaseOllama();
  await wait(300);
  board = (await jsonRequest(definition)).data;
  assert.equal(board.preliminary?.text, '第一句原话。第二句原话。第三句原话。');
  assert.equal(board.preliminary?.status, 'ready', '整理稿不该被保真校验判失败');
  assert.ok(board.transcript.includes('第三句原话。'), 'AI 出结果后原文不应消失');
  assert.equal(board.document, originalDocument, '整条链路都不能覆盖白板正文');

  // 5) 别的场次不能被串到这一场：ID 对不上就该是空的。
  const otherId = `rtc-meeting-${Math.floor(start.getTime() / 1000) - 99999}`;
  const other = (await jsonRequest(`${base}/api/meeting-board/definition?sessionId=${otherId}`)).data;
  assert.equal(other.transcript, '', '不存在的场次不能回落到别场的原文');

  console.log('  ✓ 白板逐字稿原文：AI 之前可读、随转写更新、不影响 AI 链路与用户正文');
} finally {
  if (rtc) rtc.kill('SIGTERM');
  if (ollama) await new Promise((resolve) => ollama.close(resolve));
  await rm(dataDir, { recursive: true, force: true });
}
