# D-010：RTC 统一定位为持续语音记录与输入工具

```json
{
  "id": "D-010",
  "kind": "decision",
  "status": "active",
  "summary": "RTC 不再只按语音输入法或实时转写工具定位；同一份麦克风语音同时支撑跨应用输入与本地持续逐字稿，会议是该逐字稿的分场和整理场景",
  "scope": [
    "README.md",
    "package.json",
    "docs/README.md",
    "docs/product-rules/core-product-principles.md",
    "docs/decisions/ADR-001-product-positioning.md"
  ],
  "sources": [
    "docs/decisions/ADR-001-product-positioning.md",
    "docs/product-rules/core-product-principles.md",
    "docs/product-direction/meeting-board-external-ai-first.md",
    "docs/product-direction/innovation-backlog-2026-09-14.md",
    "README.md"
  ],
  "relations": [
    {"type": "related_to", "target": "D-006"}
  ],
  "key": "rtc-product-positioning",
  "recorded_at": "2026-09-20",
  "verified_at": "2026-09-20"
}
```

## 当前产品语义

RTC 的核心不是“把一句话粘贴出去”，而是在用户主动开始录音后，把麦克风中的语音可靠地沉淀为本地逐字稿。同一份记录有两种主要用法：

- 当场输入到当前应用；
- 保留为可回看、搜索、分场和整理的逐字稿。

会议能力建立在同一批语音事件上，不是第二套录音系统。文字是否被粘贴，只是它的去向，不决定它是否被记录。

## 必须保留的边界

- 当前音频源只是本机麦克风，不包含其他应用的系统音频。
- 连续听写需要用户主动开始录音，不是全天候后台录音。
- 原始逐字稿与 AI 整理内容继续分层；AI 不能阻塞或替代原始记录。

## 权威来源

完整取舍和对外用语在 `docs/decisions/ADR-001-product-positioning.md`；长期约束在 `docs/product-rules/core-product-principles.md` 第 0 条。本记录只用于追溯，不复制全部规则正文。
