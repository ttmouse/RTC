#!/usr/bin/env node
/**
 * 开发模式（热更新）：
 *   - 以 RTC_DEV=1 启动 server.js（静态根强制 src/，免 build）
 *   - 监听 src/ 变化，通过 WebSocket 广播 reload，浏览器自动刷新
 *
 * 用法：
 *   npm run dev            → 浏览器打开 http://localhost:8931
 *   npm run tauri dev      → 桌面窗口同样热更新（src-tauri）
 * 可选环境变量：PORT（后端端口，默认 8931）、RELOAD_PORT（广播端口，默认 8935）
 */
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket, { WebSocketServer } from 'ws';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const watchDir = path.join(root, 'src');
const reloadPort = Number(process.env.RELOAD_PORT || 8935);
const port = Number(process.env.PORT || 8931);

// ── 端口清理与检测 ──
const portInUse = (p) => new Promise((resolve) => {
  const srv = net.createServer();
  srv.once('error', () => resolve(true));
  srv.once('listening', () => srv.close(() => resolve(false)));
  // 绑回环，与 server.js 的 `server.listen(PORT, '127.0.0.1')` 口径一致。
  // 原来不带 host（等于绑全网卡）比真实服务更宽：别的进程只占 [::1]:8931 时这里会误报
  // 「端口被占用」并直接 exit(1)，而实际服务是起得来的。
  srv.listen(p, '127.0.0.1');
});

/** 等端口真正释放：SIGTERM 之后 socket 不会立刻消失，紧接着探测会误判成「被别的进程占用」。 */
const waitPortFree = async (p, timeoutMs = 3000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await portInUse(p))) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return !(await portInUse(p));
};

function cleanupPorts() {
  for (const p of [port, reloadPort]) {
    let pids = [];
    try {
      pids = execSync(`lsof -ti:${p} 2>/dev/null || true`, { encoding: 'utf8' })
        .trim().split('\n').filter(Boolean);
    } catch (_) {}
    for (const pid of pids) {
      try {
        const cmd = execSync(`ps -p ${pid} -o command=`, { encoding: 'utf8' }).trim();
        // cmd 为空 = ps 本身失败（被测环境禁止 ps、或进程刚退出）。这种「认不出是谁」的情况
        // 仍然清理：端口就在这里，能占到本开发端口的极可能就是上一轮的自己。
        if (!cmd || /server\.js|dev\.mjs|rtc|node-serv/.test(cmd)) {
          process.kill(Number(pid), 'SIGTERM');
          console.log(`[dev] 已清理占用端口 ${p} 的旧进程 (pid=${pid} ${cmd.slice(0, 60) || '身份未知'})`);
        }
      } catch (_) { /* 进程已退出 */ }
    }
  }
}

// 先清理本项目残留进程，再等端口释放，最后探测：仍被其他服务占用才给指引并退出。
// 顺序很重要：清理后不等就直接探测，等于自己把自己刚 SIGTERM 的进程算成「占用者」。
cleanupPorts();
await Promise.all([waitPortFree(port), waitPortFree(reloadPort)]);
const busy = (await Promise.all([portInUse(port), portInUse(reloadPort)]))
  .map((b, i) => b ? (i === 0 ? port : reloadPort) : null).filter(Boolean);
if (busy.length) {
  console.error(`[dev] 端口 ${busy.join('、')} 仍被占用（非本项目进程，已跳过清理）`);
  console.error(`[dev] 排查：lsof -i :${busy.join(' -i :')}  →  手动结束占用进程后重跑 npm run dev`);
  process.exit(1);
}

console.log(`[dev] 热更新监听 ${watchDir} → ws://localhost:${reloadPort}`);
console.log(`[dev] 后端 http://localhost:${port}（静态根: src/，免 build）`);
console.log('[dev] 改 src/ 下任何文件，保存即自动刷新浏览器');

// ── livereload WebSocket 服务 ──
const wss = new WebSocketServer({ port: reloadPort });
wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('error', () => {});
});
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

let timer = null;
const broadcast = () => {
  if (timer) return; // 防抖合并连续变更
  timer = setTimeout(() => {
    timer = null;
    for (const ws of wss.clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send('reload');
    }
    console.log('[dev] 文件变更，已通知浏览器刷新');
  }, 60);
};

// ── 监听 src/ 变化（Node 20+ macOS/Windows 支持 recursive）──
try {
  fs.watch(watchDir, { recursive: true }, (_evt, filename) => {
    if (filename && (/^\./ .test(filename) || /~$/.test(String(filename)))) return;
    broadcast();
  });
} catch (e) {
  console.warn('[dev] recursive watch 不可用，退回逐目录监听:', e.message);
  for (const dir of ['css', 'js']) {
    fs.watch(path.join(watchDir, dir), (_evt, filename) => {
      if (filename && /~$/.test(String(filename))) return;
      broadcast();
    });
  }
  fs.watch(watchDir, (_evt, filename) => {
    if (filename && /~$/.test(String(filename))) return;
    broadcast();
  });
}

// ── 拉起后端（开发模式）──
const server = spawn('node', ['server.js'], {
  cwd: root,
  // PORT 必须显式传：server.js 只认 PORT，不认 RTC_PORT（后者是 scripts/rtc.mjs 的约定）。
  // 不传的话 `PORT=9000 npm run dev:web` 会出现「热更新服务在 9000、后端仍在 8931」
  // 的错位，页面加载正常但所有接口都打不通。
  env: { ...process.env, PORT: String(port), RTC_DEV: '1', RELOAD_PORT: String(reloadPort) },
  stdio: 'inherit',
});

server.on('exit', (code, sig) => {
  console.log(`[dev] 后端已退出 (${sig || code})`);
  // 把后端的退出码传出去。原来无条件 exit(0)，server.js 因端口占用退出 1（或任何崩溃）时，
  // `npm run dev:web` 依然报成功，tauri.conf.json 的 beforeDevCommand 也看不出问题。
  shutdown(sig ? 1 : (code ?? 1));
});

const shutdown = (exitCode = 0) => {
  try { wss.close(); } catch (_) {}
  if (!server.killed) server.kill('SIGTERM');
  process.exit(exitCode);
};
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));