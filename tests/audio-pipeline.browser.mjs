/**
 * 录音链路的真浏览器巡检：`npm run check:audio`
 *
 * 它回答一个静态检查和纯单测都答不了的问题：**麦克风这条管道真的通吗？断了会自己修吗？
 * 修不好会不会如实说？** tests/audio-recovery.test.mjs 钉的是判断逻辑，这里钉的是把逻辑
 * 装到真浏览器上之后的行为——真 MediaStream、真 WebSocket、真状态机、真看护循环。
 *
 * 三个场景：
 *   1) 音频会话被打断（系统睡眠对 WebAudio 干的就是这件事）→ 必须自动重建并恢复出声，
 *      期间状态区不许掉成别的说法；
 *   2) 重取麦克风也救不回来（麦克风活着，管道就是不出声）→ 必须如实报「没有声音输入」；
 *   3) 取不到麦克风（设备没了）→ 必须报「麦克风不可用」，而不是含糊的「就绪」。
 *
 * 只有两处是假的，都是为了让副作用为零：
 *   - 麦克风：440Hz 振荡器 + MediaStreamDestination，**不碰真实麦克风**；
 *   - ASR 引擎：本地假 WS 服务（说同一套协议），**不连 python、不写任何真实记录**；
 * 数据目录走临时目录（RTC_DATA_DIR），跑完即删。
 *
 * 需要 Playwright（和 check:ux 一样，不在仓库依赖里）。装不上时退出码 2（= 没跑成，不是通过）。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  console.error('这个巡检需要 Playwright，但当前解析不到它。');
  console.error('装一个即可：npm i -D playwright && npx playwright install chromium');
  process.exit(2);
}
const { WebSocketServer } = require('ws');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((resolve) => {
  const srv = net.createServer();
  srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
});
async function waitFor(desc, cond, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await cond()) return true;
    await wait(200);
  }
  throw new Error(`超时：${desc}`);
}

const results = [];
const record = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? ` — ${detail}` : ''}`);
};

// ── 假 ASR：只说协议、只数音频字节，不落到任何真实记录里 ──
let audioBytes = 0;
let audioFrames = 0;
const asrPort = await freePort();
const asr = new WebSocketServer({ port: asrPort });
asr.on('connection', (ws) => {
  ws.on('message', (data, isBinary) => {
    if (isBinary) { audioBytes += data.length; audioFrames += 1; return; }
    let msg = {};
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (msg.type === 'connect') {
      ws.send(JSON.stringify({ type: 'connected' }));
    } else if (msg.header && msg.header.action === 'run-task') {
      ws.send(JSON.stringify({ header: { event: 'task-started', task_id: msg.header.task_id }, payload: {} }));
    }
  });
});

// ── 夹具服务：RTC_DEV 直接服务 src/，数据目录指向临时目录 ──
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rtc-audio-check-'));
fs.mkdirSync(path.join(dataDir, 'events'), { recursive: true });
const appPort = await freePort();
const server = spawn(process.execPath, [path.join(root, 'server.js')], {
  cwd: root,
  env: {
    ...process.env,
    PORT: String(appPort),
    RTC_DEV: '1',
    RTC_DATA_DIR: dataDir,
    LOCAL_ASR_URL: `ws://127.0.0.1:${asrPort}`,
  },
  stdio: ['ignore', 'ignore', 'ignore'],
});
const base = `http://127.0.0.1:${appPort}`;
await waitFor('夹具服务起来', async () => {
  try { return (await fetch(`${base}/api/status`)).ok; } catch { return false; }
});

const browser = await chromium.launch();
const page = await browser.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  const text = m.text();
  // dev 模式的页面里带一个热更新探针（连 8935 的 reload 频道）。夹具服务不跑 dev.mjs，
  // 于是它每几秒往控制台丢一条 ERR_CONNECTION_REFUSED——那是夹具自己的噪声，
  // 不是被测录音管道的问题。
  if (text.includes(':8935')) return;
  pageErrors.push('console: ' + text);
});

await page.addInitScript(() => {
  // 页面里创建过的每个音频上下文：测试靠「把它们全关掉」来模拟睡眠对音频会话干的事
  window.__appCtxs = [];
  window.__micCalls = 0;
  window.__micFails = false;    // true = getUserMedia 直接拒绝（设备真的没了）
  window.__keepKilling = false; // true = 持续掐掉音频会话（麦克风活着，管道永远不出声）
  window.__rejections = [];
  window.addEventListener('unhandledrejection', (ev) => {
    window.__rejections.push(String((ev.reason && ev.reason.stack) || ev.reason));
  });

  const OrigAC = window.AudioContext || window.webkitAudioContext;
  window.__OrigAC = OrigAC;
  window.AudioContext = class extends OrigAC {
    constructor(...args) { super(...args); window.__appCtxs.push(this); }
  };

  const md = navigator.mediaDevices || (navigator.mediaDevices = {});
  md.getUserMedia = async () => {
    window.__micCalls += 1;
    if (window.__micFails) throw new Error('模拟：设备消失了');
    const ctx = new window.__OrigAC();
    await ctx.resume().catch(() => {});
    const osc = ctx.createOscillator();
    osc.frequency.value = 440;
    const dest = ctx.createMediaStreamDestination();
    osc.connect(dest);
    osc.start();
    return dest.stream;
  };

  setInterval(() => {
    if (!window.__keepKilling) return;
    window.__appCtxs.forEach((c) => { Promise.resolve(c.close()).catch(() => {}); });
  }, 150);
});

const statusText = () => page.textContent('#statusText');
const statusDot = () => page.getAttribute('#dot', 'class');
const killAudioSession = () => page.evaluate(
  () => window.__appCtxs.forEach((c) => { Promise.resolve(c.close()).catch(() => {}); }),
);

/** 打开主界面并开始录音（先等应用自己的启动序列走完：它在末尾会点一次录音按钮） */
async function startRecording() {
  await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
  await waitFor('主界面进入「就绪」', async () => (await statusText()) === '就绪');
  await wait(2500);
  if ((await statusText()) !== '识别中') await page.click('#btn');
  await waitFor('进入「识别中」', async () => (await statusText()) === '识别中');
}

