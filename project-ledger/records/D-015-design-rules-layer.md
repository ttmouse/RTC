# D-015：建立设计规则层（正本 / 原则 / 治理合同分家）

```json
{
  "id": "D-015",
  "kind": "decision",
  "status": "active",
  "summary": "新建 docs/design-rules/ 作为视觉与呈现的权威层：视觉正本、可判定的设计原则、治理合同分三份文件，并完成首份元素盘点（发现两条从未登记过的配色）",
  "scope": [
    "docs/design-rules",
    "docs/README.md",
    "AGENTS.md",
    "docs/product-rules/ui-interaction-spec.md"
  ],  "sources": [
    "docs/design-rules/README.md",
    "docs/design-rules/visual-language.md",
    "docs/design-rules/design-principles.md",
    "docs/design-rules/governance.md",
    "docs/product-rules/ui-interaction-spec.md",
    "docs/product-rules/ux-issue-log.md",
    "src/css/style.css",
    "src/js/tray.js"
  ],
  "key": "design-rules-layer",
  "recorded_at": "2026-09-20",
  "verified_at": "2026-09-20"
}
```

## 为什么

设计资产已经存在，但没有设计层入口：视觉语言在 `ui-interaction-spec.md` 第 1 节，
最细的数值规则在同一份文件的**附录《实现约束》**里（还标着「产品同学不用看」），
token 只活在 `src/css/style.css` 的 `:root`，而 `ux-issue-log.md` 已在承担设计台账。
结果是：改样式的 Agent 不一定读得到规则，产品也看不到「哪些取舍还没裁决」。

## 决定要点

- `docs/design-rules/` 回答「长什么样、为什么、怎么裁决冲突」；交互与状态仍归 `product-rules/`。
- **正本 / 原则 / 治理合同分三份文件**（参考 Cindy `docs/design-rules/` 的分层形态）：
  `visual-language.md`（数值与例外表面）、`design-principles.md`（六要素：主张/适用条件/反例/判定方式/例外归属/起因）、
  `governance.md`（改动分级、证据合同、待裁决登记、回退）。
- **数值唯一来源是代码**：文档解释 token，不定义 token；不一致时按治理合同处理。
- **不搬移** `ui-interaction-spec.md` 的任何正文，只在第 1 节与附录加指向，避免断链与双份正文。
- 规模按 RTC 裁剪：4 份共约 300 行，不照搬 Cindy 的重资产（DESIGN.md 314KB、inventory 206KB）。

## 本次核对到的冲突（已同步）

`ui-interaction-spec.md` 第 1 节括号里曾写「顶栏图标聚焦用偏灰，两样都不占红」，
与同一句主句（红可用于焦点提示）和代码都不符：`style.css` 里 23 处 `:focus-visible`
全部是 `2px solid var(--seal)` 印章红描边。已按代码与主句改写该括号。

## 待产品裁决（登记在 governance.md 第 4 节）

D-1 白板是否为独立外观（UX-4）｜D-2 次要文字要不要守住 4.5:1（UX-3）｜
D-3 字号与圆角要不要收敛成 token｜D-4 菜单栏橙底白柱约 2:1 的对比度取舍。

**未登记不算完**：四项都写明了现状、待谁裁决、裁决后写回哪份文档。

## 同日完成的元素盘点

[docs/design-rules/inventory.md](../../docs/design-rules/inventory.md) 把 7 个表面（主界面、设置页、
指令页、统计页、纠错模态、菜单栏、白板）的元素按「元素 / 实现位置 / token / 规范依据」列清，
并给出 8 条偏差（B1–B8）。两条是本次才摆到台面上的：

- **更新提示条用了整条黄色系**（`#fff7e0` / `#e8c96a` / `#b8860b` / `#7a5b00` / `#a08a4a`）——
  事实上的第二个强调色，与白板的 `#c9a227` 同类，已登记为待裁决 D-5。
- **测试通过用成功绿 `#3f6f4f`**、Toast 用淡红底 `#f3e3dc`——语义清楚但规范里没有，登记为 D-6。

同时量化到一件正面事实：主界面 token 化很干净（384 处 `var(--…)`、`:root` 外只有 25 处颜色字面量，
且多为墨色透明度变体），与白板「89 处硬编码、0 处共享 token」形成对比。

**盘点未跑成的检查**：`npm run check:ux` 因本机缺 Playwright 浏览器未运行，
因此对比度数字引的是 2026-09-17 的历史实测，已在盘点文档里标注。

## 验证

`npm run check:docs` 通过（32 份 Markdown，无失效链接）；文档中的所有数值均对照
`src/css/style.css`、`src/js/tray.js` 与 `src-tauri/src/lib.rs` 复核过。
本决定只新增文档与路由，**没有改动任何 CSS、图标或视觉结果**。
