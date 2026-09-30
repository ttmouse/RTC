# 按住说话「空按」过滤的验证证据

- Date: 2026-09-20
- Revision: 工作区未提交改动（基于 `3623308`）
- Environment: macOS 27.0（26A428，arm64）；Homebrew python3.14 + numpy；打包与真机复验同晚进行
- Scope: 用户没开口却按了快捷键时，本地识别（`asr_local/server.py`）会不会把静音送进模型并上屏

## 问题与判据

用户记录里连续出现 `Okay.` / `The.` / `I.` 这类英文（`events/2026-09-20.jsonl`，`engine=sensevoice`），
来源是按住说话的空按：修之前 `feed_audio` 在 `push_to_talk` 分支不看 RMS、每帧直接进缓冲，
`flush_segment` 也只用 `buffered_ms > 0` 当门槛。

修法：按住期间照旧每帧进缓冲（不切句），但统计「超过阈值帧的累计时长」；
松手时不足 `MIN_VOICE_EVIDENCE_MS`（默认 64ms = 2 帧）判为空按，整段丢弃。

## 检查结果

| 检查 | 结果 | 证据 |
|---|---|---|
| 按住不开口不上屏 | pass | `tests/manual-hallucination.test.mjs`：1 秒静音 → 无 `result-generated` |
| 极短脉冲不上屏 | pass | 同上：单个 32ms 高幅脉冲 → 无结果 |
| 正常说话不被吞 | pass | 同上：500ms / 100ms 正弦 → 各 1 条结果 |
| 静音证据不串段 | pass | 同上：静音 400ms + 说话 400ms → 只有 1 条结果 |
| 常态录音未受影响 | pass | 同上：静音丢弃、700ms 说话通过 |
| 检查会变红 | pass | 把判据临时改成恒真 → 两条空按用例 `✗`、退出码 1；还原后退出码 0 |
| 全量自动测试 | pass | `npm test`：53 passed（`push-to-talk` 组）+ 13 passed（`vad` 组）+ 新组 7 项，0 failed |
| 文档门禁 | pass | `npm run check:docs` |
| 打包产物含新识别服务 | pass | `build:sidecar` → `cargo tauri build`；`.app/Contents/MacOS/asr-server` 与 `src-tauri/binaries/asr-server-aarch64-apple-darwin` sha1 一致（`23a2d8b6…`） |
| 用户实机复验 | not run | 待用户重启新包后按住不开口试一次 |
| 打包前拦截 sidecar 过期 | pass | `scripts/check-sidecar-freshness.mjs`（挂进 `npm run build`）：把 asr-server 时间拨旧 → 报错退出 1；恢复 → 退出 0 |

## 未验证与已知风险

- 测试用的是合成音频（正弦 + 数字静音），**不是用户麦克风的真实底噪**：阈值 `0.0015` 若低到让环境噪声也过线，空按仍可能漏过。这一档靠实机复验。
- 只覆盖本地引擎（`sensevoice` / `qwen3`）。百炼走 `finish-task`，服务端 VAD 在云端，本次改动不涉及。
- `MIN_VOICE_EVIDENCE_MS=64ms` 是估计值：能挡住掐头去尾的空按与单帧脉冲，但没有在真实轻声说话上校准过误杀率。
