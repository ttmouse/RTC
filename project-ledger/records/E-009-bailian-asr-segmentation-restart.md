# E-009：百炼 ASR 分句与中间帧问题的重启验证

```json
{
  "id": "E-009",
  "kind": "evidence",
  "status": "active",
  "summary": "百炼 ASR 的分句/中间帧异常由旧桌面进程未加载 bailian-interim 处理逻辑造成；完整重启后已验证恢复，后续状态以 03ee0c03 会话的最新结论为准",
  "scope": ["server.js", "src/js/asr.js", "dist/js/asr.js", "src-tauri"],
  "sources": [
    "server.js",
    "src/js/asr.js",
    "project-ledger/records/S-002-post-commit-current-state-2026-09-20.md"
  ],
  "relations": [
    {"type": "related_to", "target": "D-012"}
  ],
  "key": "bailian-asr-segmentation-interim-frames",
  "recorded_at": "2026-09-20",
  "verified_at": "2026-09-20"
}
```

## 结论

百炼模型出现分句不完整、首句截断或中间帧表现异常时，不能只判断为百炼服务本身识别质量问题。此次确认的根因是：**旧的桌面端进程没有加载新的 `bailian-interim` 处理逻辑**。源代码已经更新，但正在运行的桌面进程仍持有旧的前端 bundle，因此继续表现为旧行为。

处理方式是完整退出并重新启动桌面 App，让前端 bundle 和 Node/Rust 运行链路一起重新加载。完整重启后，百炼分句/中间帧问题已验证恢复。

## 后续判断口径

- 不要用旧桌面进程的实时表现判断当前源码是否生效。
- 涉及 `server.js`、Rust 或前端 bundle 的改动，先整体重启开发桌面 App，再做真实录音验证。
- 后续状态与结论以 **03ee0c03 会话的最新状态**为准；本记录不覆盖该会话之后的新证据。

## 验证边界

本记录保存的是本次会话给出的完整重启验证结论。当前 Project Ledger 不保存该会话的原始日志或截图，因此无法仅凭本记录复现当时的桌面端操作细节；若后续出现回归，应补充新的桌面端实测证据，而不是把本记录当成永久实现保证。
