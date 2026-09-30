#!/usr/bin/env node
/**
 * 打包前检查：sidecar 是不是比源码旧。
 *
 * 为什么需要它：一次打包里有五个独立产物（前端 dist/、server.bundle.js、两个 sidecar、
 * Rust 二进制）。没重建的那个不会报错，只会让打包版的**行为**和源码不一致——
 * 2026-09-20 就出过一次：打包用的 asr-server 是 09-15 编译的，不认识 09-20 才加的
 * 「按住说话」协议，表现成「手没松就自己收尾」；而 dev 模式跑的是仓库源码，一切正常。
 * 两个小时的排查量，一条时间戳比对就能提前拦下（见 UX-16）。
 *
 * 判据：产物 mtime 必须不早于源文件。缺失只警告——那是还没构建 sidecar 的机器，
 * 前端构建本身仍然可以跑（真正打包时 tauri 会因为 externalBin 缺失自己报错）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binDir = path.join(root, 'src-tauri', 'binaries');

/** 产物与它对应的源文件；glob 只支持前缀通配，够用。 */
const GROUPS = [
  { label: 'node sidecar（bun 运行时）', prefix: 'node-server-', sources: ['server.js'] },
  { label: 'node 后端脚本', prefix: 'server.bundle.js', sources: ['server.js'] },
  { label: 'asr sidecar（本地识别服务）', prefix: 'asr-server-', sources: ['asr_local/server.py'] },
];

function mtime(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

/** 源目录里所有文件的最近修改时间（server.py 之外还有同族模块时也算进来）。 */
function newestSourceTime(relPaths) {
  let newest = 0;
  let newestFile = null;
  for (const rel of relPaths) {
    const abs = path.join(root, rel);
    const stat = fs.existsSync(abs) ? fs.statSync(abs) : null;
    if (stat && stat.isDirectory()) {
      for (const entry of fs.readdirSync(abs, { recursive: true })) {
        const file = path.join(abs, entry);
        const t = mtime(file);
        if (t && t > newest) {
          newest = t;
          newestFile = path.relative(root, file);
        }
      }
    } else {
      const t = mtime(abs);
      if (t && t > newest) {
        newest = t;
        newestFile = rel;
      }
    }
  }
  return { time: newest, file: newestFile };
}

function artifactsWithPrefix(prefix) {
  if (!fs.existsSync(binDir)) return [];
  return fs
    .readdirSync(binDir)
    .filter(name => (prefix.endsWith('.js') ? name === prefix : name.startsWith(prefix)))
    .map(name => path.join(binDir, name));
}

// 1 秒容差：构建脚本里 copy 与源文件写入通常在同一秒内，别为亚秒差误报。
const TOLERANCE_MS = 1000;

const problems = [];
const missing = [];

for (const group of GROUPS) {
  const artifacts = artifactsWithPrefix(group.prefix);
  if (artifacts.length === 0) {
    missing.push(group.label);
    continue;
  }
  const { time: sourceTime, file: sourceFile } = newestSourceTime(group.sources);
  if (!sourceTime) continue; // 源文件不在（裁剪过的仓库），不猜
  for (const artifact of artifacts) {
    const artifactTime = mtime(artifact);
    if (artifactTime + TOLERANCE_MS < sourceTime) {
      problems.push({
        artifact: path.relative(root, artifact),
        source: sourceFile,
        artifactTime: new Date(artifactTime).toISOString(),
        sourceTime: new Date(sourceTime).toISOString(),
      });
    }
  }
}

if (problems.length > 0) {
  console.error('\n[check-sidecar] 打包会被拦下：sidecar 比源码旧，打出来的 App 会用老后端/老识别服务。\n');
  for (const p of problems) {
    console.error(`  ✗ ${p.artifact}`);
    console.error(`      产物时间 ${p.artifactTime}  <  源文件时间 ${p.sourceTime}（${p.source}）`);
  }
  console.error('\n  先重建：npm run build:sidecar\n');
  process.exit(1);
}

if (missing.length > 0) {
  console.log(`[check-sidecar] 未构建：${missing.join('、')}（打包前需要 npm run build:sidecar）`);
} else {
  console.log('[check-sidecar] sidecar 与源文件同步');
}
