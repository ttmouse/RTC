# E-001：搜索入口巡检的验证结果

```json
{
  "id": "E-001",
  "kind": "evidence",
  "status": "active",
  "summary": "npm run check:search 19/19 通过，五种破坏模式各自能变红（2026-09-19 两轮追加：聚焦色、顶栏悬停）",
  "scope": ["tests/search-toggle.browser.mjs", "src/js/main.js", "src/css/style.css", "src/index.html"],
  "sources": ["tests/search-toggle.browser.mjs"],
  "relations": [{"type": "validates", "target": "D-001"}],
  "recorded_at": "2026-09-19",
  "verified_at": "2026-09-19"
}
```

## 是什么

`tests/search-toggle.browser.mjs`（`npm run check:search`）是一盏会变红的灯：真浏览器 + 自起
临时服务（`RTC_DEV=1` 服务 src/、`RTC_DATA_DIR` 临时目录 + 三条夹具记录、麦克风拦掉），
钉住「搜索降级为顶栏图标」之后的四条行为，外加与设置页整页覆盖的显隐联动。

跑法与结果（2026-09-19，工作区未提交时的 HEAD = 385d397 + 未提交改动）。

**2026-09-19 追加**（同一天的第二轮，为 D-002 加灯；下面的 17/17 是加灯前的原始记录，保留不动）：
新增一条断言「聚焦：边框是偏灰的墨色，不是印章红」，并把破坏模式从三种加到四种
（多一个 `--break=red`）。当时结果：`18/18 通过`，`--break=red` 让 1 条变红。

**2026-09-19 再追加**（为 D-003 加灯）：新增一条断言「悬停：六个顶栏图标都是浅纸底 + 墨色图标」
（逐个 hover 六个按钮比对背景色与文字色），破坏模式加到五种（多一个 `--break=hoverred`）。
当前结果：`19/19 通过`，五个破坏模式各自都能让对应断言变红
（visible 6 条 / hidden 1 条 / red 1 条 / hoverred 1 条 / esc 1 条）。

```
$ npm run check:search
搜索入口巡检：17/17 通过

$ node tests/search-toggle.browser.mjs --break=visible   # 假装又变回常驻输入框
搜索入口巡检：11/17 通过 → 自证通过：让 6 条变红
$ node tests/search-toggle.browser.mjs --break=hidden    # 假装图标点了没反应
搜索入口巡检：3/4 通过  → 自证通过：让 1 条变红
$ node tests/search-toggle.browser.mjs --break=esc       # 假装 Esc 没人管
搜索入口巡检：16/17 通过 → 自证通过：让 1 条变红
```

同轮的全绿项（不覆盖这条交互，只作旁证）：`npm test`、`npm run check:js`、`npm run check:ux`。

## 边界

- **只跑了无头 Chromium**（Playwright）。桌面 app 的 WKWebView 窗口没有实测过——该分支的
  渲染与焦点行为与 Chromium 不同，不能由这里的结论代替。
- 夹具只有 3 条记录，只证明「过滤真的重新查过、清词真的回到全部」，不测检索质量与服务端排序。
- `--break=esc` 只让 1 条变红：Chromium 在 `input[type=search]` 上按 Esc 会原生清空值并触发
  `input`，所以「Esc① 清词」那条不依赖实现也能过。变红的那条是「Esc② 收起」。
