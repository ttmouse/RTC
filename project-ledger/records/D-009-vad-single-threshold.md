# D-009：VAD 只保留主界面单一阈值

```json
{
  "id": "D-009",
  "kind": "decision",
  "status": "active",
  "summary": "撤销自动适应环境噪声与自动/手动 VAD 模式；主界面电平尺刻度是唯一实际生效的识别阈值",
  "scope": [
    "src/index.html",
    "src/js/state.js",
    "src/js/settings.js",
    "src/js/asr.js",
    "src/js/audio.js",
    "server.js",
    "asr_local/server.py",
    "tests/vad.test.mjs"
  ],
  "sources": [
    "src/index.html",
    "src/js/state.js",
    "src/js/settings.js",
    "src/js/asr.js",
    "src/js/audio.js",
    "server.js",
    "asr_local/server.py",
    "tests/vad.test.mjs"
  ],
  "relations": [
    {"type": "related_to", "target": "D-006"},
    {"type": "validated_by", "target": "E-005"}
  ],
  "key": "vad-single-threshold",
  "recorded_at": "2026-09-20",
  "verified_at": "2026-09-20"
}
```

## 采用的行为

- 设置页不再暴露「自动 / 手动」VAD 选择。
- 主界面电平尺上的刻度同时决定前端说话判断和本地引擎分段阈值。
- 拖动刻度时，本地引擎通过 `set-vad-threshold` 即时收到新值；未连接时由下一次任务初始化携带。
- 保留静音超时、起说连续块数、系统降噪和回声消除；这些不是自动适应环境噪声，不随本次删除移除。
- 旧配置只做一次性迁移：旧自动模式回到默认阈值 `0.006`，旧手动值保留；迁移后删除废弃的 `vadMode` 字段。

## 选择原因

用户实际无法感受到自动适应的价值，而原实现还存在多个判断源：自动阈值会覆盖用户刻度，前端与本地服务各自估算，界面显示值可能不是实际值。继续包装自动模式会增加解释成本和状态不一致风险，因此收敛为一套用户可见、可调整、可验证的阈值。

## 验证边界

源码守门测试和 `npm test` 已通过；桌面端真实录音体验仍需在重启开发 App 后由用户验收，不能仅凭自动测试宣称听感已确认。
