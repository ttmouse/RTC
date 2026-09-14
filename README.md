# RTC

实时语音转文字工具，支持**本地 SenseVoice 引擎**（完全离线）和**阿里云百炼 ASR**。可作为网页运行，也可打包为 macOS 桌面应用（Tauri）。

## 功能

- **实时语音识别** — 本地 SenseVoice 引擎（离线）或阿里云百炼 ASR
- **打字机效果** — 实时显示识别中的文字，带闪烁光标
- **自动粘贴** — 识别结果自动复制到剪贴板，并可自动粘贴到光标位置（需辅助功能权限）
- **噪音过滤** — 自动丢弃短文本/英文噪音
- **历史记录** — 所有识别结果自动保存在浏览器本地（localStorage）
- **时间筛选** — 按 30分钟/1小时/3小时/12小时/今天 查看历史
- **纸张质感 UI** — 纸墨风格设计

## 快速开始

### 方式一：浏览器（推荐，快速体验）

```bash
# 1. 安装依赖
npm install

# 2. 构建前端
npm run build

# 3. 启动服务（提供 WebSocket 代理 + HTTP 粘贴端点）
node server.js

# 3. 浏览器打开 http://localhost:8931
```

### 方式二：Tauri 桌面应用

```bash
# 1. 安装 Rust（如未安装）
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# 2. 构建前端并编译桌面应用
cd src-tauri
cargo tauri build

# 3. 产物在 src-tauri/target/release/bundle/ 下
```

### 方式三：开发模式（热更新，默认桌面端 APP）

```bash
# 1. 启动桌面端开发（Tauri 窗口 + 热更新，首次需编译 1-3 分钟）
npm run dev

# 2. 只想在浏览器里快速调 UI 时
npm run dev:web   → 浏览器打开 http://localhost:8931
```

- **改 src/ 下任何文件，保存即自动刷新**（CSS / HTML / JS 都支持，桌面窗口和浏览器都生效）
- 想顺手看等宽字体效果、调样式、改 UI，先 `npm run dev:web` 在浏览器里调，再 `npm run dev` 看桌面效果
- 开发前请**退出已安装的 RTC APP**（它的内置服务占用 8931 端口，会与开发服务冲突）
- 注意：改 `server.js` 等后端代码不会自动重启，需 Ctrl+C 重跑

## 安装本地 SenseVoice 模型

本地引擎使用 [SenseVoice](https://github.com/modelscope/FunASR) 模型（sherpa-onnx 封装）。模型文件**外置，不入库**，需自行下载：

```bash
# 1. 进入本地 ASR 目录
cd asr_local

# 2. 创建模型目录
mkdir -p official_sensevoice

# 3. 下载模型文件（约 60MB，3 个文件）
#   model.int8.onnx
#   tokens.txt
curl -L -o official_sensevoice/model.int8.onnx \
  "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/model.int8.onnx"

curl -L -o official_sensevoice/tokens.txt \
  "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/tokens.txt"
```

**Python 依赖：**

```bash
pip install sherpa-onnx numpy websockets
```

> 注意：sherpa-onnx 需要 Python 3.8+。模型文件约 60MB，首次加载约 2-3 秒。

## 配置

| 参数 | 默认值 | 说明 |
|------|--------|------|
| 静音超时 | 2000ms | 说话停顿超过此值，自动分段换行 |
| VAD 灵敏度 | 0.006 | 能量检测阈值，越低越敏感 |
| 麦克风增益 | 1x | 麦克风信号放大倍数 |
| 噪音过滤 | 开启 | 自动丢弃短文本/英文噪音 |
| 自动粘贴 | 关闭 | 识别结果自动粘贴到光标位置 |

## 换行逻辑说明

文本换行由**服务端 VAD（语音活动检测）**控制，而非前端。核心规则：

- 说话中停顿超过**静音超时值**（默认 2000ms）→ 自动分段换行
- 连续说话超过 **30 秒** → 强制分段
- 断句不足 **800ms** → 丢弃（防误触发）

如果感觉换行太频繁，请调高「静音超时」或降低「VAD 灵敏度」；如果换行太慢，请调低「静音超时」。

## 技术栈

- **前端**：原生 HTML / CSS / JavaScript，CSS 外置 + ES Modules
- **语音引擎**：SenseVoice (sherpa-onnx)，完全离线运行
- **桌面端**：Tauri v2（Rust + macOS .app 打包）
- **持久化**：localStorage + 本地 JSON 文件

## 目录结构

```text
src/index.html        # HTML 骨架与 module entry
src/css/style.css     # 全部样式
src/js/                # 前端 ES 模块
  main.js             # 事件绑定与启动入口
  api.js              # 后端地址的唯一来源（HTTP/WS 都从这里取，别各处硬编码端口）
  state.js            # 共享状态
  ui.js               # DOM/UI 工具
  history.js          # 历史存储与渲染
  correction.js       # 纠错规则
  clipboard.js        # 剪贴板与粘贴
  asr.js              # ASR 连接与结果处理
  audio.js            # 录音管道
  settings.js         # 设置持久化与状态同步
server.js             # Node 后端（HTTP + WebSocket 代理）
asr_local/server.py   # 本地 ASR 引擎服务（SenseVoice / Qwen3，含 8933 模型管理 HTTP）
scripts/              # 启动、模型、打包与检查脚本
  check-static.mjs    # npm test 的全部内容（语法 / 导入 / 资源 / JSON）
  dev.mjs             # npm run dev:web：热更新开发服务器
  build-sidecar.sh    # 重新编译 Tauri 打包用的 node-server / asr-server 二进制
docs/                 # 文档中心（索引见 docs/README.md）
  README.md           # 文档索引：改代码前先读这里
  product-rules/      # 产品原则与界面交互约束（刻意为之、不能顺手改的部分）
  product-direction/  # 行业研究 + 创新清单
src-tauri/            # Tauri 桌面端
dist/                 # 构建产物（不入库）
```

## 打包桌面版（sidecar 二进制）

`src-tauri/binaries/` 下的两个 sidecar（`node-server` / `asr-server`）**不入库**（单个数十 MB 到数百 MB），
但 `tauri.conf.json` 的 `bundle.externalBin` 依赖它们，缺了就无法打包：

```bash
npm run build:sidecar   # 需要 bun（编译 server.js）+ pyinstaller（打包 asr_local/server.py）
```

**改了 `server.js` 或 `asr_local/server.py` 后必须重新执行这一步**，否则打进 App 的仍是旧后端
（曾出现「仓库里的 server.js 已经加了 /api/status，但 App 里那个二进制还是老的、接口返回 404」）。

## 许可

MIT