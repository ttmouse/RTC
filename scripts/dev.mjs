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
  // 不带 host 默认绑 '::'（IPv6 双栈），与 server.js 的 listen 姿势一致，才能真实反映可监听性
  srv.listen(p);
});

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
        if (/server\.js|dev\.mjs|rtc|node-serv/.test(cmd)) {
          process.kill(Number(pid), 'SIGTERM');
          console.log(`[dev] 已清理占用端口 ${p} 的旧进程 (pid=${pid} ${cmd.slice(0, 60)})`);
        }
      } catch (_) { /* 进程已退出 */ }
    }
  }
}

// 先清理本项目残留进程，再探测：若仍被其他服务占用则给指引并退出
cleanupPorts();
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
  env: { ...process.env, RTC_DEV: '1', RELOAD_PORT: String(reloadPort) },
  stdio: 'inherit',
});

server.on('exit', (code, sig) => {
  console.log(`[dev] 后端已退出 (${sig || code})`);
  shutdown();
});

const shutdown = () => {
  try { wss.close(); } catch (_) {}
  if (!server.killed) server.kill('SIGTERM');
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);