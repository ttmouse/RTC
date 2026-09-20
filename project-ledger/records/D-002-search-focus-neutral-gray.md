# D-002：按需展开的搜索框，聚焦用偏灰墨色而不用印章红

```json
{
  "id": "D-002",
  "kind": "decision",
  "status": "active",
  "summary": "搜索框展开后聚焦的边框改用偏灰的墨色（--ink-faint），不再用印章红",
  "scope": ["src/css/style.css"],
  "sources": [
    "docs/product-rules/ui-interaction-spec.md",
    "src/css/style.css",
    "tests/search-toggle.browser.mjs"
  ],
  "relations": [{"type": "related_to", "target": "D-001"}],
  "key": "focus-border-color",
  "recorded_at": "2026-09-19",
  "verified_at": "2026-09-19"
}
```

## 为什么

用户原话（2026-09-19）：「搜索框这里打开之后也不要用这种红色的框，我更倾向于用这种偏灰色的框。
像红色这种的颜色不需要过多的使用。」

这条和项目既有的配色纪律是同一件事：规范第 1 节把印章红定为**唯一强调色**，只用在三处
（录音中的圆点、输入光标、悬停与焦点提示），「别的地方不要用，用一次就不珍贵了」。而搜索框
是**点开才出现**的——每次展开都亮一道红，等于在最高频出现的位置持续消耗这个稀缺色。

选 `--ink-faint`（#8f8572）而不是新颜色：它在调色板里本来就有，比默认边框 `--rule` 明显深，
所以「聚焦看得见」这条要求仍然满足，只是不再靠红来表达。

## 范围与未决

- 本次**只改了主界面搜索框**这一处。
- 设置页里的输入框 / textarea / 原生 select 聚焦仍然是印章红（`style.css` 里
  `.s-field textarea:focus`、`.s-field input[type=text|password]:focus`、`.key-wrap input:focus`、
  `.s-field .select-wrap select:focus`、`.modal-body textarea:focus` 五处）。**本次没动**——
  「要不要一起换成偏灰」是一个尚未裁决的问题，不要当成已定规则顺手改，也不要当成笔误顺手改回。

## 验证

已核验（2026-09-19），证据是同一盏灯的加灯：

```
$ npm run check:search
搜索入口巡检：18/18 通过            # 其中一条：聚焦：边框是偏灰的墨色，不是印章红 — --ink-faint #8f8572
$ node tests/search-toggle.browser.mjs --break=red   # 故意把聚焦色染回 #bf3a1e
搜索入口巡检：17/18 通过 → 自证通过：让 1 条变红
```

断言比的是计算出的 RGB 值（必须等于 #8f8572 且不等于 #bf3a1e），不比对 CSS 文本，
所以换写法（改 token、换选择器）不会误报，只有颜色真变了才会红。
