import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

// 安全边界回归（TTM-2 扫描修复）：
//
// 1. PUT /api/meeting-board/document 等接口的 sessionId 必须过白名单——
//    ?sessionId=..%2F..%2Ffoo 曾能把任意路径拼进写盘调用（路径遍历写任意 .md）。
// 2. WS 升级请求带不可信 Origin 时必须被拒——浏览器对 WS 握手不受 CORS 约束，
//    没有这道闸，任意网页都能跨站连上本地代理。
// 3. bailian 上游地址白名单——connectMsg.url 是客户端可控字段，不收窄就是
//    指向任意 ws/wss 地址的中继（SSRF）。
//
// 服务器侧用真实 server.js + 临时数据目录验证；白名单函数用源码断言钉住
// （导出它会扩大 server.js 的公共面，不值得）。

const root = join(import.meta.dirname, '..');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}

let passed = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { passed += 1; console.log(`  ✓ ${name}`); }
  else { failures.push(name); console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
}

const dataDir = await mkdtemp(join(tmpdir(), 'rtc-security-'));
let rtc;

try {
  const port = 19931 + Math.floor(Math.random() * 1000);
  const base = `http://127.0.0.1:${port}`;
  rtc = spawn(process.execPath, [join(root, 'server.js')], {
    cwd: root,
    env: { ...process.env, PORT: String(port), RTC_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  rtc.stderr.on('data', () => {}); // 启动日志静音
  let ready = false;
  for (let i = 0; i < 100 && !ready; i += 1) {
    try { ready = (await fetch(`${base}/api/status`)).ok; } catch { await wait(30); }
  }
  assert.equal(ready, true, 'RTC server should start');

  // ---- 1. sessionId 路径遍历 ----
  const evilId = encodeURIComponent('../../rtc-security-escape');
  const putDoc = await fetch(`${base}/api/meeting-board/document?sessionId=${evilId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ document: '# pwned\n' }),
  });
  check('PUT document 恶意 sessionId 被拒绝(400)',
    putDoc.status === 400,
    `status=${putDoc.status}`);
  const putDef = await fetch(`${base}/api/meeting-board/definition?sessionId=${evilId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ background: 'x' }),
  });
  check('PUT definition 恶意 sessionId 被拒绝(400)',
    putDef.status === 400,
    `status=${putDef.status}`);
  const putAnalysis = await fetch(`${base}/api/meeting-board/analysis?sessionId=${evilId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'x' }),
  });
  check('PUT analysis 恶意 sessionId 被拒绝(400)',
    putAnalysis.status === 400,
    `status=${putAnalysis.status}`);
  // 数据目录外不能出现逃逸文件（即使 writeSessionDoc 内部吞掉错误也不许落盘）
  const escapePath = join(dataDir, 'rtc-security-escape.md');
  let escaped = false;
  try { await readFile(escapePath); escaped = true; } catch { /* 不存在 = 正确 */ }
  check('数据目录外没有产生逃逸文件', !escaped, escapePath);

  // 合法 sessionId 照常工作（不因加闸而坏掉正常链路）
  const okId = `rtc-meeting-${Math.floor(Date.now() / 1000)}`;
  await mkdir(join(dataDir, 'sessions'), { recursive: true });
  const putOk = await fetch(`${base}/api/meeting-board/document?sessionId=${okId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ document: '# 正常会议\n' }),
  });
  const okJson = await putOk.json().catch(() => ({}));
  check('合法 sessionId 保存成功', putOk.ok && okJson.ok === true, `status=${putOk.status}`);
  const meetingsDir = join(dataDir, 'meetings');
  let mdWritten = false;
  try {
    const files = await readdir(meetingsDir);
    mdWritten = files.includes(`${okId}.md`);
  } catch { /* 目录没建 = 没写 */ }
  check('合法 sessionId 落了 .md 文件', mdWritten, meetingsDir);

  // ---- 2. 白名单函数行为（源码断言钉住关键判断） ----
  const serverSrc = await readFile(join(root, 'server.js'), 'utf-8');
  check('WS 升级阶段有 Origin 校验',
    /server\.on\('upgrade'[\s\S]{0,400}isAllowedOrigin\(request\.headers\.origin\)/.test(serverSrc),
    'server.on(upgrade) 里必须调 isAllowedOrigin（升级阶段拦截，connection 里 close 已太晚）');
  check('WS 用 noServer + handleUpgrade 模式',
    /new WebSocket\.Server\(\{ noServer: true \}\)/.test(serverSrc) && /wss\.handleUpgrade/.test(serverSrc),
    '挂在 server 上的默认模式无法在升级阶段拒绝');
  check('bailian 上游有白名单校验',
    /isAllowedUpstreamUrl\(upstreamUrl\)/.test(serverSrc),
    'connectMsg.url 必须过 isAllowedUpstreamUrl');
  check('上游白名单只放行 dashscope wss 端点',
    /dashscope\.aliyuncs\.com/.test(serverSrc) && /protocol !== 'wss:'/.test(serverSrc),
    "白名单必须是 wss: + dashscope.aliyuncs.com");
  check('上游错误不再回传 err.message',
    !/message: `\$\{isLocal \? '本地ASR' : '百炼'\}错误: \$\{err\.message\}`/.test(serverSrc),
    '错误回传改固定文案');

  // ---- 3. WS Origin 实连验证（起真连接试被拒） ----
  const { WebSocket: WsClient } = await import('ws');
  const wsRejected = await new Promise((resolve) => {
    const client = new WsClient(`ws://127.0.0.1:${port}`, {
      headers: { Origin: 'http://evil.example.com' },
    });
    const done = (result) => { try { client.close(); } catch {} resolve(result); };
    client.on('unexpected-response', (_req, res) => done(res.statusCode === 408 || res.statusCode === 403 || res.statusCode < 500));
    client.on('error', (e) => done(String(e.message).length > 0));
    client.on('open', () => done(false)); // 连上了 = 闸没生效
    setTimeout(() => done(false), 3000);
  });
  check('不可信 Origin 的 WS 握手被拒绝', wsRejected === true, '跨站 Origin 必须握手失败');

  const wsAllowed = await new Promise((resolve) => {
    const client = new WsClient(`ws://127.0.0.1:${port}`);
    const done = (result) => { try { client.close(); } catch {} resolve(result); };
    client.on('open', () => done(true));
    client.on('error', () => done(false));
    setTimeout(() => done(false), 3000);
  });
  check('无 Origin 的本地 WS 客户端照常连上', wsAllowed === true, '非浏览器客户端不能被误伤');
} finally {
  if (rtc) rtc.kill();
  await rm(dataDir, { recursive: true, force: true }).catch(() => {});
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.error('失败项:', failures.join(' / '));
  process.exit(1);
}
