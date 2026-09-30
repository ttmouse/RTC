// 本地服务（8931 后端 / 8932 识别）的生命周期守卫。
//
// 症状（2026-09-30 实测）：看完会议白板、顺手关掉那个独立小窗口，主界面立刻变成
// 「无法连接到本地代理服务 ws://127.0.0.1:8931」，之后 11 分钟一个字都没记进去。
// 原因不是白板本身，而是 Tauri 侧「任何窗口被关掉 → 无条件停掉全局 sidecar」；
// 而后端没有任何看护，停了就只能退出重开 App。
//
// 这条守卫盯的是源码里的三条不变量。它读的是文本，不是运行中的进程——所以它只能
// 证明「伤害性的写法不在代码里」，证明不了「关窗口之后 8931 一定还在」；后者要在
// 桌面端实测（见 docs/product-rules/ux-issue-log.md 的 UX-10 守门检查那一栏）。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lib = fs.readFileSync(path.join(root, 'src-tauri/src/lib.rs'), 'utf8');

// 1) 窗口关闭事件里不许再停全局服务。
//    会议白板是独立窗口（label = meeting-board），它被关掉只是收起一块面板，
//    不能连带端掉整个后端和本地识别。
const closeBlock = lib.match(/WindowEvent::CloseRequested[\s\S]{0,1500}?\n {12}\}/);
assert.ok(closeBlock, '在 lib.rs 里找不到 CloseRequested 的处理块');
assert.ok(
  !/cleanup_server/.test(closeBlock[0]),
  '窗口关闭不该停全局 sidecar：白板窗口被关掉会把 8931 后端一起带走（2026-09-30 实测）',
);
assert.match(
  closeBlock[0],
  /persist_window_state/,
  '窗口关闭仍应保存窗口尺寸，别把这条一起删了',
);

// 2) 真正的退出路径（⌘Q / 关主窗口 → ExitRequested）必须既杀进程、又给看护立牌子。
//    少了牌子，看护会在几秒内把刚杀掉的 service 又拉起来，App 退出了端口却还占着。
const exitBlock = lib.match(/fn cleanup_all_servers[\s\S]{0,600}?\n\}/);
assert.ok(exitBlock, '在 lib.rs 里找不到 cleanup_all_servers');
assert.match(exitBlock[0], /shutting_down\.store\(true/, '退出时必须先立 shutting_down，否则看护会把服务再拉起来');

// 3) 后端要有看护：8931 没了就补，且判据是端口而不是子进程句柄。
assert.match(lib, /fn spawn_node_watchdog/, '缺少后端看护线程：sidecar 一死就再也没人管');
assert.match(
  lib,
  /spawn_node_watchdog\(handle\.clone\(\)\)/,
  '看护线程必须在 setup 里真正启动，光定义不调用等于没写',
);
assert.match(
  lib.match(/fn spawn_node_watchdog[\s\S]{0,2500}?\n\}/)?.[0] || '',
  /port_open\(NODE_PORT\)/,
  '看护的判据应是 8931 端口而不是子进程句柄：这样被外部清进程也能补回来',
);

// 4) sidecar 的输出要落盘。
//    打包后的 .app 从访达启动没有 stderr，2026-09-30 那次后端无声退出时系统里
//    没有 crash report、没有信号记录、连一句遗言都没留下，只能靠推断死因。
assert.match(lib, /fn open_sidecar_log/, '缺少 sidecar 磁盘日志：下次死了还是查不出原因');
assert.match(lib, /open_sidecar_log\(app_handle, "node-sidecar"\)/, '后端 sidecar 的输出没有写盘');
assert.match(lib, /open_sidecar_log\(&handle, "asr-sidecar"\)/, '识别 sidecar 的输出没有写盘');

console.log('sidecar lifecycle guard tests passed');
