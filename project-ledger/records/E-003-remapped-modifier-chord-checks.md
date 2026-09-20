# E-003：重映射修饰键排除逻辑自动检查通过

```json
{
  "id": "E-003",
  "kind": "evidence",
  "status": "active",
  "summary": "2026-09-20 当前工作区通过 npm test 与 cargo check；新增 Caps Lock 映射组合的静态守门检查，但尚未完成桌面 App 真机按键验收",
  "scope": [
    "src-tauri/src/lib.rs",
    "tests/push-to-talk.test.mjs"
  ],
  "sources": [
    "src-tauri/src/lib.rs",
    "tests/push-to-talk.test.mjs"
  ],
  "relations": [
    {"type": "validates", "target": "D-007"}
  ],
  "key": "push-to-talk-remapped-modifier-chord-evidence-2026-09-20",
  "recorded_at": "2026-09-20",
  "verified_at": "2026-09-20"
}
```

## 实际运行

在 `/Users/douba/Projects/RTC` 执行：

```text
npm test
```

结果：退出码 0，按住说话测试 `45 passed, 0 failed`，全套静态与行为测试通过。

```text
cargo check --manifest-path src-tauri/Cargo.toml
```

结果：退出码 0，Rust 桌面端代码编译检查通过。

JavaScript 语法检查和 `code-modify-safe` 检查也通过。

## 覆盖范围

测试锁住了：

- Rust 端识别其它修饰键介入；
- Rust 端包含 `Shift+Control+Option+Command` 的排除路径；
- 未知物理修饰键但携带修饰标志时按组合键处理；
- 前端继续走已有组合键取消逻辑。

## 未覆盖

- 没有重启当前桌面 App；
- 没有在用户当前键盘工具配置下实际按 Caps Lock 验证 macOS 事件序列；
- 因此不能把自动化通过表述为桌面端人工验收通过。
