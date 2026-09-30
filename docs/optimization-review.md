# 优化审查记录

> 本文档由 ZCode 定时优化审查任务自动维护：定期扫描近期改动，聚焦最近修改的文件输出有代码依据的优化点。已有条目不重复记录，修复后请在对应条目标注「已修复（日期）」。

最近更新：2026-09-29 11:04

## 2026-09-29 11:04

本轮范围：新增的 scripts/board-provenance.cjs（白板人工锚点契约唯一正本，120 行）、tests/board-human-content.test.mjs 及 project-ledger 台账记录 D-016/E-010（上轮 git status 清单截断漏审的文件）。整体质量较高：多重集合语义清晰，server.js 合并方式（server.js:1407-1408、1419-1420 先展开旧对象、仅在有值时写 agentDocumentAt）正确履行了「用户保存保留原值」的契约，测试覆盖扎实。

- [低] scripts/board-provenance.cjs:42-53 — `humanLines` 的顺序遵循锚点数组顺序，而非文件头注释承诺的「正文原有顺序」
  证据：`boardProvenance`（94-109 行）中 `humanLines = anchorsIn(anchors, lines)`——`anchorsIn` 按 anchors 数组顺序输出幸存行；写侧 `updateBoardProvenance` 第 86 行 `surviving.concat(added)` 中 surviving 也沿用旧锚点顺序。用户在编辑器里调换两行人工内容的顺序后（prev [A,B] → next [B,A]），锚点仍是 ["A","B"]，`humanLines` 顺序与正文不再一致。而文件头第 90 行注释明确承诺「humanLines / aiLines 都按正文原有顺序给出」——`aiLines`（103-107 行按 lines 顺序遍历）满足，`humanLines` 不满足。
  为什么改：brief 输出把 `humanLines` 渲染为「人工锚点」清单（meeting-board.mjs:266、373），顺序与正文错位会让外部 AI 交叉对照时产生轻微误导；该文件自我定位是唯一正本、注释即契约，契约与实现不符是后续误用的温床。
  怎么改：要么让读侧按正文顺序过滤锚点（`boardProvenance` 场景遍历 lines 而不是 anchors），要么修正注释明确「humanLines 按锚点记录顺序、aiLines 按正文顺序」。写侧的 `anchorsIn` 用途（多重集合成员判定）顺序无关，可保留原实现另拆变体。

## 2026-09-29 03:09

本轮范围：git 未提交改动（asr_local/server.py、src/js/pastebadge.js、package.json、scripts/build-sidecar.sh、src-tauri/src/lib.rs 等近期触碰的源码）。

- [中] asr_local/server.py:763-770 — 按住说话分支先累加人声证据、后调 `_reset_segment_metrics()`，段首帧的证据被自己刚写的复位清零
  证据：`if rms >= self.rms_threshold:` 下累加 `seg_active_ms/seg_rms_sum`（763-768 行），紧接着 `if not self.in_speech:` 内 `self._reset_segment_metrics()`（770 行）把刚累加的字段全部归零。每段第一帧（`VAD_FRAME`=512 样本=32ms）的贡献被抹掉，`MIN_VOICE_EVIDENCE_MS=64` 的闸门实际变成 ~96ms。
  为什么改：与注释声明的 64ms 人声证据语义不符；恰好说了约 64ms（两帧过阈值）的最短发音会被误判为空按丢弃。新测试 `tests/manual-hallucination.test.mjs` 的 100ms 用例正好压线通过，掩盖了这个偏差。
  怎么改：把复位块挪到累加之前（先复位再统计本帧），并补一条 64ms 音源不被丢弃的行为测试。

- [中] src/js/pastebadge.js:165 — 缓存 key 的分隔符是一个裸 NUL 字节，源文件里混入不可见控制字符
  证据：hexdump 该行为 `28 27 00 27 29`，即 `join('<NUL>')`——引号之间是 NUL 不是空格；`file` 因此把该文件识别为 "data"，`grep` 不加 `-a` 搜不到该文件任何内容。本轮 diff 里这行显示成 `join(' ')`，肉眼和审查完全看不出。
  为什么改：功能上暂时没问题，但任何编辑器/工具对文件做规范化（去控制字符）后分隔符会悄悄消失，`join('')` 会把多段身份拼接成碰撞的 key；且此文件从此对常规检索工具不可见，排查成本高。
  怎么改：写成显式转义 `join('\u0000')`（语义不变、源码可读可搜），或用可见分隔符。

- [中] package.json:11 — test 脚本 997 字符，11 个测试文件逐个手工串接，新增测试必须改这一长行
  证据：`"test"` 把 `node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON` 前缀重复 11 次逐个列出 tests/ 下的文件；本轮加 manual-hallucination 正是又一次手工追加。
  为什么改：漏登记一个测试文件不会报错，只会让该测试静默不跑——保护失效且无感知；前缀重复也让 diff 噪声大。
  怎么改：加 `scripts/run-tests.mjs`，用 `fs.readdirSync('tests').filter(f => f.endsWith('.test.mjs'))` 顺序 spawn（`search-toggle.browser.mjs` 命名不以 `.test.mjs` 结尾，天然排除），统一带上 `--disable-warning` 参数；`"test"` 收敛为三个入口。

- [低] scripts/build-sidecar.sh:97-101 — node-server 签名自检发现无效只警告不拦截，与脚本自己文档化的「必死」结论矛盾
  证据：`if ! codesign -v "$NODE_OUT"` 失败分支只 echo 警告就继续；而脚本第 30-38 行注释明确写着无效签名会被 macOS 26+ AMFI 加载即 SIGKILL、「codesign 也救不回来」。
  为什么改：这是构建期能确定性拦下的致命项，放过去等于把「打包成功、装机必挂」留到用户手上才发现。
  怎么改：验证失败时 `exit 1`；如需本地跳过，提供显式环境变量开关（如 `SIDECAR_ALLOW_BAD_SIGN=1`）并在输出里说明。

- [低] src-tauri/src/lib.rs:359-386 — install_key_tap 失败路径不一致：tap 建不起来泄漏 user_info，线程起不来时留下无驱动的死 tap
  证据：`Box::into_raw(Box::new(app.clone()))`（359 行）在 `tap_create` 失败返回 false（369-371 行）时永不回收；线程 `spawn` 失败（382 行）时 `KEY_TAP_PORT.set`（374 行）已写入句柄但该 tap 没有 run loop source 驱动，install() 却返回 false 走 NSEvent 退路。另见 374-375 行同一句柄克隆两次。
  为什么改：都是启动期一次性的小泄漏/死状态，不影响正确性，但失败分支的隐性状态会让后续维护者误判 tap 在工作。
  怎么改：`tap_create` 失败分支用 `drop(unsafe { Box::from_raw(user_info) })` 收回；`KEY_TAP_PORT.set` 挪到线程 spawn 成功之后（省掉两次 clone）；spawn 失败分支在注释里说明句柄随进程回收。
