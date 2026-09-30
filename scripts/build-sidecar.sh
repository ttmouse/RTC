#!/usr/bin/env bash
#
# 重新构建 Tauri 打包用的两个 sidecar 二进制。
#
# 为什么需要这个脚本：src-tauri/binaries/ 被 .gitignore 排除（单个 60~450MB），
# 而 tauri.conf.json 的 bundle.externalBin 又强依赖这两个文件。也就是说新克隆的仓库
# 直接 `cargo tauri build` 必然失败，且此前没有任何文档或脚本说明它们从哪来。
# 更糟的是旧二进制会静默过期：实测仓库里 2026-09-10 编译的 node-server 里跑的还是
# 当时的 server.js（/api/status 返回 404、CORS 仍是 `*`），改完 server.js 不重建，
# 打包出来的 App 用的就是老后端。
#
# 用法：npm run build:sidecar
#
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"
OUT="$ROOT/src-tauri/binaries"
TRIPLE="$(rustc -vV | awk '/^host:/ {print $2}')"

if [ -z "$TRIPLE" ]; then
  echo "[sidecar] 无法确定 Rust 目标三元组（rustc 不可用？）" >&2
  exit 1
fi

mkdir -p "$OUT"

echo "[sidecar] 目标三元组: $TRIPLE"

# ── 1) node-server：bun 运行时本体 + 单文件 JS（**不要**用 bun --compile）──
#
# 为什么不用 `bun build --compile`（2026-09-20 实测）：它的产物只有 ld 的
# linker 签名、没有 CMS blob，macOS 26+ 的 AMFI 在加载时直接
#   AMFI: has no CMS blob?  →  Unrecoverable CT signature issue  →  SIGKILL
# 于是打包后的 App 后端（8931）永远起不来，界面只能显示「服务未连接」、历史记录空白。
# 且该产物 codesign 也救不回来：`--force --sign -` 报 "main executable failed strict
# validation"，`--remove-signature` 报 "internal error in Code Signing subsystem"。
#
# 改成「官方 bun 二进制（有 Apple 公证的 Team 签名，能跑） + 一个 bundle 出来的 JS」：
# 依赖（ws）在 JS 里已经打平，体积与原来 --compile 产物相同（~63MB）。
# 运行时由 src-tauri/src/lib.rs 的 start_node_server 把 JS 路径作为参数传进来。
# 配套：tauri.conf.json 的 bundle.resources 必须带上 server.bundle.js。
NODE_OUT="$OUT/node-server-$TRIPLE"
BUNDLE_OUT="$OUT/server.bundle.js"
if ! command -v bun >/dev/null 2>&1; then
  echo "[sidecar] 缺少 bun（https://bun.sh），无法构建 node-server" >&2
  exit 1
fi
echo "[sidecar] 构建 server.bundle.js → $(basename "$BUNDLE_OUT")"
bun build --target=bun "$ROOT/server.js" --outfile "$BUNDLE_OUT"

echo "[sidecar] 拷贝 bun 运行时 → $(basename "$NODE_OUT")"
cp "$(command -v bun)" "$NODE_OUT"
chmod +x "$NODE_OUT"
# 去掉下载/拷贝带来的扩展属性，避免装进 .app 后被 Gatekeeper 拿 quarantine 说事
xattr -c "$NODE_OUT" 2>/dev/null || true

# ── 2) asr-server：把 asr_local/server.py 打成独立可执行文件 ──
ASR_OUT="$OUT/asr-server-$TRIPLE"
if ! command -v pyinstaller >/dev/null 2>&1; then
  echo "[sidecar] 缺少 pyinstaller（pip install pyinstaller），无法构建 asr-server" >&2
  exit 1
fi
echo "[sidecar] 构建 asr-server → $(basename "$ASR_OUT")"
# 模型（official_sensevoice/）是外置资源，不打进二进制，运行时从 app 资源目录读取。
#
# --collect-all 这三个包是必须的，不是保险：server.py 用
# `_try_import()` → `__import__(name)` **动态导入** numpy / sherpa_onnx / websockets，
# PyInstaller 的静态分析看不到这种调用，只会打进去一个纯标准库的空壳（实测产物 9.3MB，
# 对照：静态 import 同一个环境打出来的探针是 32MB）。产物能启动、进程活着，但
# 一个端口都不绑、零输出——看起来像「卡住」，实际是依赖根本没进去。
# 这不是可选优化，漏了它打包版的本地识别就是死的。
#
# PYINSTALLER_CONFIG_DIR 指向仓库内：PyInstaller 默认把 bootstrap/bincache 放在
# ~/Library/Application Support/pyinstaller，`--clean` 会去 rmtree 它；在受限沙箱或
# 权限不干净的环境里这一步直接 PermissionError 失败（实测踩到），而且它清的是全局缓存，
# 会连带影响机器上其它 PyInstaller 项目。放进 build 目录既不受限也互不干扰。
PYINSTALLER_CONFIG_DIR="$ROOT/src-tauri/target/pyinstaller-config" \
pyinstaller \
  --onefile \
  --clean \
  --noconfirm \
  --name "$(basename "$ASR_OUT")" \
  --collect-all numpy \
  --collect-all sherpa_onnx \
  --collect-all websockets \
  --hidden-import numpy \
  --hidden-import sherpa_onnx \
  --hidden-import websockets \
  --distpath "$OUT" \
  --workpath "$ROOT/src-tauri/target/pyinstaller" \
  --specpath "$ROOT/src-tauri/target/pyinstaller" \
  "$ROOT/asr_local/server.py"

# 自检：node-server 的签名必须是有效的（无效签名 = 打包后一启动就被系统打死）。
if ! codesign -v "$NODE_OUT" 2>/dev/null; then
  echo "[sidecar] 警告：$(basename "$NODE_OUT") 代码签名无效，打包后的 App 可能起不来后端" >&2
  codesign -v "$NODE_OUT" >&2 || true
fi

echo "[sidecar] 完成："
ls -lh "$OUT" | sed 's/^/  /'
