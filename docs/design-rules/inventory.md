# 设计元素盘点

**快照日期**：2026-09-20 ｜ **对应版本**：v1.0.35 ｜ **口径**：`src/index.html`、`src/css/style.css`、
`src/js/*.js` 动态生成的元素、`src/js/tray.js` 与 `src-tauri/src/lib.rs`（菜单栏）、
`meeting-board/`（独立表面）。

这份文件回答「界面上到底有哪些元素、各自归谁管、有没有偏离规范」。
它**不是规则**（规则在 [DESIGN.md](DESIGN.md)），
也可能随代码过期——改完界面后重新跑一遍文末的提取命令即可。

> **本轮没跑成的检查**：`npm run check:ux`（真浏览器量几何与对比度）在 2026-09-20 这次盘点
> 未运行成功——本机缺 Playwright 的 chromium headless shell（报
> `Executable doesn't exist at …/chromium_headless_shell-1200/…`）。
> 需要时跑 `npx playwright install chromium` 补上。
> 因此本文里的对比度数字（3.13:1 / 2.42–3.10:1）**引的是 2026-09-17 那次实测**
> （见 [UX-3](../product-rules/ux-issue-log.md)），不是本轮重量的。

## 快照一览

| 表面 | 实现入口 | 外观归属 |
|---|---|---|
| 主界面 | `src/index.html` 前半 + `src/css/style.css` | 纸和墨（正本） |
| 设置页 | `#settingsPage`（整页覆盖） | 同上 |
| 语音指令页 | `#cmdPage`（整页覆盖，与设置同形态） | 同上 |
| 统计页 | `#statsPage`（整页覆盖） | 同上 |
| 纠错规则模态框 | `.modal-overlay` | 同上 |
| 菜单栏 | `src/js/tray.js` + `src-tauri/src/lib.rs` | 自有一套（登记例外） |
| 会议白板 | `meeting-board/`（独立 HTML 入口） | 独立外观（**待裁决**，UX-3/UX-4） |

规模：静态元素 111 个 id、104 个 class；`style.css` 454 条规则、384 处 `var(--…)`。

---

## 1. 主界面

### 1.1 顶栏

| 元素 | 实现 | 数值与 token | 规范依据 |
|---|---|---|---|
| 标题 | `header h1` | `16px` / `700` / `letter-spacing .12em`、`--ink` | DESIGN.md §2 |
| 六个图标入口 | `#searchBtn` `#statsBtn` `#shareBtn` `#cmdBtn` `#meetingBoardBtn` `#settingsBtn` | 内联 SVG `24×24 viewBox` → 渲染 `17×17`、`stroke-width:2`、`padding 5px`、圆角 `--radius` | P5：六者共用四段规则，新增入口必须并进去 |
| 图标悬停 | 同上 | 底 `--paper-2`、色 `--ink`（**不占红**） | DESIGN.md §1 的例外 |
| 图标聚焦 | 同上 | `outline: 2px solid var(--seal)`、`offset 2px` | 全站 23 处一致 |
| 统计入口的今日条数 | `#statsBtn` 内文本 | `11px`、`tabular-nums` | DESIGN.md §2 |

### 1.2 推荐浮层 `#sharePopover`

| 元素 | 实现 | 数值 | 备注 |
|---|---|---|---|
| 遮罩 | `.sharePopover-overlay` | `rgba(0,0,0,.35)` | 非 token（遮罩类，见偏差 B3） |
| 面板 | `.sharePopover-panel` | `--paper` 底 + 阴影 | 纸色，符合正本 |
| 关闭 | `#sharePopoverClose` | 图标按钮 | — |
| 条目 | `.sharePopover-item` | `:active rgba(26,22,17,.08)`、`.copied rgba(191,58,30,.06)` | 「已复制」用印章红浅底 |

### 1.3 更新提示条 `#updateBanner`（**规范外配色**）

