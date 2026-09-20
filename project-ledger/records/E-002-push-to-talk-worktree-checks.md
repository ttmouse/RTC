# E-002：按住说话工作区自动检查通过

```json
{
  "id": "E-002",
  "kind": "evidence",
  "status": "active",
  "summary": "2026-09-20 的未提交工作区通过 npm test；其中按住说话 42/42、菜单栏说话状态 27/27，但未做桌面 App 人工验收",
  "scope": [
    "tests/push-to-talk.test.mjs",
    "tests/tray-speaking.test.mjs",
    "scripts/check-static.mjs",
    "package.json"
  ],
  "sources": [
    "tests/push-to-talk.test.mjs",
    "tests/tray-speaking.test.mjs",
    "scripts/check-static.mjs",
    "package.json"
  ],
  "relations": [
    {"type": "validates", "target": "D-005"},
    {"type": "validates", "target": "D-006"}
  ],
  "key": "push-to-talk-automated-evidence-2026-09-20",
  "recorded_at": "2026-09-20",
  "verified_at": "2026-09-20"
}
```

## 对应版本

检查时 Git 分支为 `feature/push-to-talk`，HEAD 为 `1a3c0c3` (`chore: checkpoint current project work`)，
按住说话的后续改动仍在**未提交工作区**。所以本证据不是某个可独立检出的 Git commit 的证明；
在这批改动正式提交后，应重跑并把 commit 写入新证据或补充记录。

## 实际运行

2026-09-20 在项目根目录运行：

```text
npm test
```

结果：退出码 0。与本次决定直接相关的两组输出为：

- `tests/push-to-talk.test.mjs`：42 passed, 0 failed；
- `tests/tray-speaking.test.mjs`：27 passed, 0 failed。

它们明确覆盖：

- 按键后不说话，菜单栏也会立即显示橙色波浪；
- 首次按下、麦克风尚未就绪时也立即反馈；
- 按下的刷新早于 180ms 计时器，松开的刷新早于识别冲刷；
- 快捷键句强制粘贴，连续听写仍遵守自动粘贴规则；
- 连续听写的粘贴成功音仍保留；
- 组合键取消、本地服务端手动分段、云端 task id 身份保留等保护项仍通过。

`git diff --check` 同时通过。`code-modify-safe` 的 JavaScript 语法与转义检查也通过；
该脚本因工作区沙箱限制无法写入技能目录下的日志文件，但检查本身返回 `RESULT=0`。

## 证据不覆盖什么

- 没有启动或重启桌面 App；
- 没有在 macOS 菜单栏里人工观察按下/松开的真实视觉时序；
- 没有人工确认开始音、结束音、粘贴音的实际听感；
- 没有用真实麦克风做完整的按住说话验收。

这些是用户自行体验的范围，不得由本证据推导为已通过。
