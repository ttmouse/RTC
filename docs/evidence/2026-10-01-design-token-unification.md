# 设计 token 统一（字阶 / 间距 / 圆角 / 层级）验证证据

- Date: 2026-10-01
- Revision: 工作区未提交（改动文件：`src/css/style.css`、`src/js/main.js`、`docs/design-rules/*`、`docs/product-rules/ui-interaction-spec.md`）
- Environment: macOS 桌面端仓库；`check:ux` 走本机 Playwright chromium（4 场景 × 3 视口 × 2 标签）
- Scope: `src/css/style.css` 全部 897→约 960 行；`src/js/main.js` 一行；不含 `meeting-board/`（白板独立外观，待裁决 D-1）

## 改了什么

| 项 | 前 | 后 |
|---|---|---|
| 颜色 token | 8 | 11（补 `--seal-light`、`--ink-hover`、`--ok`） |
| 字阶 | 0 token / 12 档裸 px / 99 处声明 | 8 档 `--fs-*`，99 处全走 token，真改值 7 处 |
| 间距 | 0 token / 25 档 / 约 250 处 | 13 档 `--sp-*`，48 处各动 1–4px |
| 圆角 | 2 token + 2/6/8/10px 裸值 | 4 档 + 胶囊，裸值 0 |
| 层级 | 0 token / 阶梯与文档不符 | 8 档 `--z-*`，电平尺内部 1/2/3 不并入 |
| 死引用 | `--seal-light` 从未定义（3 处靠 `var(..., fallback)` 兜底） | 已定义，3 处改回引用 |
| `:root` 外非派生色值 | 17 处 hex | **0 处**（余 30 处全为已有 token 的透明度变体与遮罩类） |

## 检查结果

| 检查 | 结果 | 证据 |
|---|---|---|
| 自动测试 | **pass** | `npm test`（exit 0）：check-docs 43 文件无断链；check-static 22 模块 / 26 样式表通过；13 组测试全绿 |
| 静态 CSS 结构 | **pass** | `node scripts/check-static.mjs` → `static checks passed ... 26 stylesheets`（括号配对、游离声明块检查覆盖 `src/css/style.css`） |
| 界面几何与对比度 | **pass** | `npm run check:ux` → `跑了 36 个组合（4 场景 × 3 视口 × 2 标签）／没发现机械可判定的界面毛病` |
| 名字体检 | **pass** | `npm run check:js` → 22 个前端模块无 TS2304/2552/2305/2614 |
| 桌面端路径 | **not run** | 未启动 Tauri 桌面端；改动未在真机 WKWebView 里目检 |

## 未验证与已知风险

- **真机目检未做**（治理 §3 A 级门禁要求「真机看过主界面」）。具体需要人眼确认的点：
  - 窄屏（≤640px）图表轴标签由 8px 提到 10px，`.stats-hour-value` 有 `overflow:hidden`，三位数时**可能被裁**；
  - 48 处间距各动了 1–4px，逐条不可见，但整体松紧度需要看一眼；
  - 更新提示条由黄色系改为纸墨（`--paper-2` + `--rule` + `--ink`，安装按钮墨底纸字），**这是本轮唯一明显改变外观的地方**，需确认"存在感是否还够"；
  - 错误条 `#err` 底由 `#f3e3dc` 改为 `--seal-light`（半透明叠纸），比原来略深。
- **没有视觉回归基线**：仓库没有截图对比，`check:ux` 只判几何/对比度是否越界，判不了「好不好看」。
- **改动混在脏工作区里**：动手时已有 72 个文件被其他会话改过（含 `src/css/style.css`、`src/js/main.js`），本次改动**未单独提交**，回退需按 hunk 挑，不能整文件 checkout。
- 白板 `meeting-board/src/style.css` 未动（75 处写死颜色、0 共享 token），仍是待裁决 D-1。
- 新的待裁决项：列表行「复制成功闪底」用了印章红，与 §1 红色稀缺律（只给四处）冲突 → governance.md §4 的 D-7。
