# D-008：快捷键启动音效复用已运行的录音音频上下文

```json
{
  "id": "D-008",
  "kind": "decision",
  "status": "active",
  "summary": "快捷键启动录音时，开始音必须等录音 AudioContext 进入 running 后播放，并优先复用该上下文；不能依赖浏览器用户手势",
  "scope": ["src/js/main.js", "src/js/sfx.js", "src/js/audio.js", "src/js/assets"],
  "sources": [
    "src/js/main.js",
    "src/js/sfx.js",
    "src/js/audio.js",
    "src/js/assets/speech_start.wav",
    "src/js/assets/speech_stop.wav",
    "tests/sfx-sequence.test.mjs",
    "tests/push-to-talk.test.mjs"
  ],
  "relations": [
    {"type": "related_to", "target": "D-006"},
    {"type": "validated_by", "target": "E-005"}
  ],
  "key": "shortcut-recording-start-sound",
  "recorded_at": "2026-09-20"
}
```

## 为什么

主界面按钮点击属于浏览器用户手势，快捷键事件经过 Tauri 原生事件和定时器，不属于 WKWebView 的 user activation。旧路径在 `getUserMedia` 和录音 AudioContext 建立前播放开始音，WebKit 会创建一个被挂起的音频上下文，结果是按钮能响、快捷键静默。

## 已采用的行为

- `toggleRecording` 先启动录音音频管道，确认 `AudioContext` 可运行后再调用 `playStart`。
- `sfx.js` 优先复用 `state.audioCtx` 的 running 上下文；如果已有的提示音上下文被挂起，则切换到录音上下文。
- 停止音仍由统一的停止录音路径播放；粘贴成功继续复用停止 WAV。
- 这是播放时序修复，不改变录音状态机，也不把音效文件重新做成现场合成音。

## 验证边界

自动测试可以确认入口、调用顺序和音效调用时序，但不能证明用户耳朵听到的结果。桌面端热键启动、停止和实际音量仍需在重启后的 Tauri App 中人工确认。
