# 记录行应用图标（去投影 + 按 2× 出图）验证证据

- Date: 2026-09-30
- Revision: 工作区未提交（基线 `0f854ec`）
- Environment: macOS 桌面端（Apple Silicon），Rust 侧 `cargo test`；浏览器侧 Node + Playwright chromium
- Scope: `src-tauri/src/mac_frontmost.rs` 的 `icon_png_data_url`（记录行去向徽标取图）、`src-tauri/Cargo.toml` 的 objc2-foundation feature

## 检查结果

| 检查 | 结果 | 证据 |
|---|---|---|
| 自动测试（Rust 用例） | pass | `cd src-tauri && cargo test --lib mac_frontmost` → `3 passed; 0 failed`（含新增 `icon_has_no_drop_shadow_ring`） |
| 新增检查会变红 | pass | 临时把取图换回 `NSWorkspace.iconForFile` 再跑：用例 `icon_has_no_drop_shadow_ring` 失败，打印最外圈不透明像素 `[(5,41,0.0039),(11,0,0.0039),(7,41,0.0078)…]`；换回 `bundle_icon` 即绿 |
| 文档门禁 + 全部自动测试 | pass | `npm test` → 全绿（8 / 32 / 29 / 14 / 23 / 26 / 15 / 53，各 0 failed） |
| 浏览器几何与对比度巡检 | pass | `npm run check:ux` → 36 个组合，「没发现机械可判定的界面毛病」 |
| 桌面端真机（图标外观） | **not run** | 改动在 Rust 侧，需要重新打包后才能看到；本篇结论全部来自离屏渲染与像素对照，**没有在桌面端肉眼验收过** |
| 文档与链接 | pass | `npm test` 内的 `node scripts/check-docs.mjs` 通过（DESIGN.md §4 / inventory §1.5 / ux-issue-log UX-20 三处已同步） |

## 根因证据（离屏对照，非桌面端）

用与 Rust 侧同一条绘制路径（`imageWithSize:flipped:drawingHandler:` + TIFF 中转）把「系统带投影那张」与「应用自己的原始图」各自渲染后逐像素量：

| 样本 | `NSWorkspace.iconForFile` 最外圈 | `Bundle.image(forResource:)` 最外圈 |
|---|---|---|
| 计算器 | alpha 3 / 10 / 14（向内的斜坡） | 0（全透明） |
| 微信 | alpha 3 / 10 / 14 | 0 |
| Alma | alpha 3 / 10 / 14 | 0 |

同一批样本在 36px 下的实测更严重（最外两像素 alpha 15、33）——而 36px 正是改动前出图的尺寸，
所以「出图偏小 → 浏览器放大 → 灰边跟着被拉宽」两件事叠在一起，就是用户看到的「又投影又糊」。

## 未验证与已知风险

- **桌面端外观未验收**：图标去投影后会比原先略小一圈（macOS 图标自带留白），要由用户在重打包后的 App 里看一次列表确认可接受。
- **退回路径仍是带投影的**：`Info.plist` 里 `CFBundleIconName` / `CFBundleIconFile` 都没有的应用（实测 443 个安装应用里 86 个）拿不到原始图，会退回系统那张带投影的。同一列表里可能出现两种观感。
- **满幅图标的应用不受滤镜保护**：`icon_has_no_drop_shadow_ring` 用的是计算器（图标不铺到画布边缘）。像 Obsidian、MarkText 这类图标本身就铺满画布的应用，最外圈本来就不透明，不能用同一条判据量。
- `npm run check:ux` 在浏览器里跑，拿不到 `app_icon`（走文字回退），**这条改动它量不到**——不要拿它的绿灯当验收。
