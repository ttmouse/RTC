# 语音片段与语境标签决定验证证据

- Date: 2026-09-20
- Revision: `feature/push-to-talk` 工作区（未提交）
- Environment: macOS，本地 Node.js 与 Project Ledger 命令行；未启动桌面 App
- Scope: `docs/decisions/ADR-002`、判断台账 MB-15 与 MB-24 标注、`project-ledger` 记录的知识一致性

## 检查结果

| 检查 | 结果 | 证据 |
|---|---|---|
| 文档链接与入口可达性 | pass | `npm run check:docs`：无失效本地链接，无未被 `docs/README.md` 索引的 Markdown |
| Project Ledger 结构审查 | pass | `knowledge.py review .`：0 错误 0 警告；新增 `D-011` 无结构或关系问题 |
| 派生索引重建 | pass | `knowledge.py rebuild .` 从规范记录重建 `project-ledger/generated/index.jsonl` |
| 事实核对（应用快照是否已存在） | pass | `src/js/storage.js` 写入 `activeApp`；`src/js/asr.js` 每条定型路径都取前台应用；`docs/product-rules/ui-interaction-spec.md` 第 6 节已有该界面规则 |
| 事实核对（片段切分是否用应用） | pass | `server.js` 的 `detectSessions` 只按静默间隔切分；`formatTranscriptLines` 只用 `session.texts`，应用与真实时间戳在片段模型里已丢失 |
| 真实记录字段分布 | pass | 2026-09-20 当天事件 522 条：`activeApp` 有值 485 条、为空 37 条；`targetApp` 全部为空（旧字段已无写入方） |
| 桌面端产品行为 | not run | 本次只写决定与文档，未改代码，也未操作用户正在使用的 App |

## 未验证与已知风险

- 本证据只证明决定已落到 ADR、判断台账和可检索记录，链接与台账结构可用；**不证明**逐字稿已经能显示应用标签，也不证明时间戳已经改成真实时刻。
- ADR-002 的展示层后果（片段保留 `ts` 与 `activeApp`）尚未实现；UX-2 / MB-02 仍是未完成状态，实现时需另出证据。
- 应用快照有约 7% 为空（当天 37/522），来源包括网页版、查询失败与对着 RTC 自己窗口说话；边界见 ADR-002。
- 「会议」叫法是否改名（MB-15）仍待产品裁决，本证据不构成对命名的决定。
- 本次改动与同一工作区的其他未提交改动并存，`git status` 中非本范围文件不属于本证据的检查对象。
