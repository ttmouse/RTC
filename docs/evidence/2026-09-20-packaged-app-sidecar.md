# 打包版 App 的两个 sidecar 坑（签名 / 版本落后）验证证据

- Date: 2026-09-20
- Revision: 工作区未提交改动（基于 `3623308`）
- Environment: macOS 27.0（26A428，arm64）；bun 1.3.13；pyinstaller（Homebrew python3.14）；tauri-cli 2.11.4；未干预用户正在使用的 App
- Scope: 打包后 `.app` 的两个后端进程（node-server、asr-server）能否启动、能否与新前端协议对上

## 坑一：node sidecar 签名（症状：历史记录一片空白）

用户报告：打包后的 App 启动后拿不到历史记录。实测 `lsof -nP -iTCP:8931` 无监听——后端 sidecar 根本没起来。

根因（`log show` 内核日志）：

```
AMFI: '/private/tmp/ns-new' has no CMS blob?
AMFI: '/private/tmp/ns-new': Unrecoverable CT signature issue, bailing out.
CODE SIGNING: cs_invalid_page(...): ... denying page sending SIGKILL
```

`bun build --compile` 产物只有 linker 签名、没有 CMS blob，macOS 26+ 的 AMFI 在加载时直接 SIGKILL，
进程 `Killed: 9`、零输出、不绑端口。该产物也无法事后补救：`codesign --force --sign -` 报
`main executable failed strict validation`，`codesign --remove-signature` 报
`internal error in Code Signing subsystem`。同一批 sidecar 里的 asr-server（pyinstaller，签名有效）
能正常启动，所以现象是「窗口开着、模型服务在、后端 8931 是死的」。

## 坑一的检查结果

| 检查 | 结果 | 证据 |
|---|---|---|
| 旧 sidecar 能否运行 | fail | 直接执行 `src-tauri/binaries/node-server-aarch64-apple-darwin` → `Killed: 9`；`codesign -v` → `invalid signature` |
| bun 编译产物是否普遍如此 | fail | 最小复现：`bun build --compile hello.js` 产物同样 `Killed: 9`（排除是本仓库 server.js 的问题） |
| 新方案 sidecar 能否运行 | pass | `Contents/MacOS/node-server Contents/Resources/server.bundle.js`（bun 官方运行时 + bundle JS，`RTC_DATA_DIR=/tmp/rtc-sdtest`）→ 8931 监听，`/api/status` 返回 `{"ok":true,...,"version":"1.0.35"}` |
| 新 sidecar 签名 | pass | `codesign -v` 通过；`Identifier=bun TeamIdentifier=7FRXF46ZSN`（官方公证签名保留） |
| 打包产物完整 | pass | `cargo tauri build` 生成 `.app`/`.dmg`/`.app.tar.gz`；`Contents/Resources/` 含 `server.bundle.js` 与 `package.json` |
| 自动测试 | pass | `npm test`：51 passed, 0 failed |
| 文档与链接 | pass | `npm run check:docs` |

## 坑二：asr-server sidecar 版本落后（症状：按住说话自己收尾）

用户配置为本地引擎（`engine=sensevoice`）+ 按住左 Option 说话（`pushToTalk=true`）。打包时 `asr-server` 是 **09-15 10:23** 编译的，而 `asr_local/server.py` 此后在 09-19（`b7dace7`）与 09-20（`8096ad8`）各有改动，其中 `8096ad8` 才加入 `push_to_talk` / `set-manual-segment` / `flush-segment`。旧服务不认识这些控制消息，于是按住期间仍按 `silence_cut_ms`（用户配置 500ms）自动断句——手没松，这一句已被收尾。

证据（源码比对，未跑音频回放）：

- `git show 8096ad8^:asr_local/server.py` 的 `handle_json` 只有 `run-task` / `finish-task` 两个分支，未知 action 静默忽略。
- 当前版本的 `asr_local/server.py` 才有 `set-manual-segment` 与 `flush-segment`；且静音超时只在 `not self.push_to_talk` 时生效（`server.py` 的 VAD 分支）。

处置：`npm run build:sidecar` 用当前源码重建两个 sidecar（asr-server 09-20 23:27），重新打包后用户复测正常。

| 检查 | 结果 | 证据 |
|---|---|---|
| 重建后的 asr-server 签名 | pass | `codesign -v` 通过（pyinstaller 自己 re-sign） |
| 重建后的 asr-server 进入打包产物 | pass | `.app/Contents/MacOS/asr-server` 与 `src-tauri/binaries/asr-server-aarch64-apple-darwin` sha1 一致 |
| 用户实机按住说话 | pass | 用户复测：“目前测下来应该可以了” |
| 打包产物完整（含 dmg） | pass | `cargo tauri build` 两个 bundle 均成功（updater 私钥缺失的报错是既有状态） |

## 未验证与已知风险

- **没有在真实 App 里逐帧比对按住说话的断句行为**：结论来自源码比对 + 用户复测，没有用合成音频回放做自动化复现。
- 用户机器上装的是 09-20 23:28 那次 build 的 `.app`（与最新一次 build 源码一致，仅重新链接）；未强制替换成 23:29 那次产物。
- 用户当时正在使用的旧 App 进程未由本次改动干预；打包覆盖了磁盘上的 `.app`，已请用户自行退出并重开。
- `bun` 官方运行时的 Team 签名依赖 Tauri 不重签 sidecar；若将来引入签名身份（`signingIdentity` / 公证），需重新确认 sidecar 签名未被覆盖。
- sidecar 体积与旧的 `--compile` 产物相同（约 60MB），没有额外膨胀；但没有测量冷启动时间差异。
