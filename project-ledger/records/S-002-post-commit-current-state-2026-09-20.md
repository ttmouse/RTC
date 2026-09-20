# S-002：RTC 提交后的当前状态（2026-09-20）

```json
{
  "id": "S-002",
  "kind": "state",
  "status": "active",
  "summary": "feature/push-to-talk 已将当前集成改动拆成核心功能、音效和 Project-Ledger 三个本地提交；尚未推送，桌面端人工验收与 dist 构建仍待完成",
  "scope": ["feature/push-to-talk", "src", "src-tauri", "asr_local", "tests", "project-ledger"],
  "sources": [
    "git log --oneline d50a99a..HEAD",
    "package.json",
    "tests/push-to-talk.test.mjs",
    "tests/sfx-sequence.test.mjs",
    "project-ledger/records/R-001-release-and-manual-verification-gap.md"
  ],
  "relations": [
    {"type": "supersedes", "target": "S-001"},
    {"type": "validated_by", "target": "E-005"},
    {"type": "constrained_by", "target": "R-001"}
  ],
  "recorded_at": "2026-09-20",
  "verified_at": "2026-09-20"
}
```

## 当前提交

- `8096ad8 feat: unify VAD threshold and add push-to-talk`
- `826cda6 feat: use bundled speech feedback sounds`
- `906ea55 docs: record RTC integration decisions`

三个提交均已通过 `git diff --check`，当前分支仍未推送到 `origin/feature/push-to-talk`。

## 当前边界

- `npm test` 已通过，包含按住说话、VAD、音效时序和音频恢复测试。
- `artifacts/` 仍是未跟踪目录，未纳入提交。
- 不能据此推出桌面端快捷键、音效和真实录音听感已验收。
- `dist/` 与 `src/` 的发布路径仍需单独构建和重开桌面 App 验证；该操作涉及真实桌面环境，需明确授权后执行。
