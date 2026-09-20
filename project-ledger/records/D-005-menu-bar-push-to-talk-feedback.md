# D-005：菜单栏同时表达 VAD 听见与「按住说话」按键意图

```json
{
  "id": "D-005",
  "kind": "decision",
  "status": "active",
  "summary": "菜单栏继续用橙色波浪表达说话中；但按住说话时以物理键按下为准立即点亮，不等 180ms、麦克风就绪或 VAD",
  "scope": [
    "src/js/state.js",
    "src/js/main.js",
    "src/js/tray.js",
    "tests/tray-speaking.test.mjs",
    "tests/push-to-talk.test.mjs"
  ],
  "sources": [
    "docs/product-rules/ui-interaction-spec.md",
    "src/js/state.js",
    "src/js/main.js",
    "src/js/tray.js",
    "tests/tray-speaking.test.mjs",
    "tests/push-to-talk.test.mjs"
  ],
  "supersedes": ["D-004"],
  "relations": [
    {"type": "related_to", "target": "D-006"},
    {"type": "validated_by", "target": "E-002"}
  ],
  "key": "menu-bar-status-icon",
  "recorded_at": "2026-09-20",
  "verified_at": "2026-09-20"
}
```

## 当前结论

D-004 定下的菜单栏基础语义仍保留：黑白麦克风表示没录，黑白圆点表示在录但安静，
橙色胶囊与白色波浪是强反馈，异常时红色优先。本记录替代 D-004 的原因是，橙色强反馈现在有两个合法来源：

1. **连续听写模式**：仍由 `state.vadState === 'speech'` 表示真正听到人声；
2. **按住说话模式**：用户按下自定义键的当下就立即点亮，松开立即撤回。

第二条反馈的是「我的按键动作已被接住」，不是「系统已经听到声音」。如果它仍只看 VAD，
用户不说话时无论按多久都没有反馈；这正是 2026-09-20 实际出现的症状。

## 时序与边界

- 物理键按下：`state.pushToTalkVisualActive = true`，并立即刷新菜单栏；
- 180ms 组合键窗口：只决定是否开始手动语音段与播放开始音，不延迟视觉反馈；
- 后续形成 ⌥Tab、Control+C 等组合键：这次说话意图作废，立即撤回点亮；
- 物理键松开：立即撤回，不等识别结果返回；
- 麦克风或服务异常：红色异常仍压倒橙色反馈。

## 历史

D-004 经过多轮迭代才形成「没录 / 在录安静 / VAD 说话中 / 异常」四类语义。
当时没有按住说话，因此「橙色只来自 VAD」是完整的。2026-09-20 新增用户主动按键交互后，
如果不显式记录这个例外，后续按 D-004 的旧结论「统一回 VAD」会直接让故障复发。

## 验证边界

自动化证据见 E-002。未在桌面 App 内人工验收；不得把源码级测试写成「用户已体验通过」。
