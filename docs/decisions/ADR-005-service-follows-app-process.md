# ADR-005: 后端与识别服务跟随 App 进程生命周期，窗口开关不改变服务存活

- Status: accepted
- Date: 2026-09-30
- Owner: RTC maintainer
- Scope: Tauri 壳 ↔ Node 后端（8931）↔ 本地识别（8932/8933）的进程托管

## 背景

Tauri 壳在 `setup` 里把两个 sidecar（`node-server` 后端、`asr-server` 本地识别）各拉起一次，句柄存在 `AppState` 里。除此之外没有任何看护。

2026-09-30 实测：后端 sidecar 在 21:55 消失，主进程还活着。界面只剩「无法连接到本地代理服务 `ws://127.0.0.1:8931`」，自动重连全部被拒；此后 11 分钟的语音一条都没落盘。系统里没有该进程的 crash report、没有信号记录、也没有它的 stderr（打包后的 `.app` 从访达启动时没有 stderr 通道），所以死因无从查证。

同一次排查还暴露两条确定的结构性缺陷：

1. `WindowEvent::CloseRequested` 不区分窗口，一律 `cleanup` 掉全局的 node/asr sidecar。会议白板是独立窗口（`label = meeting-board`，由 `src/js/main.js` 用 `new WebviewWindow` 打开），于是「看完白板顺手关掉那个小窗口」就会把整个后端和本地识别一起端掉。
2. 后端没有看护，也没有「重启服务」入口；本地识别至少有 `restart_local_asr` 命令。sidecar 一旦退出，用户唯一的出路是退出重开 App。

约束：8931 的 node 服务是页面、API 与 ASR 代理的统一入口（见[系统架构](../architecture/README.md)的不变量），本地识别可用性同时依赖代理与模型服务；界面状态必须反映真实链路，不能显示假状态（[产品原则 3](../product-rules/core-product-principles.md)）。

## 决定

1. **窗口关闭不再停服务。** `CloseRequested` 只保存窗口尺寸。服务的终止只发生在 App 真正退出时（`RunEvent::ExitRequested` / `Exit` → `cleanup_all_servers`）。
2. **后端跟随 App 进程存活。** 新增看护线程，以「8931 端口通不通」为判据：端口没了就重新拉起 sidecar，失败按 3s→6s→12s→…→30s 退避，连续成功即复位。退出流程先置 `shutting_down`，看护见到标志即停止，避免「App 已退出、8931 还占着」。
3. **sidecar 输出落盘。** 两个 sidecar 的 stderr 除原有的内存环形缓冲（`asr_log`，供设置页翻译成人话）之外，同时写入数据目录 `logs/` 下的 `node-sidecar.log` / `asr-sidecar.log`，单文件上限 2MB 后轮转一份 `.1`。

边界：看护只补「本机 8931 没人监听」这一种情况。端口被别的程序永久占用时退避到 30 秒重试、把原因写进日志，不做静默谋杀（沿用 `server.js` 的 EADDRINUSE 报错策略）。

## 考虑过的替代方案

- **只做「关窗口不杀服务」，不加看护** — 修掉当晚最可能的那条路径，但 sidecar 一旦因别的原因（OOM、未捕获异常、外部清进程）退出，用户仍然只能重启 App；缺陷 2 原样保留。
- **看护判据用子进程 `try_wait()` 而不是端口** — 只能发现「自己启动的那个句柄还在不在」。句柄丢失、进程被外部杀掉、或 dev 模式下服务由别处提供时都会漏判。端口判据天然覆盖这些情况，且不与用户自己在终端跑的服务打架。
- **给后端也加一个界面上「重启服务」按钮，替代自动看护** — 把恢复动作推给用户，且要新增 UI 与状态来源（可能引入假状态）。自动看护在用户无感知的情况下就已恢复；按钮留作后续，若看护连续失败再补。
- **窗口关闭时按 label 区分，主窗口才清理** — 保留了「关主窗口就停服务」的旧语义。但 tray 图标常驻时用户可能只是想收起主界面，此时停掉后端会制造新的一类「打开界面却没有服务」。让服务跟随进程而不是窗口，规则更少。

## 后果

- 关白板窗口不再中断录音与转写；关主窗口/⌘Q 仍会干净地停掉全部 sidecar。
- 后端意外退出时数秒内自愈，用户最多感到界面短暂「未连接」后恢复。
- 多一条常驻线程（每 3 秒一次端口探测，无端口时退避），以及数据目录下两个日志文件。
- 死因可查：下一次 sidecar 异常退出时，`logs/` 下有它的最后遗言和文件 mtime。
- 未覆盖：看护不会区分「后端崩了」与「用户有意用别的程序占了 8931」，只保证不静默抢占。

## 验证与链接

- 规则：[产品原则 3 状态唯一来源](../product-rules/core-product-principles.md)｜[系统架构不变量](../architecture/README.md)
- 实现：`src-tauri/src/lib.rs`（`spawn_node_watchdog`、`open_sidecar_log`、`cleanup_all_servers`、`on_window_event`）
- 证据：`tests/sidecar-lifecycle.test.mjs`（静态守卫，已证明会变红）｜[UX-18](../product-rules/ux-issue-log.md)
