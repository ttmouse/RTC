# 决策记录

本目录用于新的 ADR：记录重大、跨模块或难以逆转的选择。历史决策目前主要在 `project-ledger/records/D-*`，产品方向中的两份已接受旧文档由 [状态表](../product-direction/README.md) 继续路由，暂不为整理目录而搬家。

## 已接受

- [ADR-001：RTC 是持续语音记录与输入工具](ADR-001-product-positioning.md)
- [ADR-002：语音片段按时间切分，应用作为每条记录的语境标签](ADR-002-segment-cut-by-time-app-as-context.md)
- [ADR-003：白板正文区分人工内容与 AI 写回，人工内容是分析锚点](ADR-003-board-human-anchor-contract.md)
- [ADR-004：会议白板的纪要草稿改用用户配置的 AI，且仅手动触发](ADR-004-meeting-board-draft-from-configured-ai.md)
- [ADR-005：后端与识别服务跟随 App 进程生命周期，窗口开关不改变服务存活](ADR-005-service-follows-app-process.md)
- [ADR-006：面板「生成纪要草稿」与外部 AI 通道共用人工锚点契约](ADR-006-board-draft-reads-human-anchors.md)

## 什么时候必须写 ADR

- 改变 Tauri、Node、ASR、前端或外部 Agent 的职责边界。
- 改变用户数据的格式、所有权、默认存放位置或联网策略。
- 推翻现行产品规则，或在两个长期方案之间作出取舍。
- 引入新的常驻服务、核心依赖、发布路径或兼容性承诺。

小型实现选择、临时排障过程和单次测试结果不要写 ADR。分别放进代码注释、运行手册和证据记录。

## 生命周期

1. 从 [ADR 模板](../templates/adr.md) 创建 `ADR-NNN-短标题.md`，初始状态为 `proposed`。
2. 裁决后改为 `accepted` 或 `rejected`，写清日期与负责人。
3. 实现后链接规则、代码和验证证据。
4. 新决定取代旧决定时，旧 ADR 标为 `superseded by ADR-NNN`；不改写历史。
5. 需要机器检索时，在 `project-ledger` 增加对应记录，但不复制 ADR 正文。
