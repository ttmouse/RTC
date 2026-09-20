# D-006：「按住说话」叠加在「连续听写」上

```json
{
  "id": "D-006",
  "kind": "decision",
  "status": "active",
  "summary": "统一名称为连续听写模式与按住说话模式；后者只在按键段内手动接管句尾，不关闭或取代常态 VAD 录音",
  "scope": [
    "src/index.html",
    "src/js/state.js",
    "src/js/main.js",
    "src/js/audio.js",
    "src/js/asr.js",
    "src/js/settings.js",
    "src/js/sfx.js",
    "asr_local/server.py",
    "tests/push-to-talk.test.mjs"
  ],
  "sources": [
    "docs/product-rules/ui-interaction-spec.md",
    "src/index.html",
    "src/js/state.js",
    "src/js/main.js",
    "src/js/audio.js",
    "src/js/asr.js",
    "src/js/settings.js",
    "src/js/sfx.js",
    "asr_local/server.py",
    "tests/push-to-talk.test.mjs"
  ],
  "relations": [
    {"type": "related_to", "target": "D-005"},
    {"type": "validated_by", "target": "E-002"},
    {"type": "validated_by", "target": "E-004"}
  ],
  "key": "push-to-talk-interaction-model",
  "recorded_at": "2026-09-20",
  "verified_at": "2026-09-20"
}
```

## 当前产品语义

后续沟通固定用这两个名称：

- **连续听写模式**：麦克风常态录音，由 VAD 判断起说和句尾；
- **按住说话模式**：用户按住设置里录制的单个左/右 Control 或 Option，松开就是明确句尾。

两者是叠加关系，不是二选一。开启「按住说话」开关不会停掉连续听写；没按键时一切照旧，
只有按下到松开这一句暂时不让 VAD 决定句尾。松开后当前句立即提交，底层录音不停，下一句回到 VAD。

## 已采用的行为

- 快捷键可在设置页录制，保存后才生效；
- 按键段内不用 VAD 音量门槛、静音超时、最短发声时长或短文本去噪来裁决是否识别；
- 松手立即冲刷当前语音段，本地引擎热连接继续保留；
- 这一句默认强制粘贴，忽略主界面「自动粘贴」总开关与应用名单；自动发送仍遵守自己的开关与名单；
- 通过快捷键确认这一句时，有开始音和结束音；连续听写的正常粘贴成功音仍保留；
- 组合键保护窗口为 180ms；形成 ⌥Tab、Control+C 等组合键时取消这次语音接管。

## 历史与被否定的方案

中间版本曾把两种方式做成二选一：开启按住说话后停掉常态录音，松手又停掉整场录音。
这与用户实际要求相反：快捷键是「主动标记这一句的句尾」，不是另一套录音引擎。
该方案已被 2026-09-20 的明确决定替代，不得因为实现看起来更简单而改回去。

## 实现状态与未验证项

来源文件显示上述行为已接线，按住说话主链路的自动化证据见 E-002，粘贴音时序回归见 E-004。当前没有记录桌面 App 里的人工验收结论，
因此只能声称「已实现且自动检查通过」，不能声称「用户已体验通过」。
