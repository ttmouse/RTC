# ADR-006: 面板「生成纪要草稿」与外部 AI 通道共用人工锚点契约

- Status: accepted
- Date: 2026-09-30
- Owner: RTC product owner
- Scope: 会议白板 · 面板起草（`POST /api/meeting-board/preliminary`）的提示词输入

## 背景

[ADR-003](ADR-003-board-human-anchor-contract.md) 定了「AI 生成时参考人工内容，且把它当锚点而不是普通素材」，但只落实在外部 AI 通道（`rtc board brief`）：brief 会把正文里可辨认的人工行单列成「## 人工锚点」，并要求围绕锚点补证据、原样保留。

面板上的「生成纪要草稿」按钮（走 `POST /api/meeting-board/preliminary`，[ADR-004](ADR-004-meeting-board-draft-from-configured-ai.md) 的例外通道）只把逐字稿喂给 AI——提示词里从头到尾没有「已有正文」这一项。

用户 2026-09-30 核对时发现：同一个「让 AI 写会议纪要」，走外部通道会围着人写的内容补证据，走面板按钮则完全无视它。**同一个产品行为在两个入口对用户写的话有两种态度，用户无法预测自己手写的东西什么时候算数。**

这是 ADR-003 决定 1 的实现缺口，不是一个新的产品取向。

## 决定

面板起草与外部通道**共用同一条人工锚点契约**：

1. 提示词带上该场次的已有正文；可辨认的人工行按 `scripts/board-provenance.cjs` 判定（唯一正本，不复制逻辑），单独列成「人工锚点」。
2. 规矩与 brief 对齐：围绕锚点去逐字稿里找证据、引用回指；锚点行**原样**出现在草稿里，不改写、不润色、不并进你的行文；与逐字稿矛盾时保留原句、在紧邻处指出矛盾并给出处（`[HH:MM]`），判断留给用户。
3. 来源三分支与 brief 一致：全部人工 / 含人工锚点 / 全部是 AI 上次写回的——最后一种如实标注为 AI 的，不冒充人工内容。
4. 既有保护不变：起草结果仍只在「正文为空，或仍等于上一版草稿」时才落进正文；用户手改过的正文不会被草稿覆盖。

边界：只改**输入**。写回路径、采纳按钮、失败回退（fallback 存格式化原文）都不动——本决定不引入新的写入方。

## 考虑过的替代方案

- **维持现状（面板不读正文）** — 面板是「一键」入口，不带正文最省 token。但两个入口态度不一致这件事本身就是缺陷：用户写的话在哪个入口算数，取决于他点了哪个按钮。
- **把锚点契约抽成一份共享提示词片段** — 两份提示词的服务对象不同（brief 面向外部 agent 的完整写回规程，面板只产出草稿），共享的是**规则**而不是**文本**；强行合并会让面板继承一堆它用不到的写回指令。
- **面板也要求「原样保留 + 允许 --force」** — `--force` 是 CLI 概念，面板没有；采纳草稿走 `PUT /api/meeting-board/document`（用户写入），写回门槛对它本来就不适用。

## 后果

- 面板起草的输入变长：多一份正文。正文越长 token 越多——这是「参考人工内容」的必要代价（brief 同样如此）。
- 两个入口对「人工内容」的态度一致：用户手写的话在两个入口都被当锚点。
- `scripts/board-provenance.cjs` 的读侧判定多了一个调用方（preliminary 路径），仍是同一份正本，没有第二套判定。

## 验证与链接

- 规则：[ADR-003](ADR-003-board-human-anchor-contract.md)、[产品原则·第 6 条](../product-rules/core-product-principles.md)
- 实现：[server.js](../../server.js) 的 `runPreliminary整理`
- 证据：`meeting-board/tests/preliminary.test.mjs`（已证明会变红）｜[UX-19](../product-rules/ux-issue-log.md)
