# 验证证据

证据回答“这一次实际检查了什么”，不回答“产品永远应该怎样”。长期约束应回写产品规则或架构文档。

## 当前证据位置

- `project-ledger/records/E-*`：具体改动的结构化验证记录。
- [体验问题合集](../product-rules/ux-issue-log.md)：已经发生或实测证实的用户可见问题及修复状态。
- 本目录：后续发布、迁移或高风险改动的人工验收记录，文件名使用 `YYYY-MM-DD-主题.md`。

## 本目录记录

- [2026-09-20-documentation-governance.md](2026-09-20-documentation-governance.md)：首版治理骨架、路由和文档门禁。
- [2026-09-20-product-positioning.md](2026-09-20-product-positioning.md)：产品定位更新的文档一致性、边界与未验证项。
- [2026-09-20-speech-segments-and-app-context.md](2026-09-20-speech-segments-and-app-context.md)：片段按时间切分、应用当语境标签的决定落盘与事实核对（含未实现项）。
- [2026-09-20-packaged-app-sidecar.md](2026-09-20-packaged-app-sidecar.md)：打包版 App 两个后端进程的坑（node sidecar 签名被系统 SIGKILL、asr-server 版本落后导致按住说话失效）与处置验证。
- [2026-09-20-manual-voice-evidence.md](2026-09-20-manual-voice-evidence.md)：按住说话「空按」不再把静音送进模型上屏（含检查变红证据与真实底噪盲区）。
- [2026-09-20-bailian-sentence-splitting.md](2026-09-20-bailian-sentence-splitting.md)：百炼下一句话被拆成多条记录的根因（前端写死的音量兑底）、对照实验与守门检查（真机复验未做）。
- [2026-09-29-board-human-content-anchor.md](2026-09-29-board-human-content-anchor.md)：白板人工内容锚点（ADR-003）的单元测试、隔离实跑全链路与桌面端盲区。

记录时必须区分 `pass`、`fail`、`not run`，并写明命令、环境、观察结果和盲区。静态检查通过不等于桌面端行为通过；浏览器测试也不能替代 Tauri/WKWebView 的真实交互验证。

新记录使用 [证据模板](../templates/evidence.md)。
