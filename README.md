# RTC

实时语音转文字工具，支持**本地 SenseVoice 引擎**（完全离线）和**阿里云百炼 ASR**。可作为网页运行，也可打包为 macOS 桌面应用（Tauri）。

## 功能

### 🎤 语音识别

- **双引擎** — 本地 SenseVoice 引擎（完全离线，sherpa-onnx）+ 阿里云百炼 ASR
- **打字机效果** — 实时显示识别中的文字，带闪烁光标
- **智能分段** — VAD 语音活动检测自动分段换行，支持静音超时 / 灵敏度可调
- **噪音过滤** — 自动丢弃短文本/英文噪音
- **电平条** — 音频电平 dB 刻度实时显示，精准判断麦克风状态

### 🎮 语音指令

- **整页管理界面** — 独立编辑页，增删改查语音指令
- **三类指令**：
  - **别名** — 说「打开微信」→ 自动切换到 WeChat
  - **动作** — 说「换行」「发送」→ 模拟按键
  - **快捷短语** — 说「我的邮箱」→ 自动粘贴出邮箱地址
- **多说法支持** — 同一指令支持多个说法，用 `|` 分隔（或关系）
- **应用级聚合** — 同一应用的说法合并显示成一行，清爽简洁

### ⌨️ 按键自定义

- **任意键录制** — 每个指令可绑定任意键盘按键或组合键（Cmd+Shift+F 等）
- **直接按键录制** — 点击「录键」后按下目标键，自动捕获
- **功能块区分** — 按键和功能两类动作分块展示，不混淆

### 📋 自动粘贴

- **一键粘贴** — 识别结果自动复制到剪贴板，并可自动粘贴到光标位置（需辅助功能权限）
- **来源记录** — 粘贴时自动记录「发给了哪个软件」，历史可追溯
- **自动发送** — 按前台应用自动按回车发送（可配置应用白名单，避免误发送到编辑器）
- **提示音反馈** — 自动粘贴成功播放提示音，确认已送达

### 🎨 界面

- **纸张质感 UI** — 纸墨风格设计，按钮带脉冲动画反馈
- **底栏状态** — 识别状态 + 电平条 + 自动发送开关，靠近操作结果
- **脉冲反馈** — 开关切换/操作确认使用脉冲动画，状态一目了然

### 📜 历史记录

- **本地持久化** — 所有识别结果保存在本地 JSON 文件
- **时间筛选** — 按 30分钟 / 1小时 / 3小时 / 12小时 / 今天 查看
- **搜索过滤** — 按关键词搜索历史记录

### 🤖 AI 接入

- **多服务商预设** — 内置 OpenAI / DeepSeek / Kimi / 智谱 GLM / 硅基流动 / OpenCode Zen Go / Ollama（本地）等
- **CLI 对话** — `rtc llm chat` 通过已配置服务商直接与 LLM 对话
- **配置测试** — `rtc config test-llm` 一键验证连通性
- **OpenCode 网关** — 自动注入 `x-opencode-session` 请求头，零配置接入

### 🖥️ CLI 命令行入口

```bash
rtc status                 # 服务状态
rtc transcript --minutes 10  # 查最近 10 分钟转写
rtc config get settings.ai.baseUrl  # 读配置
rtc config set k=v k2=v2   # 写配置
rtc llm chat "问题"         # 调用 AI 服务商对话
rtc act paste "文本"        # 粘贴文本到光标
rtc act open "微信"         # 激活指定应用
rtc commands list           # 查看指令映射
```

支持环境变量 `RTC_DATA_DIR` 覆盖数据目录、`RTC_PORT` 覆盖端口。

## 快速开始

### 方式一：浏览器（推荐，快速体验）

```bash
# 1. 安装依赖
npm install

# 2. 构建前端
npm run build

# 3. 启动服务（提供 WebSocket 代理 + HTTP API）
node server.js

# 4. 浏览器打开 http://localhost:8931
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

- **前端**：原生 HTML / CSS / JavaScript，CSS 外置 + ES Modules，纸墨风格设计
- **语音引擎**：SenseVoice (sherpa-onnx)，完全离线运行；可选阿里云百炼 ASR
- **桌面端**：Tauri v2（Rust + macOS .app 打包），侧载 sidecar 二进制免装依赖
- **持久化**：本地 JSON 文件 + localStorage（兼容）
- **CLI**：Node.js 命令行工具，供外部 AI Agent / 脚本调用
- **AI 集成**：OpenAI 兼容 API，支持多家服务商

## 目录结构

```text
src/                  # 前端源码（ES Modules）
  index.html          # HTML 骨架
  css/style.css       # 全部样式（纸墨风格）
  js/                 # 前端 ES 模块
    main.js           # 事件绑定与启动入口
    api.js            # 后端地址唯一来源（HTTP/WS）
    state.js          # 共享状态
    ui.js             # DOM/UI 工具
    history.js        # 历史存储与渲染
    correction.js     # 纠错规则
    clipboard.js      # 剪贴板与粘贴
    asr.js            # ASR 连接与结果处理
    audio.js          # 录音管道
    settings.js       # 设置面板（AI 服务商、自动发送、引擎配置等）
    commands.js       # 语音指令管理器（别名/动作/快捷短语）
    frontmost.js      # 前台应用检测（Rust 侧 NSWorkspace）
    sfx.js            # 提示音系统
    config-migration.js # 配置文件迁移
server.js             # Node 后端（HTTP + WebSocket 代理 + 配置/指令/LLM API）
asr_local/server.py   # 本地 ASR 引擎服务（SenseVoice / Qwen3）
scripts/              # CLI 工具与开发脚本
  rtc.mjs             # CLI 开放入口（查记录/改配置/调 AI/执行动作）
  transcript.mjs      # 转写记录查询
  dev.mjs             # npm run dev:web 热更新开发服务器
  check-static.mjs    # npm test（语法/导入/资源/JSON检查）
  build-sidecar.sh    # 编译 Tauri sidecar 二进制
docs/                 # 产品文档中心（Agent 可读）
  README.md           # 文档索引
  product-rules/      # 产品原则与界面交互约束
  product-direction/  # 行业研究 + 创新清单
src-tauri/            # Tauri v2 桌面端（Rust）
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