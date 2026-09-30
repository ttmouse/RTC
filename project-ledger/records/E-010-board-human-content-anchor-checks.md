# E-010：白板人工内容锚点的单元测试与隔离实跑验证

```json
{
  "id": "E-010",
  "kind": "evidence",
  "status": "active",
  "summary": "2026-09-29 未提交工作区：board-provenance 单元测试与全量 npm test 通过；隔离 RTC_DATA_DIR 实跑全链路（人工先写/brief 判定/门槛拦截/append/锚点累积/--force/seed/顶层）通过；桌面端 WKWebView 面板与打包 sidecar 未复验",
  "scope": [
    "scripts/board-provenance.cjs",
    "server.js",
    "scripts/meeting-board.mjs",
    "tests/board-human-content.test.mjs"
  ],
  "sources": [
    "tests/board-human-content.test.mjs",
    "docs/evidence/2026-09-29-board-human-content-anchor.md",
    "package.json",
    "scripts/board-provenance.cjs"
  ],
  "relations": [
    {"type": "validates", "target": "D-016"}
  ],
  "key": "board-human-content-anchor-checks-2026-09-29",
  "recorded_at": "2026-09-29",
  "verified_at": "2026-09-29"
}
```

## 结论

D-016 的实现按下列口径验证通过（详细矩阵见
[docs/evidence/2026-09-29-board-human-content-anchor.md](../../docs/evidence/2026-09-29-board-human-content-anchor.md)）：

- `node tests/board-human-content.test.mjs` 通过：覆盖用户先手写、AI 整篇替换带行/丢行、
  `--append` 锚点不动、用户在 AI 正文上改/加行、多重集合同名行、seed 路径、清空正文、
  droppedHumanLines、1000 行上限，以及「三处使用方必须引用正本」的接线钉死。
- 全量 `npm test` 通过（check:docs / check:static / 全部测试文件，EXIT=0）。
- 隔离 `RTC_DATA_DIR`（mktemp 临时目录，PORT=8951）实跑十步全通过：人工先写 → brief 判
  「全部人工」→ AI 丢行被拦 → `--append` 保留锚点并记 `agentDocumentAt` → 混合正文出现
  「人工锚点」段 → 人工追加进锚点 → `--force` 点名放行 → seed（source=agent）不产生假锚点
  → GET definition 面板读取不受新字段影响 → 旧版顶层数据同样记账。

## 实跑中发现并修复的问题

- **allHuman 误判**：用户先手写、AI 未参与时（服务端已落盘锚点），brief 把正文标成
  「其余部分是 AI 上次写回的」。根因：`boardProvenance` 的 `allHuman` 只看「锚点为空且无
  agentDocumentAt」，没覆盖「锚点恰好覆盖全部正文」。修正为 `allHuman = aiLines.length === 0`
  并补测试。这是隔离实跑的价值：单元测试先写漏了这个状态组合。

## 验证边界（not run / 盲区）

- **桌面端 WKWebView 白板面板**：seed 路径的 `source=agent` 标记经 vite build 进入
  `dist/meeting-board`，但未在桌面开发模式或打包版里人工操作验证；依据是接线测试 + 构建成功。
- **打包 sidecar**：`board-provenance.cjs` 走静态 `require`，预期随 `bun build` 打进
  `server.bundle.js`（与现有 require 同机制），但未重跑 `npm run build:sidecar` 确认。
- **并发**：面板 2 秒轮询与 CLI 写回同时发生的并发未压测；服务端串行合并逻辑未变，风险
  与改动前相同。
- **历史存量**：43 个已有场次没有锚点字段，读侧按「无锚点且无 agentDocumentAt = 全部人工」
  保守处理——其中可能有历史 AI 写回内容被当成人工，代价方向是偏保守（多保护、不少保护）。
- 本记录对应的改动在 `feature/push-to-talk` 分支的**未提交工作区**里，与按住说话的未提交
  改动混在一起；提交切分后本结论才锚定到具体 revision。
