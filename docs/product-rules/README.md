# 产品规则

本目录回答“RTC 必须怎样表现”。除非文件明确写明 `proposed` 或 `superseded`，这里的规则是现行约束。

| 文件 | 适用场景 | 性质 |
|---|---|---|
| [core-product-principles.md](core-product-principles.md) | 决定产品范围、数据边界、默认行为、开发与发布原则 | 权威规则 |
| [ui-interaction-spec.md](ui-interaction-spec.md) | 修改界面、交互、状态、反馈、会议白板 | 权威规则 |
| [ux-issue-log.md](ux-issue-log.md) | 排查已经发生或实测证实的体验问题 | 问题与证据台账；其中引用的规则仍以规范正文为准 |

维护要求：规则必须说明触发场景、可观察约束、例外和验证方式。新现象先进入问题台账；只有经过产品裁决后，才提炼进规则正文。具体实现细节放在文末工程附录，不能让实现偶然性反过来变成产品原则。

新增规则时使用 [规则模板](../templates/rule.md)。
