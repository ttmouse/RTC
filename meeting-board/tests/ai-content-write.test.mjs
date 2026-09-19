import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

// 本地模型和外部 AI agent 写的是**同一样东西**：AI 会议内容，也就是白板正文（document）。
// 所以整理成功要把结果落到 document 上，白板立刻有内容可看；但只在这份正文「还归本地模型所有」时写——
// 用户手改过、或 agent 写过，就不能被下一轮整理悄悄冲掉。这个文件盯的就是这条边界。
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

async function waitFor(check, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await wait(50);
  }
  throw new Error('等待白板正文写入超时');
}

const dataDir = await mkdtemp(join(tmpdir(), 'rtc-aicontent-'));
let rtc;
let ollama;
// 换一个模型就换一份输出，用来区分「这一轮整理」和「上一轮整理」。
let answer = '第一句原话。';

try {
  ollama = createHttpServer(async (req, res) => {
    if (req.url !== '/api/chat') { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: { content: answer } }));
  });
  const ollamaPort = await listen(ollama);

  const start = new Date(Date.now() - 3000);
  const date = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')}`;
  const sessionId = `rtc-meeting-${Math.floor(start.getTime() / 1000)}`;
  const event = (text, offsetMs, id) => ({
    schemaVersion: 1, eventId: id, type: 'segment', text,
    ts: new Date(start.getTime() + offsetMs).toISOString(),
  });
  const eventsPath = join(dataDir, 'events', `${date}.jsonl`);
  await mkdir(join(dataDir, 'events'), { recursive: true });
  await writeFile(eventsPath, `${JSON.stringify(event('第一句原话。', 0, 'e1'))}\n`, 'utf8');
  // 关键：**没有**用户正文。白板是空的，本地模型就是这份 AI 内容的第一个作者。
  await writeFile(join(dataDir, 'meeting-board.json'), JSON.stringify({ sessions: { [sessionId]: {} } }), 'utf8');

  const port = 19931 + Math.floor(Math.random() * 500);
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
    try { ready = (await fetch(`http://127.0.0.1:${port}/api/status`)).ok; }
    catch { await wait(30); }
  }
  assert.equal(ready, true, 'RTC server should start');
  const base = `http://127.0.0.1:${port}`;
  const endpoint = `${base}/api/meeting-board/preliminary?sessionId=${sessionId}`;
  const readBoard = async () => (await jsonRequest(`${base}/api/meeting-board/definition?sessionId=${sessionId}`)).data;

  // --- 1) 白板还空着：本地模型整理出来的就是 AI 会议内容，直接写进正文 ---
  await jsonRequest(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  await waitFor(async () => (await readBoard()).preliminary?.status === 'ready');
  let board = await readBoard();
  assert.equal(board.document, '第一句原话。', '本地模型的结果要写进白板正文（它就是 AI 会议内容）');
  assert.equal(board.preliminary.text, '第一句原话。');

  // --- 2) 转写变多：正文还等于上一轮本地模型的输出，说明归它所有，可以继续更新 ---
  answer = '第一句原话。第二句原话。';
  await writeFile(eventsPath, `${JSON.stringify(event('第一句原话。', 0, 'e1'))}\n${JSON.stringify(event('第二句原话。', 1000, 'e2'))}\n`, 'utf8');
  await jsonRequest(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  await waitFor(async () => (await readBoard()).preliminary?.sourceCount === 2);
  board = await readBoard();
  assert.equal(board.document, '第一句原话。第二句原话。', '正文仍归本地模型所有时，新一轮结果要接着写进去');

  // --- 3) 用户手改了正文：所有权转移，之后的整理不能再覆盖 ---
  const userEdit = '# 我自己改的白板\n\n这是我的结论，模型不许动。\n';
  const put = await jsonRequest(`${base}/api/meeting-board/document?sessionId=${sessionId}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ document: userEdit }),
  });
  assert.equal(put.response.ok, true);
  answer = '第一句原话。第二句原话。第三句原话。';
  await writeFile(eventsPath, `${JSON.stringify(event('第一句原话。', 0, 'e1'))}\n${JSON.stringify(event('第二句原话。', 1000, 'e2'))}\n${JSON.stringify(event('第三句原话。', 2000, 'e3'))}\n`, 'utf8');
  await jsonRequest(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  await waitFor(async () => (await readBoard()).preliminary?.sourceCount === 3);
  board = await readBoard();
  assert.equal(board.document, userEdit, '用户改过正文后，整理不能再覆盖它');
  assert.equal(board.preliminary.text, '第一句原话。第二句原话。第三句原话。', '整理结果本身仍然记录着（只是不再往正文写）');

  // --- 4) 外部 agent 写了正文：同样算别人写的，本地模型不许覆盖 ---
  const agentDoc = '# 外部 agent 写的会议纪要\n\n## 结论\n\n- 更聪明的模型整篇替换。\n';
  await jsonRequest(`${base}/api/meeting-board/document?sessionId=${sessionId}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ document: agentDoc }),
  });
  answer = '第一句原话。第二句原话。第三句原话。第四句原话。';
  await writeFile(eventsPath, `${JSON.stringify(event('第一句原话。', 0, 'e1'))}\n${JSON.stringify(event('第二句原话。', 1000, 'e2'))}\n${JSON.stringify(event('第三句原话。', 2000, 'e3'))}\n${JSON.stringify(event('第四句原话。', 3000, 'e4'))}\n`, 'utf8');
  await jsonRequest(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  await waitFor(async () => (await readBoard()).preliminary?.sourceCount === 4);
  board = await readBoard();
  assert.equal(board.document, agentDoc, 'agent 写过正文后，本地模型不能再覆盖');

  console.log('  ✓ AI 会议内容：本地模型与外部 agent 写同一份正文，且不覆盖用户和 agent 的成果');
} finally {
  if (rtc) rtc.kill('SIGTERM');
  if (ollama) await new Promise((resolve) => ollama.close(resolve));
  await rm(dataDir, { recursive: true, force: true });
}
