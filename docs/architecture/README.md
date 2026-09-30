# RTC 系统架构

> Status: authoritative
> Owner: RTC maintainer
> Applies when: 修改进程边界、端口、数据路径、前后端职责、会议白板加载方式或外部工具接口。

## 当前边界

```text
Tauri 桌面壳
  ├─ 主界面：src/（原生 HTML/CSS/ES Modules）
  ├─ 会议白板窗口：meeting-board/ 构建后由 Node 服务提供
  └─ macOS 原生能力：src-tauri/（窗口、前台应用、粘贴、菜单栏、进程托管）
            │
            ▼
Node 本地服务 server.js（127.0.0.1:8931）
  ├─ 静态页面与本地 HTTP API
  ├─ ASR WebSocket 代理与引擎分流
  ├─ 配置、指令、转写和会议白板的文件读写
  └─ OpenAI 兼容 LLM 代理
            │
            ▼
本地 ASR asr_local/server.py
  ├─ 识别 WebSocket（正式 SenseVoice 默认 8932）
  └─ 模型管理 HTTP（默认 8933）

外部 Agent / 脚本 ── scripts/rtc.mjs 与 scripts/meeting-board.mjs ──► 同一本地数据与 API 边界
```

## 不变量

- 8931 的 Node 服务是页面、API 和 ASR 代理的统一入口；前端不应各自发明另一套服务地址。
- 本地识别可用性同时依赖代理与模型服务，界面状态必须反映真实链路，不能只检查页面是否打开。
- 用户数据默认位于本机应用数据目录；测试必须通过隔离的 `RTC_DATA_DIR`，不得写真实转写、配置或白板。
- 转写原文与 AI 生成内容是不同数据层。AI 失败或变慢不能阻塞转写保存。
- 会议白板窗口读取构建后的 `dist/meeting-board`；源码变化需要重新构建并重开窗口才代表新版本。
- `scripts/rtc.mjs` 是外部自动化的稳定入口；不要要求外部工具复制服务端内部实现。
- 本地服务的存活跟随 **App 进程**，不跟随窗口：窗口开开关关不改变 8931/8932 的存活，只有真正退出 App 才停；后端消失由看护线程按「端口是否在听」补起来（[ADR-005](../decisions/ADR-005-service-follows-app-process.md)）。
- Tauri 原生能力通过明确命令暴露；涉及 macOS 权限或文件定位时，不要假设浏览器 API 与桌面壳等价。

## 改动要求

跨越上述边界、改变数据所有权或引入新常驻进程时，先在 [决策记录](../decisions/README.md) 写 ADR。端口或数据路径变化必须同步根 README、相关运行手册和测试。验证至少覆盖静态检查、隔离数据下的运行路径，以及桌面端真实行为；浏览器验证不能替代 Tauri/WKWebView 验收。

## 相关入口

- [产品原则](../product-rules/core-product-principles.md)
- [会议白板外部 AI 边界](../product-direction/meeting-board-external-ai-first.md)
- [运行手册](../runbooks/README.md)