| 元素 | 实现 | 颜色 | 备注 |
|---|---|---|---|
| 条体 | `#updateBanner` | 底 `#fff7e0`、描边 `#e8c96a`、字 `#7a5b00` | 一整条黄色系 |
| 立即更新 | `#updateInstallBtn` | 底 `#b8860b`、字 `#fff` | — |
| 关闭 | `#updateBannerClose` | `#a08a4a` | — |
| 进度条 | `.update-progress-track` / `-fill` / `-text` | `#e8c96a` / `#b8860b` / `#a08a4a` | — |

**这是本次盘点新发现的第二个事实上的强调色**（与白板的 `#c9a227` 同类），此前未登记。

### 1.4 搜索栏 `#queryBar`

| 元素 | 实现 | 备注 |
|---|---|---|
| 容器 | `#queryBar` | 默认 `display:none`，`body.search-open` 打开（不是删除） |
| 输入框 | `#searchInput` | `type=search`，带 `aria-label` |

### 1.5 历史列表

| 元素 | 实现 | 数值与 token | 规范依据 |
|---|---|---|---|
| 列表容器 | `main#list` | 内阴影 `inset …rgba(212,203,182,.6)` | — |
| 记录行 | `.line`（`history.js` 生成） | 悬停 `rgba(26,22,17,.04)` | P4：悬停色块要托住内容 |
| 正文 | `.line .txt` | `15px / 1.7`、`--ink` | DESIGN.md §2 |
| 时间分隔条 | `.timeSep` | 居中、`11–12px` | 微信式分组规则（`ui-interaction-spec` §2） |
| 日期分隔 | `.daysep` | `10–11px`、`--ink-faint` | 同上 |
| 空态 | `.empty`、`#listHint` | `--ink-faint` on `--paper` = **3.13:1** | **未达 P7 的 4.5:1**（UX-3） |
| 去向徽标 | `.pasteBadge` / `.pasteBadgeName` / `.pasteDoneIcon`（`pastebadge.js`） | 应用图标 + 名称 | 逐条标注去向（`ui-interaction-spec` §2） |
| 回到最新 | `#jumpBottom` | 底 `rgba(26,22,17,.14)`、悬停 `.07` | 浮出阈值见附录 |

### 1.6 电平尺（一层最容易改坏的组件）

| 元素 | 实现 | 关键约束 |
|---|---|---|
| 尺子容器 | `.meterRow` / `#levelMeterBlock` | 拖动时挂 `.dragging` 收起提示 |
| 实时条 | `#levelMeterBar` | **禁止 `transition: width`**（P6）；染色跟 `meter.tone`，带 `TONE_HOLD_MS=220` |
| 峰值轨迹 | `#levelMeterPeak`、`#levelMeterPeakCap` | `rgba(26,22,17,.26)`；`z-index:1` |
| 刻度（覆盖前） | `#levelMeterTick` | 深红；`z-index:2` |
| 刻度（覆盖后反白） | `#levelMeterTickInv` | 纸色反白，写在条内部靠 `overflow:hidden` 裁切 |
| 读数 | `#meterReadout` | `--ink-faint`、等宽数字；**3.13:1**（UX-3 同类） |
| 状态区 | `#status` / `#statusText` / `#statusTime` / `#dot` | 点三态：空闲 `--ink-faint` / 录音中 `--seal` + 光晕 `rgba(191,58,30,.2)` / 异常 `--seal-deep` |

### 1.7 底部操作区

| 元素 | 实现 | 数值与 token |
|---|---|---|
| 录音主按钮 | `#btn` | 悬停 `#2d271f`（墨色变体，非 token） |
| 引擎胶囊 | `#engineBadge` + `.caret` | `min-height:46px`、`border-radius:999px`、`--rule` 描边 |
| 引擎下拉 | `.engineMenu` / `.engineOption` | 阴影 `rgba(0,0,0,.22)`；**禁原生 `<select>`** |
| 三个开关 | `#ftPaste` `#ftEnter` `#ftCommand`（`.footerToggle`） | 高度/内距/圆角/字号与引擎胶囊严格对齐 |
| 悬浮提示 | `[data-tip]::after` | 底 `rgba(26,22,17,.18)`；用了 `data-tip` 不许再设 `title` |

