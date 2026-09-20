# E-004：快捷键句结束后，连续听写的粘贴音会恢复

```json
{
  "id": "E-004",
  "kind": "evidence",
  "status": "active",
  "summary": "2026-09-20 用真实音效调用时序复现并修复：快捷键句不重复响，但下一句连续听写粘贴会恢复声音",
  "scope": [
    "src/js/sfx.js",
    "src/js/clipboard.js",
    "src/js/asr.js",
    "src/js/main.js",
    "tests/sfx-sequence.test.mjs",
    "tests/push-to-talk.test.mjs"
  ],
  "sources": [
    "docs/product-rules/ui-interaction-spec.md",
    "src/js/sfx.js",
    "src/js/clipboard.js",
    "src/js/asr.js",
    "src/js/main.js",
    "tests/sfx-sequence.test.mjs",
    "tests/push-to-talk.test.mjs",
    "package.json"
  ],
  "relations": [
    {"type": "validates", "target": "D-006"}
  ],
  "key": "push-to-talk-paste-sound-sequence-2026-09-20",
  "recorded_at": "2026-09-20",
  "verified_at": "2026-09-20"
}
```

## 用户发现的症状

按住说话使用后，连续听写的文本仍能正常粘贴，但粘贴成功音消失。

E-002 当时的检查只验证「粘贴成功路径仍有 `playPaste` 调用」，没有验证「这次调用会不会被残留状态拦掉」。
本记录补上音效时序证据，不替代 E-002 对其它按住说话行为的验证。

## 根因

`playStop()` 把全局的 `stopSoundJustPlayed` 设为真，`playPaste()` 遇到它就直接返回，但没有消费后清掉。
原来假设下一次开始录音会由 `playStart()` 复位；现在按住说话松手后底层录音持续，这个前提已不成立。

修复后：

- 快捷键句的「不重复播放」随该句识别结果传到粘贴通道；
- 按住说话的结束音不再设置全局静音；
- 手动停录的兼容静音仍保留，但只能消费一次。

## 回归证据

`tests/sfx-sequence.test.mjs` 用最小 WebAudio 桩调用真实 `playStart / playStop / playPaste` 出口。
修复前稳定失败：预期下一句连续听写播放次数从 2 变 3，实际仍为 2。修复后通过，并另外覆盖手动停录的一次性静音。

`tests/push-to-talk.test.mjs` 同时检查快捷键结果身份确实从 ASR 接到粘贴通道。

本证据仍对应 `feature/push-to-talk` 分支、HEAD `1a3c0c3` 之上的未提交工作区。
没有启动桌面 App，没有代替用户做真实听感验收。
