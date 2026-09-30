# ADR-003: 白板正文区分人工内容与 AI 写回，人工内容是分析锚点

- Status: accepted
- Date: 2026-09-29
- Owner: RTC product owner
- Scope: 会议白板的数据字段、外部 AI 写回契约（`rtc board`）、白板面板的保存路径

## 背景

用户提出：如果在 AI 生成之前，手动在白板里写了一些东西，AI 生成时能不能参考这些内容。

核对现状后确认三件事：

1. **通道已经存在**：`rtc board brief` 一直会把已有正文交给外部 AI，增量更新的提示词也要求"保留已有正文的结构和内容"。但提示词只说"别重写"，没有说清"哪些是用户亲手写的、该怎么对待"。
2. **来源不可辨认**：正文只有一个字符串字段 `document`，人工手写的话和 AI 写回的话落进同一份文本后无法区分。AI 想引用"用户的现场判断"也没有依据。
3. **替换会悄悄冲掉**：`rtc board write-document` 是整篇替换，原有正文（很可能包含用户手写的话）被覆盖时只打印一行提醒，不拦截——「我写的东西怎么没了」是查不回来的。

这与判断台账里的 `PRD.ATTRIBUTION.001`（AI 补的内容必须能被认出来）是同一条规则的两面：**人写的内容也必须能被认出来**。也与 Granola 结论一致：人的现场判断是纪要质量的分水岭，AI 的任务不是重猜重点，而是围绕人的判断补证据。

## 决定

1. **AI 生成时参考人工内容，且把它当锚点而不是普通素材**。brief 材料把正文中可辨认的人工行标为「人工锚点」，并写明契约：围绕锚点去逐字稿找证据、原样保留原句、与逐字稿矛盾时指出矛盾并给出处、判断留给用户。
2. **来源在服务端记账一次**。`PUT /api/meeting-board/document` 按写入来源更新每个场次（及旧版顶层数据）的两个字段：
   - `humanAnchors: string[]` —— 正文里可辨认的人工行；
   - `agentDocumentAt: ISO 串` —— AI 最近一次写回正文的时间（不存在 = AI 还没动过正文）。
   写入来源只有两种：外部 AI 写回（CLI 带 `source=agent`，`--append` 再带 `mode=append`）和人在面板里保存（不带 source）。判定逻辑唯一正本是 `scripts/board-provenance.cjs`，server.js 与 meeting-board.mjs 共用，禁止复制。
3. **写回门槛**：`rtc board write-document` 整篇替换会丢掉人工锚点行时直接拒绝，并点名将丢失的行；`--force` 是唯一放行方式，语义是"用户明确要求全部重写"。
4. **面板把外部分析垫进正文的那次落盘算 AI 写回**（seed 路径带 `source=agent`），否则 AI 生成的整篇会被误认成人工内容，之后每次写回都被门槛拦死。

## 边界

- 锚点是**行级、逐字**的：人工行被改掉一个字就不再被认出（此时原句已经不在了，符合"原样保留"的语义）；反向的宽容度是"行文本还在新正文中就不算丢"，宁可少报不可误拦。
- 锚点只增不删的三条例外：AI 写回冲掉的行、用户自己删掉的行、超过 1000 行上限时丢最老的。
- 锚点无法回答"这句话是哪个来源改的"这类历史问题——它只描述**当前正文**，不做版本历史（那是 MB-03 条件写和未来版本层的地盘）。
- `--force` 门槛只拦 CLI 的 AI 写回；用户在面板里永远可以自由改写，面板不被拦。

## 考虑过的替代方案

- **只改提示词，不加数据字段** — 零改动，但"哪些行是人工的"依然不可知，AI 无法引用回指，门槛也无处落脚；契约停留在口头。
- **存 AI 上次写回的全文快照（agentDocument），读时做 diff** — append 场景会把已有人工行误划给 AI（快照包含合并结果）；且全文快照比只存人工行更占空间。
- **写回前弹确认框** — 拦的是人，而这里的写入者是外部 AI，脚本场景没有人在看；门槛放进 CLI 的退出码才是 AI 能感知的。

## 后果

- `meeting-board.json` 每个场次多两个字段（`humanAnchors` / `agentDocumentAt`），仍是普通 JSON 文件，外部工具可读。
- 外部 AI 的工作流变化：brief 材料多出「人工锚点」段；写回丢人工行会被拒绝，需要带上行或 `--force`。
- 白板面板需要重新构建（seed 路径标记已随 vite build 进入 `dist/meeting-board`）。
- 与 MB-03（外部 AI 写入不能被用户侧悄悄盖掉 → 带 base 的条件写）方向互补、互不替代，条件写仍是独立待办。

## 验证与链接

- 规则：[产品原则·第 6 条](../product-rules/core-product-principles.md)、[会议白板判断台账·PRD.ATTRIBUTION.001](../product-direction/meeting-board-review-2026-09-19.md)
- 实现：[scripts/board-provenance.cjs](../../scripts/board-provenance.cjs)、[server.js](../../server.js)、[scripts/meeting-board.mjs](../../scripts/meeting-board.mjs)、[meeting-board/src/main.js](../../meeting-board/src/main.js)
- 证据：[2026-09-29 白板人工内容锚点](../evidence/2026-09-29-board-human-content-anchor.md)
- 后续：面板「生成纪要草稿」入口同样适用这条契约，见 [ADR-006](ADR-006-board-draft-reads-human-anchors.md)（2026-09-30）。
