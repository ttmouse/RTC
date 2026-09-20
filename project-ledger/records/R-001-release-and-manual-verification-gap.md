# R-001：源码、开发服务与发布产物存在验证分叉

```json
{
  "id": "R-001",
  "kind": "risk",
  "status": "active",
  "summary": "RTC 开发模式读取 src/，Tauri 打包使用 dist/；当前 dist 音效代码落后于 src，且桌面端人工听感未完成",
  "scope": ["src", "dist", "scripts/dev.mjs", "src-tauri/tauri.conf.json", "package.json"],
  "sources": [
    "scripts/dev.mjs",
    "src-tauri/tauri.conf.json",
    "package.json",
    "dist/js/sfx.js",
    "src/js/sfx.js",
    "project-ledger/records/E-005-current-worktree-verification.md"
  ],
  "relations": [
    {"type": "blocks", "target": "S-001"},
    {"type": "related_to", "target": "D-008"}
  ],
  "key": "rtc-source-dist-verification",
  "recorded_at": "2026-09-20"
}
```

## 事实

- `scripts/dev.mjs` 以 `RTC_DEV=1` 强制服务 `src/`，所以开发桌面端能看到源代码改动。
- `src-tauri/tauri.conf.json` 的 `frontendDist` 指向 `../dist`，打包版不会自动读取 `src/`。
- `dist/js/sfx.js` 仍引用旧的现场合成音逻辑；`src/js/sfx.js` 已使用 WAV 资源与录音上下文复用。
- `src/js/assets/speech_start.wav` 和 `speech_stop.wav` 当前存在，但尚未通过一次完整构建进入 dist。

## 风险与下一步

发布或验收打包版前必须：

1. 在确认构建脚本中的清理副作用后，重新生成 `dist/`；
2. 重开桌面 App，验证快捷键开始/松手停止/连续听写粘贴音；
3. 将人工结果写入新的 evidence 记录，不把自动测试绿灯当作听感验收。

当前不把 `npm run build` 视为已完成：该脚本包含清理 `dist` 的破坏性命令，尚未获得本次操作的明确确认。
