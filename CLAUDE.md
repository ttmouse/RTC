# RTC 项目入口

本文件只负责路由。长期规则、架构说明、决策、操作手册和验证证据分别维护，不在这里重复正文。

## 文档权威性

1. `docs/product-rules/`：现行产品与交互规则，改行为前必须遵守。
2. `docs/design-rules/`：现行视觉与呈现规则（token 正本、可判定的设计原则、治理合同）；改样式、图标、动效或新窗口外观前必须读，数值以代码为唯一来源。
3. `docs/architecture/`：现行系统边界与不变量，改模块边界或数据流前必须核对。
3. `docs/decisions/` 与 `project-ledger/records/`：解释重要选择及其来源；只有已接受且未被取代的决定具有约束力。
4. `docs/runbooks/`：重复操作和故障恢复步骤，是操作层事实。
5. `docs/evidence/` 与 `project-ledger/records/E-*`：只证明某次检查做过什么，不自动升级为长期规则。
6. `docs/product-direction/`：研究、候选方向和判断台账；除目录索引明确标为“已接受”的文档外，不得当成现行需求。

代码、运行结果与文档冲突时，不要悄悄挑一个相信。先查明现状，再在同一次改动中更新失真的文档或明确记录待裁决项。

## 按任务读取

- 改产品范围、默认行为或数据边界：先读 `docs/product-rules/README.md` 和 `docs/product-rules/core-product-principles.md`。
- 改界面、交互、状态文案或会议白板：再读 `docs/product-rules/ui-interaction-spec.md`、`docs/product-rules/ux-issue-log.md`；白板还要按 `docs/product-direction/README.md` 的状态读取相关决定。
- 改样式、图标、动效、颜色或新窗口外观：先读 `docs/design-rules/README.md`（视觉正本 + 设计原则 + 治理合同）；交互仍走 product-rules。
- 改服务、端口、数据流、Tauri/Node/ASR 边界：先读 `docs/architecture/README.md`。
- 新增重大能力或改变既有取舍：在 `docs/decisions/` 新建 ADR，并同步需要更新的产品规则。
- 操作语音指令配置：读 `docs/voice-command-agent-guide.md`。
- 发布、排障或执行重复操作：从 `docs/runbooks/README.md` 找对应手册；没有手册时补一份，不把临时命令塞进本文件。
- 声称某项改动已验证：按 `docs/evidence/README.md` 留下可复查的证据，明确“未运行”和验证盲区。

## 维护底线

- 默认开发入口是桌面端 `npm run dev`；`npm run dev:web` 只作浏览器辅助。
- 测试不得读写用户真实转写和配置；需要服务时使用隔离的 `RTC_DATA_DIR`。
- 规则写清适用场景、约束、例外和验证方法；研究结论不得直接伪装成规则。
- 文档改动后运行 `npm run check:docs`。代码行为变化时，同时检查入口索引和相关规则是否需要更新。
- `project-ledger/` 是可追溯记录，不复制规则正文，也不替代 `docs/` 的人类可读入口。

完整地图见 `docs/README.md`。
