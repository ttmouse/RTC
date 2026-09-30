# RTC 产品定位更新验证证据

- Date: 2026-09-20
- Revision: `feature/push-to-talk` 工作区（未提交）
- Environment: macOS，本地 Node.js 与 Project Ledger 命令行；未启动桌面 App
- Scope: 仓库介绍、产品原则、ADR、候选方向与知识台账的定位一致性

## 检查结果

| 检查 | 结果 | 证据 |
|---|---|---|
| 文档链接与入口可达性 | pass | `npm run check:docs`：23 份 Markdown 均可从 `docs/README.md` 到达，无失效本地链接 |
| Markdown 与 JSON 格式 | pass | `git diff --check` 无空白错误；`npm run check:docs` 能正常读取 `package.json` 并执行 |
| Project Ledger 投影 | pass | `knowledge.py rebuild .` 从 18 份规范记录重建 `project-ledger/generated/index.jsonl`，`D-010` 已进入派生索引 |
| Project Ledger 全库审查 | pass | `knowledge.py review .`：19 份记录、0 错误 0 警告。顺带修正旧记录 `S-002`——它把 `git log --oneline d50a99a..HEAD` 当作来源路径，命令已移入正文，来源只保留真实文件 |
| 桌面端产品行为 | not run | 本次只更新定位与文档，未改代码，也未操作用户正在使用的 App |

## 未验证与已知风险

- 本证据只证明定位文档的入口、链接和台账投影可用，不证明所有功能均已进行新的桌面端人工验收。
- 当前仅麦克风音频可进入逐字稿；系统音频采集仍未实现，因此不能宣称能完整记录线上会议中其他人的声音。
- `S-002` 的修正只改了台账来源字段与一行正文，未改动它记录的历史事实（三个提交、未推送、待人工验收）。
