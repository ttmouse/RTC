# E-008：打包链路与空按过滤的验证证据

```json
{
  "id": "E-008",
  "kind": "evidence",
  "status": "active",
  "summary": "2026-09-20 打通打包链路：node sidecar 签名有效可启动、识别服务重建后按住说话恢复、空按过滤 7 项测试通过并证明会变红、打包前置自检能拦住过期 sidecar；用户实机只复验了「按住说话恢复」",
  "scope": [
    "docs/evidence/2026-09-20-packaged-app-sidecar.md",
    "docs/evidence/2026-09-20-manual-voice-evidence.md",
    "tests/manual-hallucination.test.mjs",
    "scripts/check-sidecar-freshness.mjs",
    "asr_local/server.py",
    "src-tauri/tauri.conf.json"
  ],
  "sources": [
    "docs/evidence/2026-09-20-packaged-app-sidecar.md",
    "docs/evidence/2026-09-20-manual-voice-evidence.md",
    "tests/manual-hallucination.test.mjs",
    "scripts/check-sidecar-freshness.mjs"
  ],
  "relations": [
    {"type": "validates", "target": "D-012"},
    {"type": "validates", "target": "D-013"},
    {"type": "validates", "target": "D-014"}
  ],
  "key": "packaged-backend-and-manual-voice-evidence-2026-09-20",
  "recorded_at": "2026-09-20",
  "verified_at": "2026-09-20"
}
```

## 结论边界

覆盖：node sidecar 换成 bun 运行时后能启动并能被 `codesign -v` 验证；识别服务用当前源码重建后
「按住说话自己收尾」消失；空按不再上屏（7 项用例，且把判据改成恒真后两条空按用例变红、退出码 1）；
打包前置自检在产物被拨旧时报错退出 1、时间戳恢复后放行；`npm test` 全绿；`npm run check:docs` 通过。

未覆盖：真实麦克风底噪下的空按表现（测试用的是合成静音与正弦）；打包前置自检只能证明时间关系；
自动更新链路；dmg 的签名与公证（一直未做）。

完整命令、观察结果与盲区见 `docs/evidence/2026-09-20-packaged-app-sidecar.md` 与
`docs/evidence/2026-09-20-manual-voice-evidence.md`。

用户实机复验状态：按住说话恢复正常——用户 2026-09-20 当晚确认「目前测下来应该可以了」；
空按过滤——替换新包后用户尚未回报结果（未运行）。