try {
  // ── 场景一：音频会话被打断 → 必须自愈 ──
  await startRecording();
  record('主界面能正常起来、录音能进「识别中」', true);
  const before = audioBytes;
  await waitFor('音频真的发到 ASR', async () => audioBytes > before + 4096, 10000);
  record('录音管道通：音频确实在往外发', true, `${audioFrames} 帧 / ${audioBytes} 字节`);

  const ctxBefore = await page.evaluate(() => window.__appCtxs.length);
  const bytesBeforeKill = audioBytes;
  await killAudioSession();
  await waitFor('自动重建音频输入', async () => (await page.evaluate(() => window.__appCtxs.length)) > ctxBefore, 8000);
  await waitFor('重建后音频重新流动', async () => audioBytes > bytesBeforeKill + 4096, 15000);
  record('音频会话被打断 → 自动重建并恢复出声，状态仍是「识别中」',
    (await statusText()) === '识别中', `状态=${await statusText()}`);
  record('自愈过程没有未捕获错误', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));

  // ── 场景二：重取流也救不回来 → 必须如实说 ──
  pageErrors.length = 0;
  await page.evaluate(() => { window.__keepKilling = true; });
  await killAudioSession();
  await waitFor('状态区如实报「没有声音输入」', async () => (await statusText()) === '没有声音输入', 15000);
  record('重取流也救不回来 → 说「没有声音输入」，不再写「识别中」', true);
  record('该状态是告警色（err）', String(await statusDot()).includes('err'), `dot=${await statusDot()}`);
  record('期间确实重取过麦克风（真的试过自救）', (await page.evaluate(() => window.__micCalls)) >= 2,
    `麦克风调用 ${await page.evaluate(() => window.__micCalls)} 次`);
  record('如实告知时不抛未捕获错误', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));

  // ── 场景三：设备真的没了 → 说「麦克风不可用」──
  pageErrors.length = 0;
  await page.evaluate(() => { window.__keepKilling = false; window.__micFails = true; });
  await page.click('#btn');   // 停录
  await page.click('#btn');   // 再开录 → 取不到麦克风
  await waitFor('状态区报「麦克风不可用」', async () => (await statusText()) === '麦克风不可用', 10000);
  record('取不到麦克风时说「麦克风不可用」，而不是含糊的「就绪」', true);
} catch (e) {
  record('巡检跑完', false, e.message);
} finally {
  await browser.close().catch(() => {});
  asr.close();
  server.kill('SIGTERM');
  fs.rmSync(dataDir, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
