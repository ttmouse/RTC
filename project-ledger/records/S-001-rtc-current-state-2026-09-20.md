# S-001：RTC 项目当前状态（2026-09-20）

```json
{
  "id": "S-001",
  "kind": "state",
  "status": "active",
  "summary": "RTC 当前处于 feature/push-to-talk 分支的大批未提交集成状态：连续听写、按住说话、菜单栏状态、模型服务恢复与音效链路均已进入代码和自动测试，但发布产物与桌面端人工验收仍需单独确认",
  "scope": [],
  "sources": [
    "docs/product-rules/core-product-principles.md",
    "docs/product-rules/ui-interaction-spec.md",
    "package.json",
    "src-tauri/tauri.conf.json",
    "src/js/main.js",
    "src/js/audio.js",
    "src/js/asr.js",
    "src/js/sfx.js",
    "tests/push-to-talk.test.mjs",
    "tests/sfx-sequence.test.mjs"
  ],
  "relations": [
    {"type": "related_to", "target": "D-006"},
    {"type": "validated_by", "target": "E-005"},
    {"type": "constrained_by", "target": "R-001"}
  ],
  "recorded_at": "2026-09-20",
  "verified_at": "2026-09-20"
}
```

## 当前结论

- 产品底线仍是：录音 → 出字 → 保存先走通；状态必须诚实；桌面 App 是默认验证环境。
- 连续听写与按住说话是叠加关系。按住说话只在物理按键段内接管句尾，不关闭常态 VAD 录音。
- 菜单栏状态由主界面状态源翻译；按住说话的物理按下反馈是唯一额外的意图反馈。
- 本地识别依赖 8933 模型服务，代理服务使用 8931；两者不能合并成一个“服务正常”结论。
- 音效资源已进入 `src/js/assets/`；开始音、停止音来自本地 WAV，粘贴成功复用停止音。

## 工作区边界

2026-09-20 核对时：分支为 `feature/push-to-talk`，HEAD 为 `d50a99a`（`chore: align project ledger path`），工作区有 40 项已修改或未跟踪内容，主要集中在按住说话、音频恢复、菜单栏状态、模型服务恢复、音效与测试。

这不是一个可直接当作单一 commit 检出的发布状态。后续提交前必须重新检查 HEAD、工作区和暂存区，按功能拆分提交，避免把并行会话的改动混在一起。

## 已核验与未知

- `npm test` 当前通过；具体结果见 E-005。
- `dist/js/sfx.js` 仍保留旧版合成音代码，而 Tauri 打包配置的 `frontendDist` 指向 `dist`。开发模式通过 8931 直接提供 `src/`，两条路径不是同一份产物。
- 当前能确认 8931 与一个 `target/debug/rtc-transcriber` 进程在运行；没有做屏幕操作或人工听感判断，因此桌面端真实音效、热键和睡眠唤醒仍不能称为已验收。
