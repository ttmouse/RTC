# RTC 文档索引

> 给「下一个读代码的人 / 下一个 Agent」的入口。改代码前先读 `product-rules/`，
> 它记录了哪些设计是**刻意为之、不能顺手改**的。
>
> 产品同学只读一份：[product-direction/innovation-backlog-2026-09-14.md](product-direction/innovation-backlog-2026-09-14.md) —— 用产品语言写，技术线索都在文末附录。

## product-rules/ — 产品与界面规则（改代码前必读）

| 文件 | 内容 | 什么时候读 |
|------|------|-----------|
| [product-rules/core-product-principles.md](product-rules/core-product-principles.md) | 产品原则：RTC 坚持什么、为什么，共 9 条。每条带「破坏了用户会看到什么」 | 决定加什么功能、加在哪一层之前 |
| [product-rules/ui-interaction-spec.md](product-rules/ui-interaction-spec.md) | 界面体验规范：纸墨外观、状态诚实、列表不抢滚动、设置页结构等 9 条 | 动界面之前 |

两份都是**人话正文 + 文末工程附录**的结构：产品同学只读正文，实现细节在附录里。

## product-direction/ — 产品方向

| 文件 | 内容 |
|------|------|
| [product-direction/ai-meeting-notes-research.md](product-direction/ai-meeting-notes-research.md) | AI 会议纪要行业研究（Markdown 版，可被 Agent 直接引用）：四大方向、Granola 拆解、记忆层现状、横向对比、选型建议 |
| [product-direction/innovation-backlog-2026-09-14.md](product-direction/innovation-backlog-2026-09-14.md) | 基于当前代码 + 上文的创新清单：5 条 P1 + 4 条 P2，每条带证据与建议 |

原始研究文件（二进制，Agent 读不了，以 `.md` 版为准）：
`AI会议纪要产品方向分析报告.docx` / `AI会议纪要产品方向分析报告（预览版）.pdf`

## 代码之外还有两个入口

- `README.md`（仓库根）：安装、三种运行方式、配置项、换行逻辑、目录结构
- `scripts/rtc.mjs`：CLI 开放入口，**软件边界的产品化表达**（外部 Agent 通过它读记录 / 改配置 / 调 LLM / 执行动作）
