# D-016：白板正文区分人工内容与 AI 写回，人工内容是分析锚点

```json
{
  "id": "D-016",
  "kind": "decision",
  "status": "active",
  "summary": "白板正文按写入来源记账（humanAnchors / agentDocumentAt）：brief 把用户手写的行标成「人工锚点」并附 AI 契约（围绕找证据、原样保留、矛盾指出而非代改），write-document 丢人工行被 CLI 拦下（--force 才放行）；判定逻辑唯一正本 scripts/board-provenance.cjs",
  "scope": [
    "scripts/board-provenance.cjs",
    "server.js",
    "scripts/meeting-board.mjs",
    "meeting-board/src/main.js",
    "docs/decisions"
  ],
  "sources": [
    "docs/decisions/ADR-003-board-human-anchor-contract.md",
    "scripts/board-provenance.cjs",
    "server.js",
    "scripts/meeting-board.mjs",
    "meeting-board/src/main.js",
    "README.md"
  ],
  "relations": [
    {"type": "validated_by", "target": "E-010"},
    {"type": "related_to", "target": "D-011"}
  ],
  "key": "board-human-anchor-contract",
  "recorded_at": "2026-09-29",
  "verified_at": "2026-09-29"
}
```

## 为什么

用户提出：如果在 AI 生成之前手动在白板里写了一些东西，AI 生成时能不能参考。核对现状发现三点：
通道其实已经存在（`rtc board brief` 一直带已有正文），但正文只有 `document` 一个字符串字段，
人工手写和 AI 写回落进同一份文本后**来源不可辨认**，AI 想引用用户的现场判断也没有依据；
且 `write-document` 整篇替换原有正文时只打印一行提醒、不拦截——「我写的东西怎么没了」查不回来。
这与判断台账 `PRD.ATTRIBUTION.001`（AI 补的内容必须能被认出来）是同一条规则的两面：人写的
内容也必须能被认出来；也与 Granola 结论一致：人的现场判断是纪要质量的分水岭。

## 决定要点

- **来源在服务端记账一次**：`PUT /api/meeting-board/document` 按写入来源更新每场（及旧版
  顶层）的 `humanAnchors`（可辨认的人工行）与 `agentDocumentAt`（AI 最近写回时间，不存在 =
  AI 没动过）。写入来源只有两种：外部 AI 写回（CLI 带 `source=agent`，`--append` 再带
  `mode=append`）和人在面板里保存（不带 source）。
- **面板 seed 路径算 AI 写回**：外部分析垫进空正文的那次落盘带 `source=agent`
  （`meeting-board/src/main.js` 的 seedDocument），否则 AI 生成的整篇会被误认成人工内容，
  之后每次写回都被门槛拦死。
- **brief 契约**：人工行标成「人工锚点」段落，规矩写进材料——围绕锚点去逐字稿找证据、
  原样保留（不改写/不润色/不并进 AI 行文）、与逐字稿矛盾时保留原句并指出矛盾给出处、
  判断留给用户。
- **写回门槛**：`write-document` 会丢人工锚点行时直接拒绝并逐行点名；`--force` 是唯一放行
  方式，语义是「用户明确要求全部重写」。`--append` 不受影响。
- **判定逻辑唯一正本**：`scripts/board-provenance.cjs`（.cjs 保证 bun 打包能静态 require），
  server.js 写侧与 meeting-board.mjs 读侧共用，禁止复制。
- 边界：锚点是行级、逐字的（改一个字就不再认出，符合「原样保留」语义；反向宽容——行文本
  还在就不算丢，宁可少报不可误拦）；只描述当前正文，不做版本历史；`--force` 只拦 CLI，
  面板里用户永远可以自由改写。

## 考虑过的替代方案

- 只改提示词不加字段——零改动，但人工行依然不可知，门槛无处落脚。
- 存 AI 上次全文快照做 diff——append 场景把已有人工行误划给 AI，且更占空间。
- 写回前弹确认框——写入者是外部 AI 脚本，没人在看；门槛要进 CLI 退出码。

## 验证

见 E-010：单元测试 + 全量 npm test 通过；隔离 `RTC_DATA_DIR` 实跑全链路通过（含 seed、
顶层、--force、门槛拦截）；桌面端 WKWebView 面板行为与打包 sidecar 未复验（盲区见 E-010）。
实现对应 [ADR-003](../../docs/decisions/ADR-003-board-human-anchor-contract.md)。
