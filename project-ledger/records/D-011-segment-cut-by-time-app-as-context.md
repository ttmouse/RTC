# D-011：语音片段按时间切分，应用只做语境标签

```json
{
  "id": "D-011",
  "kind": "decision",
  "status": "active",
  "summary": "片段切分只按时间连续性，不按应用；每条记录保留说话时的前台应用作为语境标签，片段不预设用途，因此不设会议专用的应用排除名单",
  "scope": [
    "server.js",
    "src/js",
    "docs/decisions/ADR-002-segment-cut-by-time-app-as-context.md",
    "docs/product-direction/meeting-board-review-2026-09-19.md"
  ],
  "sources": [
    "docs/decisions/ADR-002-segment-cut-by-time-app-as-context.md",
    "docs/product-rules/ui-interaction-spec.md",
    "docs/evidence/2026-09-20-speech-segments-and-app-context.md",
    "docs/product-direction/meeting-board-review-2026-09-19.md"
  ],
  "relations": [
    {"type": "related_to", "target": "D-010"},
    {"type": "validated_by", "target": "E-007"}
  ],
  "key": "speech-segment-cut-and-app-context",
  "recorded_at": "2026-09-20",
  "verified_at": "2026-09-20"
}
```

## 决定要点

- 片段（历史上叫「会议场次」）只按静默间隔切分；连续说话时切换应用是常态，按应用切会把一段话切碎。
- 每条记录保留 `activeApp`（显示名 / 包名 / bundle id）作为**语境标签**，回答「这句话是在什么场景里说的」，与粘贴结果 `pasteStatus` 分开。
- 片段不预设用途：会议纪要是其中一种分析目的，不是片段的定义。哪些内容进本次分析，属于分析时的选择。
- 因此不设「会议专用」的应用排除名单。

## 必须保留的边界

- 应用是线索不是判据：2026-09-20 当天 522 条里 37 条没有快照，不得用应用自动判定「这段算不算会议」。
- 不新增录音源、不放宽音频边界（仍为本机麦克风，见 D-010 / ADR-001）。
- 展示层让标签可见的前提是逐字稿时间真实（UX-2 / MB-02）；两者都未实现前，不能声称「已经能按场景区分」。

## 权威来源

对外与实现约束见 `docs/decisions/ADR-002-segment-cut-by-time-app-as-context.md`；界面层已有规则见 `docs/product-rules/ui-interaction-spec.md` 第 6 节；「会议」叫法已裁决暂不改名（2026-09-20），理由见判断台账 MB-15。本记录只用于追溯，不复制正文。
