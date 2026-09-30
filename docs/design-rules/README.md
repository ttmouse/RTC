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
| [DESIGN.md](DESIGN.md) | 视觉规范单一正本：纸和墨的 token/层级/图标/动效/对比度/可判定原则/治理摘要（2026-09-30 由 visual-language + design-principles 并入而成） | **唯一正本**（数值以代码为准） |
| [design-decision-log.md](design-decision-log.md) | 设计数值的拍板日志（只增不改，防同一争论反复拉扯） | 日志，随正本引用 |
| [design-index.md](design-index.md) | 设计规则文档的检索入口 | 索引 |
| [governance.md](governance.md) | 改动的分级、证据要求、待裁决项、回退 | 现行流程 |
| [inventory.md](inventory.md) | 界面上到底有哪些元素、归谁管、哪里偏离了规范 | **快照**，会过期；改完界面重跑一遍 |
| [../product-rules/ux-issue-log.md](../product-rules/ux-issue-log.md) | 已经发生过、或已实测证实的呈现问题 | **台账**，不是规则 |

## 已知的治理债务（本次盘点留下，不隐藏）

- 字号与间距**还没有 token**：`font-size` 在 `src/css/style.css` 里散落着
  8/10/11/12/13/14/15/16/18/20/22/30px 多档，圆角除了 `--radius` 还有 2/6/8/10/999px。
  正本（[DESIGN.md](DESIGN.md) §3/§4）记录的是**现状与已确认的层级**，没有替产品新增一套阶梯。
- 白板（会议白板）与主界面是两套外观，且差异尚未裁决（UX-3 / UX-4 状态为「待定」）。
  现状写在 [DESIGN.md](DESIGN.md) §5-C，待裁决点在 [governance.md](governance.md) §4。
- 2026-09-20 的[元素盘点](inventory.md)又找出两条没人登记过的配色：**更新提示条的黄色系**
  与**测试通过的成功绿**（已登记为 D-5 / D-6）。同一份盘点也证明主界面的 token 化本身很干净：
  384 处 `var(--…)`，`:root` 外只有 25 处颜色字面量，且多为墨色透明度变体。
- `ui-interaction-spec.md` 的附录《实现约束》里仍有一批**实现层**约束（滚动阈值、
  电平尺层级、性能硬约束）。它们属于工程约束，本次不搬移，只在相关处指向。