### 1.8 全局反馈与浮层

| 元素 | 实现 | 数值 | 备注 |
|---|---|---|---|
| Toast | `#err` | 底 `#f3e3dc`（淡红）、5s 自动消失 | 单一 Toast 容器，不要新建 |
| 应用右键菜单 | `.appContextMenu` / `-Title` / `-Copy` / `-Check` | 阴影 `rgba(26,22,17,.16)` | 记录行图标上的菜单 |

---

## 2. 设置页 `#settingsPage`

| 组件 | 元素 | 数值 / 状态 |
|---|---|---|
| 页头 | `.settingsPageHeader` + `#settingsClose` | 与指令页、统计页同形态 |
| 识别方式（三选一） | `#optBailian` `#optSensevoice` `#optQwen3`（`.engineOption`） | 每组下方挂自己的配置 |
| 模型状态 | `.model-download-btn`、`.model-env-warning` | 缺依赖时给出安装指引 |
| 服务异常块 | `.model-service-down` + `.msd-title/-desc/-reason/-actions/-state/-log` | 「模型服务未启动」的解释与恢复入口（UX-11/12） |
| 拾音参数 | `#silenceTimeout`、`#gainMultiplier`（`range`） | 缩略块 `rgba(0,0,0,.15)` |
| 按住说话 | `#pushToTalkEnabledToggle`（`.settingsToggle`）、`#pushToTalkShortcutBtn`（`.shortcut-record-btn`） | 滑块 `#fff`；录制中 `rgba(191,58,30,.12)` |
| AI 服务商 | `#aiGroupHead`（`.sg-head`）、`#aiProvider`（**唯一保留的原生 `<select>`**）、`#aiBaseUrl` `#aiApiKey` `#aiModel`、`#aiApiKeyToggle`（`.key-eye`）、`#aiTestBtn` | 输入聚焦 `rgba(191,58,30,.12)` |
| 测试结果 | `.key-test-status.ok` | **`#3f6f4f` 成功绿——未登记的状态色** |
| 存储 | `.storage-path`（`#storageEvents` `#storageCommandsFile`）、`#clearDataBtn` | 「在访达中显示」走自定义命令 |
| 检查更新 | `#checkUpdateBtn` | `.sbtn` |
| 应用名单 | `.app-rule-row` / `.app-rule-name` / `.app-rule-empty` | 自动粘贴/自动发送名单 |
| 固定底栏 | `.s-page-foot` + `#settingsSaveBtn`（`.primary`）`#settingsCancelBtn` `#settingsResetBtn`（`.danger`） | `primary:hover #2d271f`、`danger:hover rgba(191,58,30,.08)` |

## 3. 语音指令页 `#cmdPage`

与设置页同一形态；三条分区（说法 / 动作 / 片段）各带 `.cmdAddBtn`；行内 `.cmdEditRow`、`.cmdInput`、
`.cmdValueIn`、`.cmdPhraseIn`、`.cmdDelBtn`、`.cmdIconBtn`、`.cmdArrowTxt`、`.cmdEmpty`；
应用选择器 `.cmdPicker` / `-List` / `-Search` / `.cmdPickRecord` / `.cmdPickNone`；
页脚 `#cmdAgentPrompt`（`.cmdFootNote`）+ `#cmdPageSave` / `#cmdPageCancel` / `#cmdPageReset`。

## 4. 统计页 `#statsPage`

`.statsMetric`（3 个指标块，底 `rgba(236,228,212,.58)`）、
日分布 `.stats-day-chart` / `-scroll` / `-col`、小时分布 `.stats-hour-chart` / `-col` / `-label` / `-value` /
`-bar-wrap`、条形 `.stats-bar-row` / `-label` / `-track` / `-value`、空态 `.stats-empty`。

