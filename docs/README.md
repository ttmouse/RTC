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
| [product-rules/ux-issue-log.md](product-rules/ux-issue-log.md) | **体验问题合集**：已经实际发生过、或已被实测证实的体验毛病，一条一个编号（`UX-1`…），修完改状态不删 | 排查界面问题、怀疑「这是不是老毛病」时 |

两份规范都是**人话正文 + 文末工程附录**的结构：产品同学只读正文，实现细节在附录里。

界面类的毛病要能被**量出来**，别靠眼看。`npm run check:ux` 会把页面真跑起来量几何
（内容被裁掉够不着 / 点不动 / 对比度 / 横向溢出…），退出码非 0 就是有发现。
新加检查项时必须先证明它**会变红**——一盏不会变红的灯没有意义。

界面之外的「跑起来才暴露」的毛病也同理：`npm run check:audio` 用真浏览器把录音管道跑一遍
（麦克风用振荡器代替、ASR 用本地假引擎），验证断了会自愈、救不回来会如实报——见
`product-rules/ux-issue-log.md` 的 UX-14。它需要 Playwright（和 check:ux 一样不在仓库依赖里）。

交互类的同样不能只靠读代码：`npm run check:search` 把顶栏这一排入口的行为跑一遍（搜索入口：
默认不占版面 / 点开聚焦 / Esc 一步一跳 / 带着词收起就连词一起清 / 聚焦用偏灰墨色；六个图标的
悬停都是浅纸底加墨色图标），`--break=visible|hidden|red|hoverred|esc` 用来自证这盏灯真会变红。

## product-direction/ — 产品方向

| 文件 | 内容 |
|------|------|
| [product-direction/ai-meeting-notes-research.md](product-direction/ai-meeting-notes-research.md) | AI 会议纪要行业研究（Markdown 版，可被 Agent 直接引用）：四大方向、Granola 拆解、记忆层现状、横向对比、选型建议 |
| [product-direction/innovation-backlog-2026-09-14.md](product-direction/innovation-backlog-2026-09-14.md) | 基于当前代码 + 上文的创新清单：5 条 P1 + 4 条 P2，每条带证据与建议 |
| [product-direction/meeting-board-external-ai-first.md](product-direction/meeting-board-external-ai-first.md) | 会议白板的分工与边界：应用只做记录/保存/加载/展示，理解会议交给外部 AI；**改白板代码前必读** |
| [product-direction/granola-human-in-loop-decision-2026-09-18.md](product-direction/granola-human-in-loop-decision-2026-09-18.md) | 参考 Granola 的结论：人的三种输入（会前定义 / 会中手记 / 会后编辑）各起什么作用 |
| [product-direction/meeting-board-review-2026-09-19.md](product-direction/meeting-board-review-2026-09-19.md) | **会议白板的判断台账**：每一条结论停在哪一档（接收 / 待裁决 / 否定 / 缺信息）、依据是什么、还缺什么事实。产品方向靠它排优先级 |
| [product-direction/mobile-transcription-ios.md](product-direction/mobile-transcription-ios.md) | 手机逐字稿工具：iOS 个人使用、SenseVoice、本地优先、连续签名约束与 MVP 验收标准 |

原始研究文件（二进制，Agent 读不了，以 `.md` 版为准）：
`AI会议纪要产品方向分析报告.docx` / `AI会议纪要产品方向分析报告（预览版）.pdf`

## 代码之外还有两个入口

- `README.md`（仓库根）：安装、三种运行方式、配置项、换行逻辑、目录结构
- `scripts/rtc.mjs`：CLI 开放入口，**软件边界的产品化表达**（外部 Agent 通过它读记录 / 改配置 / 调 LLM / 执行动作）

## project-ledger/ — 决策的知识目录（Project-Ledger）

`project-ledger/records/` 存的是**可追溯的决策记录**（record-v1：id / status / sources /
关系 / key），入口是仓库根的 `.project-knowledge.json`。它**不重复**上面那些文档的正文：
规则本身仍在 `product-rules/`，这里只额外记下「当时怎么判断、选了哪条、被什么验证过」，
并给出 id 和来源，让「这件事当初为什么这么定、后来有没有被推翻」是可查的而不是靠翻对话。

```bash
python3 ~/.agents/skills/Project-Ledger/scripts/knowledge.py context . --task "改主界面搜索入口" --scope src/js
python3 ~/.agents/skills/Project-Ledger/scripts/knowledge.py review .
```

与 `product-rules/` 的分工：**规则是给人读的、要长期遵守的；记录是给人和 Agent 查的、
带来源与验证状态的**。两张表不互相复制，改了一边记得看另一边要不要跟。
