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
  throw new Error('等待白板初步整理结果超时');
}

const dataDir = await mkdtemp(join(tmpdir(), 'rtc-preliminary-'));
let rtc;
let ollama;
let calls = 0;
let failOllama = false;

try {
  ollama = createHttpServer(async (req, res) => {
    if (req.url !== '/api/chat') {
      res.writeHead(404);
      res.end();
      return;
    }
    calls += 1;
    await wait(120);
    if (failOllama) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'mock Ollama unavailable' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: { content: '原始转写，保留口语。' } }));
  });
  const ollamaPort = await listen(ollama);

  const start = new Date(Date.now() - 3000);
  const date = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')}`;
  const sessionId = `rtc-meeting-${Math.floor(start.getTime() / 1000)}`;
  const firstEvent = {
    schemaVersion: 1,
    eventId: 'event-1',
    type: 'segment',
    text: '原始转写，保留口语。',
    ts: start.toISOString(),
  };
  const eventsPath = join(dataDir, 'events', `${date}.jsonl`);
  await mkdir(join(dataDir, 'events'), { recursive: true });
  await writeFile(eventsPath, `${JSON.stringify(firstEvent)}\n`, 'utf8');
  const originalDocument = '# 用户白板\n\n用户自己写的内容。\n';
  await writeFile(join(dataDir, 'meeting-board.json'), JSON.stringify({
    sessions: { [sessionId]: { document: originalDocument } },
  }), 'utf8');

  const port = 18931 + Math.floor(Math.random() * 1000);
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
  const endpoint = `${base}/api/meeting-board/preliminary?sessionId=${sessionId}`;

  const firstRequests = await Promise.all([
    jsonRequest(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }),
    jsonRequest(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }),
  ]);
  assert.equal(firstRequests[0].response.status, 202);
  assert.equal(firstRequests[1].response.status, 202);
  await waitFor(async () => {
    const result = await jsonRequest(`${base}/api/meeting-board/definition?sessionId=${sessionId}`);
    return result.data.preliminary?.status === 'ready' ? result.data : null;
  });
  assert.equal(calls, 1, '同一份转写的并发触发只能请求一次 Ollama');

  let board = (await jsonRequest(`${base}/api/meeting-board/definition?sessionId=${sessionId}`)).data;
  assert.equal(board.document, originalDocument, '整理不能覆盖用户白板正文');
  assert.equal(board.preliminary.text, '原始转写，保留口语。');
  assert.equal(board.preliminary.model, 'minicpm5-meeting');

  const secondEvent = { ...firstEvent, eventId: 'event-2', text: '新增的原始转写。', ts: new Date(start.getTime() + 1000).toISOString() };
  const rawAfterAppend = `${JSON.stringify(firstEvent)}\n${JSON.stringify(secondEvent)}\n`;
  await writeFile(eventsPath, rawAfterAppend, 'utf8');
  await jsonRequest(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  await waitFor(async () => {
    const result = await jsonRequest(`${base}/api/meeting-board/definition?sessionId=${sessionId}`);
    return result.data.preliminary?.sourceCount === 2 ? result.data : null;
  });
  assert.equal(calls, 2, '新增转写内容才会触发新的 Ollama 请求');

  failOllama = true;
  const thirdEvent = { ...firstEvent, eventId: 'event-3', text: 'Ollama 失败时的原始转写。', ts: new Date(start.getTime() + 2000).toISOString() };
  const rawAfterFailure = `${rawAfterAppend}${JSON.stringify(thirdEvent)}\n`;
  await writeFile(eventsPath, rawAfterFailure, 'utf8');
  await jsonRequest(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  await waitFor(async () => {
    const result = await jsonRequest(`${base}/api/meeting-board/definition?sessionId=${sessionId}`);
    return result.data.preliminary?.status === 'fallback' ? result.data : null;
  });
  board = (await jsonRequest(`${base}/api/meeting-board/definition?sessionId=${sessionId}`)).data;
  assert.equal(board.document, originalDocument, '整理失败也不能覆盖用户白板正文');
  assert.equal(board.preliminary.text, '原始转写，保留口语。\n新增的原始转写。\nOllama 失败时的原始转写。');
  assert.equal(await readFile(eventsPath, 'utf8'), rawAfterFailure, '原始转写文件保持不变');
  console.log('  ✓ 白板初步整理：旁路保存、并发去重、增量触发、失败回退和用户正文保护');
} finally {
  if (rtc) rtc.kill('SIGTERM');
  if (ollama) await new Promise((resolve) => ollama.close(resolve));
  await rm(dataDir, { recursive: true, force: true });
}
