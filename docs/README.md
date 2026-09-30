# RTC 文档中心

RTC 的产品定位是**本地优先的持续语音记录与输入工具**：同一份麦克风语音既可以进入当前应用，也会沉淀为本地逐字稿，供会议分场、回看和后续整理。完整边界见 [ADR-001](decisions/ADR-001-product-positioning.md)。

这里不是资料仓库，而是 RTC 的知识入口。先按任务找对层级，再决定哪些内容能约束实现。

## 先认清权威性

| 层级 | 回答的问题 | 权威性 |
|---|---|---|
| [产品规则](product-rules/README.md) | 产品必须怎样表现 | 现行规则，除非明确标为提案或已废弃 |
| [设计规则](design-rules/README.md) | 界面必须长什么样、视觉冲突怎么裁决 | 现行规则；数值以代码为准 |
| [系统架构](architecture/README.md) | 系统边界、数据流和不变量是什么 | 现状基线；改变时必须同步更新 |
| [决策记录](decisions/README.md) | 为什么选这条路、放弃了什么 | 已接受且未被取代的决定有效 |
| [运行手册](runbooks/README.md) | 怎样重复执行或恢复一个操作 | 操作层事实，需能实际复现 |
| [验证证据](evidence/README.md) | 某次变更实际检查了什么 | 历史证明，不是永久规则 |
| [产品方向](product-direction/README.md) | 还在研究、排期或待裁决什么 | 默认非权威；以目录中的状态为准 |
| `project-ledger/records/` | 决定、证据和当前状态如何追溯 | 索引层，不复制上述正文 |

当规则、代码与运行结果不一致时，冲突本身就是问题。不要用“代码现在这样”自动推翻规则，也不要用旧文档否认已经验证的新行为；查清后同步修正权威来源。

## 按任务走最短路线

| 任务 | 必读 |
|---|---|
| 判断是否该做一个功能 | [产品原则](product-rules/core-product-principles.md) → [产品方向状态表](product-direction/README.md) |
| 改主界面、设置页、状态或反馈 | [界面体验规范](product-rules/ui-interaction-spec.md) → [体验问题合集](product-rules/ux-issue-log.md) |
| 改样式、图标、动效或新窗口外观 | [视觉正本](design-rules/visual-language.md) → [设计原则](design-rules/design-principles.md)；动手前看 [治理合同](design-rules/governance.md) |
| 改会议白板 | 上述两份界面文档 → [产品方向状态表](product-direction/README.md) 中两份“已接受”白板决定 |
| 改 Tauri、Node、ASR、端口或本地数据 | [系统架构](architecture/README.md) |
| 改语音指令配置 | [语音指令生成指南](voice-command-agent-guide.md) |
| 作出难以逆转或跨模块的选择 | [决策记录](decisions/README.md)，新建 ADR |
| 记录测试、人工验收或发布结果 | [验证证据](evidence/README.md) |
| 执行发布、排障或恢复 | [运行手册](runbooks/README.md) |

仓库根 [README](../README.md) 负责安装、运行方式、配置和用户可见功能；本目录负责约束、理由、操作与证据。两者不要复制整段内容。

## 维护闭环

1. 先确定内容属于规则、架构、决策、手册、证据还是研究。
2. 在对应目录更新正文；重大取舍使用 [ADR 模板](templates/adr.md)。
3. 行为变化时更新规则或架构，不能只留一条聊天记录或提交说明。
4. 用 [证据模板](templates/evidence.md) 记录实际运行结果和盲区；未运行就写“未运行”。
5. 运行 `npm run check:docs`，检查本地链接和未被入口索引的 Markdown。
6. 如果决定进入或退出现行状态，同步更新目录状态表和相关 `project-ledger` 记录。

定时优化审查（ZCode 自动维护）沉淀在 [优化审查记录](optimization-review.md)：带代码依据的优化点与修复标注，属于待办线索，不构成规则。

## 当前已知治理债务

- `design-rules/` 里还带着四行待裁决项（白板是否为独立外观、次要文字要不要守住 4.5:1、
  字号与圆角要不要收敛成 token、菜单栏橙底白柱的对比度）；它们需要产品判断，
  不裁决就不算完成，见 [设计治理合同](design-rules/governance.md) 第 4 节。

- `product-direction/` 里已有两份实际承担决定作用的旧文件。为避免大规模搬迁造成断链，当前保留原路径，由状态表声明其权威性；以后有实质变更时再用 ADR 接续，不做纯整理式搬家。
- `docs/AI会议纪要产品方向分析报告.docx` 和预览 PDF 是研究附件；可检索、可引用的版本是 `product-direction/ai-meeting-notes-research.md`。
- `docs/voice-command-agent-guide.md` 目前同时是能力参考和操作指南。现阶段保留稳定路径；内容明显扩张时再拆，不提前制造迁移成本。

## 模板

- [规则模板](templates/rule.md)
- [ADR 模板](templates/adr.md)
- [证据模板](templates/evidence.md)
