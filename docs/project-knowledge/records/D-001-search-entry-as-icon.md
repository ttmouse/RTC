# D-001：搜索从「常驻一行输入框」降级为顶栏一个图标

```json
{
  "id": "D-001",
  "kind": "decision",
  "status": "active",
  "summary": "逐字稿搜索不再常驻主界面；顶栏只留一个图标，点开才展开那一行搜索框",
  "scope": ["src/index.html", "src/css/style.css", "src/js/main.js", "tests/search-toggle.browser.mjs"],
  "sources": [
    "docs/product-rules/ui-interaction-spec.md",
    "src/index.html",
    "src/css/style.css",
    "src/js/main.js",
    "tests/search-toggle.browser.mjs"
  ],
  "relations": [{"type": "validated_by", "target": "E-001"}],
  "key": "transcript-search-entry",
  "recorded_at": "2026-09-19",
  "verified_at": "2026-09-19"
}
```

## 为什么

用户（产品侧）的判断：**翻旧记录是低频动作**，而一条常驻的输入框等于天天在邀请人去搜索——
主界面的第一眼被一件不常做的事占着。搜索本身没有被删掉，只是从「常驻一行」改成「按需展开」：
顶栏一个放大镜图标（与其它入口同尺寸、同线条、共用盒模型），点开才展开 `#queryBar` 并聚焦输入框。

看过的三条路，以及为什么选第三条：

| 方案 | 代价 |
| --- | --- |
| 保持常驻输入框 | 低频动作占据首屏第一眼，且暗示「这里应该常来搜」 |
| 把搜索挪进设置页 | 检索是内容操作，放进设置页会让「找一句话」跨两层页面，动作变重 |
| 顶栏图标 + 按需展开（采用） | 需要额外定义收起时的状态清理规则，见下 |

两条随附约束（不是实现细节，是「不许顺手改」的部分）：

1. **收起时必须连带清掉关键词**。否则列表继续被一份看不见的过滤条件压着，用户看到的是
   「我的记录怎么少了一半」——状态不许偷偷存在。
2. **Esc 一步一跳**：有词先清词（框留着），词空了再按才收起。一下把关键词和搜索框一起
   弄没了，用户分不清自己刚按了什么。

展开状态挂在 `body.search-open`，**不写内联 `display`**：设置页 / 语音指令页「整页打开时
把主界面让开」用的是内联值，两套写法会互相覆盖。

人被读的那份（产品语言、含「不要做」）在 `docs/product-rules/ui-interaction-spec.md` 第 2 节
「搜索入口」——**本记录不复制它的正文，只承担 id、来源、关系与「当时怎么判断」的存档**。

## 验证

已核验（2026-09-19），证据是可重跑的命令而不是描述：

```
$ npm run check:search
搜索入口巡检：17/17 通过
```

`tests/search-toggle.browser.mjs` 起自己的临时服务（`RTC_DEV=1` 服务 src/、`RTC_DATA_DIR` 指
临时目录 + 三条夹具记录、麦克风拦掉），在真浏览器里钉住四条行为：默认不占版面、点开即聚焦、
Esc 一步一跳、带着词收起就连词一起清；另加一条与设置页整页覆盖的联动（内联 `display` 和
`body.search-open` 不许互相打架）。

这盏灯能变红（自查过，否则不算灯）：`--break=visible` 让 6 条变红（假装又变回常驻输入框）、
`--break=hidden` 让 1 条变红（假装图标点了没反应）、`--break=esc` 让 1 条变红（假装 Esc 没人管）。

**未核验的部分**：只在无头 Chromium 里跑过，没在桌面 app（WKWebView）窗口里实际点过。
`npm test` / `npm run check:js` / `npm run check:ux` 同时全绿，但它们不覆盖这条交互。
桌面端属该分支的人工确认项，不当作已验。
