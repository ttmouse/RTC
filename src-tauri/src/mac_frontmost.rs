//! 当前最前台的应用是谁 —— 记录里「这句话发给了谁」的唯一来源。
//!
//! 为什么需要它：自动粘贴是「把字放进剪贴板，然后闭着眼睛按 Cmd+V」，按键会打到
//! 当前最前台的那个应用。在这之前不问一句，记录里就永远只有「说了什么」，
//! 没有「发到哪去了」——用户事后回看，分不清哪句是发给微信的、哪句是发给编辑器的。
//!
//! 为什么不用 `osascript` 问 System Events（项目里查系统信息的老路，见 lib.rs 的
//! `run_osascript`）：那条路要辅助功能权限、单次约 150ms，而且和 `paste_text` 里
//! 发 Cmd+V 用的是同一个 System Events 会话，查询会让按键排队（粘贴肉眼变慢）。
//! NSWorkspace 是纯本地查询，微秒级、不额外要权限。
//!
//! 前端只在「这一次定型会真的自动粘贴」时才调它（见 `src/js/frontmost.js`），
//! 此时 RTC 在后台，前台就是粘贴目标。

#[cfg(target_os = "macos")]
mod imp {
    use objc2_app_kit::NSWorkspace;

    /// 前台应用名（"微信" / "Google Chrome"）。拿不到返回 None。
    ///
    /// 前台是本程序自己的时候返回 None：自动粘贴时这说明 Cmd+V 打回了本窗口，
    /// 本程序没有任何输入框能接住它，字等于是掉地上了 —— 报「发往实时逐字稿」
    /// 是假事实（产品原则 3：界面上每个状态只能有一个真实来源）。
    pub fn frontmost_name() -> Option<String> {
        // objc2 把 NSWorkspace 的这几个查询声明为安全调用（不返回裸指针、不改状态）。
        // 但 AppKit 的惯例仍是主线程访问，所以 `frontmost_app` 命令保持同步 ——
        // Tauri 的同步命令跑在主线程（理由见 lib.rs 里 paste_text 的注释）。
        let workspace = NSWorkspace::sharedWorkspace();
        let app = workspace.frontmostApplication()?;
        // 用 pid 而不是 bundle id 认自己：开发模式（`tauri dev`）跑的是裸二进制，
        // bundleIdentifier() 是 None，那时打包后好用的 identifier 反而不存在。
        if app.processIdentifier() == std::process::id() as i32 {
            return None;
        }
        let name = app.localizedName()?.to_string();
        if name.trim().is_empty() {
            return None;
        }
        Some(name)
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    pub fn frontmost_name() -> Option<String> {
        None
    }
}

pub use imp::frontmost_name;