## 5. 纠错规则模态框

`.modal-overlay`（`rgba(0,0,0,.35)`）/ `.modal-box` / `.modal-close` / `#correctionRules`（textarea）/
`.modal-foot` + `#corrSave`（`.primary`）/ `#corrReset`（`.danger`）。可访问性：模态框关闭键需可点。

## 6. 菜单栏（登记例外）

| 元素 | 值 | 来源 |
|---|---|---|
| 待命 / 静音 / 说话中 / 麦克风异常 / 服务异常字形 | 五张 `36×36` 模板图（渲染 `18×18pt`） | `src-tauri/icons/tray/` |
| 说话中底色胶囊 | `#FF9230`，圆角 = 高度一半 | `src/js/tray.js` |
| 异常红 | `#D93025` | 同上 |
| 格子宽度 | `28pt` | `TRAY_SLOT_WIDTH`（Rust） |

## 7. 会议白板（独立表面，待裁决）

不逐元素展开：它是独立入口与独立样式表，颜色全部写死（89 处）、0 处共享 token，
含第二个强调色 `#c9a227`。现状与待裁决点见 [DESIGN.md §5-C](DESIGN.md) 与 UX-3 / UX-4。

---

## 全局统计（快照）

| 指标 | 值 |
|---|---|
| `style.css` 规则数 | 454 |
| `var(--…)` 使用 | 384 处 |
| 颜色字面量（`:root` 外） | 25 处，其中墨色透明度变体居多 |
| 字号档位 | 8 / 10 / 11 / 12 / 13 / 14 / 15 / 16 / 18 / 20 / 22 / 30px（12 档） |
| 圆角档位 | `--radius 4px`、`--radius-sm 3px`、2 / 6 / 8 / 10px、`999px` |
| 动效时长 | `.12s`–`.22s` 为主，`width .3s` 用于尺寸变化 |
| 图标 | 内联 SVG，0 emoji |

## 偏差清单

| # | 偏差 | 性质 | 处置 |
|---|---|---|---|
| B1 | 更新提示条整条黄色系（5 个色值） | **新的第二个强调色**，未登记 | → 待裁决 D-5 |
| B2 | `.key-test-status.ok` 成功绿 `#3f6f4f` | 状态色未登记（语义合理，但规范里没有） | → 待裁决 D-6 |
| B3 | 20+ 处墨色透明度变体 `rgba(26,22,17,x)`、遮罩 `rgba(0,0,0,.35)` | 未 token 化；**不影响视觉结果** | 可低风险收敛（Agent 可自行做） |
| B4 | `#err` 底 `#f3e3dc`、`#updateBanner` 底 `#fff7e0` 偏离 `--paper` | 语义色未登记 | 与 B1/B2 一并裁决 |
| B5 | 字号 12 档、圆角 7 档 | 未收敛 | 已在待裁决 D-3 |
| B6 | 空态与提示文字 3.13:1；白板 2.42–3.10:1 | 未达 P7 | 已在待裁决 D-2（UX-3） |
| B7 | 白板独立外观、第二个强调色 `#c9a227` | 待裁决 | 已在待裁决 D-1（UX-4） |
| B8 | 菜单栏橙底白柱约 2:1 | 已接受的取舍 | 已在待裁决 D-4 |

## 重跑方式

```bash
# 静态元素：可点控件与 id 清单
grep -oE '<(button|input|select|textarea|a)\b[^>]*>' src/index.html
# JS 动态生成的 class
grep -ohE "className ?= ?'[^']+'" src/js/*.js | sort -u
# token 使用率与颜色字面量
grep -c 'var(--' src/css/style.css
grep -oE '#[0-9a-fA-F]{3,8}' src/css/style.css | sort | uniq -c | sort -rn
# 真实几何与对比度（会起浏览器；本机需先 npx playwright install chromium）
npm run check:ux
```
