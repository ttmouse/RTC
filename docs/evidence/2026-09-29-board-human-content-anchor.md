# 白板人工内容锚点验证证据

- Date: 2026-09-29
- Revision: feature/push-to-talk 分支工作区（未提交，含本改动）
- Environment: macOS（darwin 27.0.0 arm64）、Node 直跑 server.js（PORT=8951）、隔离 `RTC_DATA_DIR`（mktemp 目录）
- Scope: `scripts/board-provenance.cjs`、server.js 的 `PUT /api/meeting-board/document`、`scripts/meeting-board.mjs` 的 brief / 写回门槛

## 检查结果

| 检查 | 结果 | 证据 |
|---|---|---|
| 单元测试（锚点规则 + 接线钉死） | pass | `node tests/board-human-content.test.mjs` → `board human-content tests passed`；覆盖用户先手写、AI 整篇替换带行/丢行、--append 锚点不动、用户在 AI 正文上改/加行、多重集合同名行、seed 路径、清空正文、droppedHumanLines、1000 行上限，以及三处使用方必须引用正本的文本断言 |
| 全量 npm test | pass | `npm test`（check:docs + check:static + 全部 13 个测试文件，含新增 board-human-content） |
| 隔离实跑：用户先手写 → brief 判「全部人工」 | pass | 临时目录起 server.js，PUT document（不带 source）→ `humanAnchors = ['我的结论：先发版','待办：补齐文档']`；brief 输出「全部是用户手写的内容」+「AI 生成之前用户手写的——每一行都是人工内容」 |
| 隔离实跑：AI 整篇替换丢人工行 → 拦截 | pass | `rtc board write-document` 退出非 0，逐行点名丢失的人工行，提示 `--append` / `--force` |
| 隔离实跑：--append → 锚点保留 + agentDocumentAt 落盘 | pass | 写回成功；`humanAnchors` 不变，`agentDocumentAt` 出现 |
| 隔离实跑：混合正文 → brief 人工锚点段落 | pass | brief 输出「## 人工锚点（用户手写/改动过的行）」+ `> ` 引用行；契约规矩段随材料给出 |
| 隔离实跑：用户在 AI 正文上追加一行 → 新行进锚点 | pass | PUT（不带 source）后 `humanAnchors` 追加「用户补的一句」，AI 行不进锚点 |
| 隔离实跑：--force → 放行但点名丢弃行 | pass | 退出 0，stderr「--force：上面列出的人工内容行将被丢弃」；锚点清空 |
| 隔离实跑：seed 路径（source=agent 写空场次） | pass | 不产生人工锚点；brief 判「目前没有人工内容，全部是 AI 上次写回的」 |
| 隔离实跑：旧版顶层数据（无 sessionId） | pass | 顶层 `humanAnchors` 同样记账 |
| 隔离实跑：GET definition 面板读取不受新字段影响 | pass | 返回结构不变（definition / analysis / preliminary / transcript / document） |
| 文档与链接 | pass | `npm run check:docs` → 33 个索引 Markdown 无断链 |
| 前端名字体检 | pass | `npm run check:js` → 22 个前端模块无 TS2304/2552/2305/2614 |
| 桌面端（Tauri/WKWebView）白板面板行为 | not run | 本次只验证了服务与 CLI；面板 seed 路径的 `source=agent` 标记经 vite build 进入 dist，但未在打包版/桌面开发模式里人工操作验证 |

## 实跑中发现并修复的问题

- **allHuman 误判**（用户先手写、AI 未参与时，服务端已把锚点落盘，brief 却把正文标成「其余部分是 AI 上次写回的」）。根因：`boardProvenance` 的 `allHuman` 只看「锚点为空且无 agentDocumentAt」，没覆盖「锚点恰好覆盖全部正文」的状态。修正为 `allHuman = aiLines.length === 0`（`scripts/board-provenance.cjs`），并补了对应单元测试断言。

## 未验证与已知风险

- 桌面端 WKWebView 里白板面板的 seed 保存（打开带外部分析的场次 → 观察落盘的 `source=agent`）未真机复验；判断依据是单元测试对源码的接线断言 + vite build 成功。
- 打包版（sidecar）未验证：`board-provenance.cjs` 经 `require` 静态引用，预期随 `bun build` 打进 `server.bundle.js`（与现有 require 同机制），但未重跑 `npm run build:sidecar` 确认。
- 多写入者并发（面板 2 秒轮询 + CLI 写回同时发生）未做并发压测；服务端串行合并逻辑未变，风险与改动前相同。
- 历史存量正文（43 个已有场次）没有锚点字段，读侧按「无锚点且无 agentDocumentAt = 全部人工」保守处理——其中可能有历史 AI 写回的内容会被当成人工，代价是偏保守（多保护、不少保护）。
