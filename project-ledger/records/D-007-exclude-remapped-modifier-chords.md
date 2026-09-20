# D-007：排除键盘工具映射出的多修饰键组合

```json
{
  "id": "D-007",
  "kind": "decision",
  "status": "active",
  "summary": "按住说话的单修饰键热键必须排除由 Caps Lock 映射出的 Shift+Control+Option+Command 等多修饰键组合；组合键优先取消本次语音接管，不启动或保留误开的录音",
  "scope": [
    "src-tauri/src/lib.rs",
    "src/js/main.js",
    "tests/push-to-talk.test.mjs"
  ],
  "sources": [
    "docs/product-rules/ui-interaction-spec.md",
    "src-tauri/src/lib.rs",
    "src/js/main.js",
    "tests/push-to-talk.test.mjs"
  ],
  "relations": [
    {"type": "related_to", "target": "D-006"},
    {"type": "validated_by", "target": "E-003"}
  ],
  "key": "push-to-talk-remapped-modifier-chord-exclusion",
  "recorded_at": "2026-09-20"
}
```

## 为什么

用户使用键盘工具把 Caps Lock 映射为 `Shift+Control+Option+Command`。虽然物理上只按了一个键，macOS 事件层可能表现为一组 `FlagsChanged`，不能只依赖普通键按下事件判断组合键。若只识别目标 Control，单修饰键热键可能在组合键完整到达前误启动录音。

## 已采用的实现

- Rust 原生修饰键监听检查 `Shift / Control / Option / Command` 标志。
- 目标修饰键之外出现任何其它受支持修饰键时，发送统一的 `state: "chord"` 事件。
- 物理 keyCode 不属于左右 Control/Option，但事件已带受支持修饰标志时，也按组合键处理；这覆盖 Caps Lock 被键盘工具重映射的路径。
- 前端复用已有 180ms 组合键取消路径，不新增第二套录音状态机。
- 普通 `Control+C`、`Control+V` 等组合键继续取消单修饰键语音接管。

## 边界

该决定描述的是行为和事件边界，不复制 Chatterfly 的二进制实现。桌面端真实 Caps Lock 映射事件是否在当前键盘工具配置下按预期到达，仍需真机人工验收。
