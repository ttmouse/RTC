# 文档治理首版验证证据

- Date: 2026-09-20
- Revision: `feature/push-to-talk` 工作区（未提交）
- Environment: macOS，本地 Node.js 命令行；未启动桌面 App
- Scope: 文档入口、分类、权威性说明、相对链接、孤儿 Markdown 和现有自动测试

## 检查结果

| 检查 | 结果 | 证据 |
|---|---|---|
| 文档链接与入口可达性 | pass | `npm run check:docs`：21 份 Markdown 均可从 `docs/README.md` 到达，无失效本地链接 |
| 项目自动测试 | pass | `npm test`：文档门禁、静态检查及现有测试全部通过 |
| 桌面端路径 | not run | 本次没有改变产品行为，也未操作用户正在使用的 App |

## 未验证与已知风险

- 门禁检查 Markdown 相对链接和入口可达性，不检查标题锚点是否存在，也不判断正文事实是否已经过期。
- `project-ledger/records/` 由专用知识工具维护，不纳入 `docs/README.md` 的孤儿文件检查。
- 历史文档未批量改写状态头；当前权威性以各目录 README 的状态表为入口，后续只在有实质改动时逐份补齐。
