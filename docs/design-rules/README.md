# RTC 设计规则

这里存放 RTC 客户端必须遵守的**视觉与呈现规则**：颜色与排版的正本、可判定的设计原则，
以及「改了视觉要怎么走、要拿什么证据」的治理合同。

产品目标和体验叙事在 [`../product-rules/`](../product-rules/README.md)，
系统边界与数据流在 [`../architecture/`](../architecture/README.md)，两者都不进本目录。

## 使用规则

- **改界面、样式、图标、动效或 UI 文案前，先读本目录**：至少读 [DESIGN.md](DESIGN.md)（单一正本）。
- 本目录只回答「长什么样、为什么这样、怎么裁决冲突」。**交互怎么走、状态怎么算**
  仍以 [`ui-interaction-spec.md`](../product-rules/ui-interaction-spec.md) 为准。
- 具体数值的**唯一来源是代码**：颜色与圆角来自 `src/css/style.css` 的 `:root`，
  菜单栏颜色来自 `src/js/tray.js`。文档解释它们，不替代它们；两者不一致时按
  [治理合同](governance.md) 处理，而不是照着文档改代码。
- 能用 token、共用规则、自动检查保证的，就不要只靠读文档：新增约束时按
  [治理合同](governance.md) 的「证据合同」决定它要不要落成检查。

## 当前规范

| 文档 | 回答什么 | 权威性 |
|---|---|---|
| [DESIGN.md](DESIGN.md) | 视觉规范单一正本：纸和墨的 token/层级/图标/动效/对比度/可判定原则/治理摘要（2026-09-30 由 visual-language + design-principles 并入而成；2026-10-01 补齐字阶/间距/圆角/层级 token） | **唯一正本**（数值以代码为准） |
| [design-decision-log.md](design-decision-log.md) | 设计数值的拍板日志（只增不改，防同一争论反复拉扯） | 日志，随正本引用 |
| [design-index.md](design-index.md) | 设计规则文档的检索入口 | 索引 |
| [governance.md](governance.md) | 改动的分级、证据要求、待裁决项、回退 | 现行流程 |
| [inventory.md](inventory.md) | 界面上到底有哪些元素、归谁管、哪里偏离了规范 | **快照**，会过期；改完界面重跑一遍 |
| [../product-rules/ux-issue-log.md](../product-rules/ux-issue-log.md) | 已经发生过、或已实测证实的呈现问题 | **台账**，不是规则 |

## 已知的治理债务（本次盘点留下，不隐藏）

- 2026-10-01 起**字号/间距/圆角/层级都有 token 了**：字阶 8 档（`--fs-*`）、间距 13 档（`--sp-*`）、
  圆角 4 档 + 胶囊（`--radius*`）、层级 8 档（`--z-*`），唯一来源是 `src/css/style.css` 的 `:root`。
  阶梯定义与取舍写在 [DESIGN.md](DESIGN.md) §3/§4/§5-A；`check:ux` 只看几何与对比度，
  **数值本身好不好看仍得真机目检**。
- 白板（会议白板）与主界面是两套外观，且差异尚未裁决（UX-3 / UX-4 状态为「待定」）。
  现状写在 [DESIGN.md](DESIGN.md) §5-C，待裁决点在 [governance.md](governance.md) §4。
- 2026-09-20 的[元素盘点](inventory.md)找出的两条未登记配色（**更新提示条黄色系**、
  **测试通过的成功绿**）已于 2026-10-01 结清：黄色系并入纸墨、成功绿收为 `--ok`。
  同一轮统一之后，`:root` 外的颜色字面量只剩 30 处，**全部是已有 token 的透明度变体与遮罩类，
  非派生色值 0 处**。
- 还挂着一条**待裁决**：列表行「复制成功闪底」用了印章红，但 §1 稀缺律只给了四处
  （录音点/光标/focus/错误）——登记为 governance.md §4 的 D-7。
- `ui-interaction-spec.md` 的附录《实现约束》里仍有一批**实现层**约束（滚动阈值、
  电平尺层级、性能硬约束）。它们属于工程约束，本次不搬移，只在相关处指向。
