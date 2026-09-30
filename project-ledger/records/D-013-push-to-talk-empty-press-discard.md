# D-013：按住说话的空按不上屏

```json
{
  "id": "D-013",
  "kind": "decision",
  "status": "active",
  "summary": "按了快捷键却没开口时，松手后若整段累计不足 64ms 音频超过用户刻度，判为空按：整段丢弃、不送模型、不上屏",
  "scope": [
    "asr_local/server.py",
    "tests/manual-hallucination.test.mjs",
    "tests/push-to-talk.test.mjs"
  ],
  "sources": [
    "docs/evidence/2026-09-20-manual-voice-evidence.md",
    "docs/product-rules/ux-issue-log.md",
    "asr_local/server.py",
    "tests/manual-hallucination.test.mjs"
  ],
  "relations": [
    {"type": "related_to", "target": "D-006"},
    {"type": "validated_by", "target": "E-008"}
  ],
  "key": "push-to-talk-voice-evidence",
  "recorded_at": "2026-09-20",
  "verified_at": "2026-09-20"
}
```

## 为什么

用户按住快捷键不开口时也会上屏幻觉英文。用户记录（`events/2026-09-20.jsonl`，`engine=sensevoice`）
15:29–15:31Z 连续出现 `'Okay.'` `'The.'` `'I.'`，更早还有 `'Thank you much much.'` `'Little one.'`。

源码层面（修之前）：`feed_audio` 在 `push_to_talk` 分支不看 RMS、每帧直接进缓冲；
`flush_segment` 又只用 `buffered_ms > 0` 当门槛。两者叠加 = 整段静音必然送进模型，
而 SenseVoice 对近乎静音的低电平输入会输出英文套话。

## 决定要点

- 按住期间的断句语义不变：不切句、每帧进缓冲、边界由人松手给出（与 D-006 一致）。
- 增加「人声证据」统计：按住期间累计超过阈值帧的时长，松手时不足 `MIN_VOICE_EVIDENCE_MS`
  （默认 64ms = 2 帧）即判空按，整段丢弃并写明日志原因。
- 门槛用用户主界面刻度（`rms_threshold`），不引入第二套阈值来源。

## 边界

- 只覆盖本地引擎（`sensevoice` / `qwen3`）。百炼的 VAD 在云端，本次不改。
- 若用户把刻度调到环境噪声也能过线，空按仍会漏过；这是刻度语义本身的结果，需要用户侧调高刻度。
- 64ms 是估计值：能挡住空按与单帧脉冲，但没在真实轻声说话上校准过误杀率。
