//! 当前最前台的应用是谁 —— 记录里「这句话发给了谁」的唯一来源，也是「应用名单里
//! 有没有它」的唯一判据。
//!
//! 为什么需要它：自动粘贴是「把字放进剪贴板，然后闭着眼睛按 Cmd+V」，按键会打到
//! 当前最前台的那个应用。在这之前不问一句，记录里就永远只有「说了什么」，
//! 没有「发到哪去了」——用户事后回看，分不清哪句是发给微信的、哪句是发给编辑器的。
//!
//! 为什么一次要带回三种名字（见 `FrontmostApp`）：应用名单里存的是**系统应用列表**
//! 给的 `.app` 包名（`/api/apps`，如 `WeChat`），而这里能给的是 macOS 的本地化显示名
//! （`微信`）——两个名字经常不一样，用户在设置里加了微信却什么也没发生。
//! 真实事故：`autoEnterApps` 里存着 `WeChat`，前台查询回的是 `微信`，字符串不相等，
//! 那台机器上微信永远收不到自动回车；名单里的名字和应用的真实身份不是一回事。
//! 所以把显示名 / 包名 / bundle id 一起带回去，由前端按身份匹配（settings.appInList）。
//!
//! 为什么不用 `osascript` 问 System Events（项目里查系统信息的老路，见 lib.rs 的
//! `run_osascript`）：那条路要辅助功能权限、单次约 150ms，而且和 `paste_text` 里
//! 发 Cmd+V 用的是同一个 System Events 会话，查询会让按键排队（粘贴肉眼变慢）。
//! NSWorkspace 是纯本地查询，微秒级、不额外要权限。
//!
//! 前端只在自动粘贴总闸开着时才调它（见 `src/js/frontmost.js`）：名单是按应用判的，
//! 不知道目标就判不出这次该不该粘。此时 RTC 在后台，前台就是粘贴目标。

#[cfg(target_os = "macos")]
mod imp {
    use objc2_app_kit::NSWorkspace;

    /// 前台应用的身份：三种名字都带上，调用方按哪个能对上用哪个。
    #[derive(Clone, serde::Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct FrontmostApp {
        /// macOS 本地化显示名（"微信" / "Google Chrome"）。记录里展示的就是它。
        pub name: String,
        /// `.app` 包名（"WeChat"）。与 `/api/apps` 给用户挑的候选是同一套名字。
        pub bundle: Option<String>,
        /// bundle id（"com.tencent.xinWeChat"）。改名、换语言都不影响它。
        pub id: Option<String>,
    }

    /// 前台应用（"微信" / "Google Chrome"）。认不出来返回 None。
    ///
    /// 前台是本程序自己的时候返回 None：自动粘贴时这说明 Cmd+V 打回了本窗口，
    /// 本程序没有任何输入框能接住它，字等于是掉地上了 —— 报「发往实时逐字稿」
    /// 是假事实（产品原则 3：界面上每个状态只能有一个真实来源）。
    pub fn frontmost_app() -> Option<FrontmostApp> {
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
        // 包名从 bundle 路径的末段取（/Applications/WeChat.app → WeChat）。
        // 不用 CFBundleName：它和包名不一定相同（Feishu.app 的 CFBundleName 是 Feishu，
        // 而 open -a 只认包名 Lark —— 见 server.js 的 /api/apps 注释）。
        let bundle = app
            .bundleURL()
            .and_then(|url| url.path())
            .and_then(|path| {
                std::path::Path::new(&path.to_string())
                    .file_stem()
                    .map(|s| s.to_string_lossy().into_owned())
            });
        Some(FrontmostApp {
            name,
            bundle,
            id: app.bundleIdentifier().map(|s| s.to_string()),
        })
    }

    /// 某个应用的图标，编成 PNG data URL（给记录行上那个「这句去哪了」的徽标用）。
    ///
    /// `name` 可以是三种身份中的任意一种：`.app` 包名（`WeChat`，设置页名单里存的是它）、
    /// macOS 本地化显示名（`微信`，事件记录里存的是它）、或者 bundle id。
    /// 为什么要容这三种：徽标既要服务于「刚粘给谁」（手里是包名），也要服务于
    /// 历史记录（手里是显示名）——按一种名字去匹配，另一半就会永远画不出图标。
    /// 找不到（应用已退出 / 裸二进制没有 bundle / 编码失败）返回 None，调用方退回文字。
    ///
    /// 为什么单列一个函数（而不是塞进 frontmost_app 的返回值）：图标缩完也有几十 KB，
    /// 而 frontmost_app 每句话定型都要调一次；前端按名字缓存，同一个应用一个会话只取一次。
    pub fn icon_png_data_url(name: &str) -> Option<String> {
        use base64::Engine;
        use objc2::AnyThread;   // NSImage::alloc() 来自这个 trait
        use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSImage, NSWorkspace};
        use objc2_foundation::{NSDictionary, NSPoint, NSRect, NSSize};

        // 底栏那一格是 18px，@2x 屏幕给到 36px 就够。
        // 不缩的话原图是 1024（Cindy 的图标 PNG 有 2.9 MB），一个 18px 的小格子拿不动。
        const ICON_PX: f64 = 36.0;

        /// NSImage → PNG 字节（走 TIFF 位图中转，NSImage 本身不产 PNG）
        fn encode_png(icon: &NSImage) -> Option<Vec<u8>> {
            let tiff = icon.TIFFRepresentation()?;
            let rep = NSBitmapImageRep::imageRepWithData(&tiff)?;
            // 不传编码选项（空字典）：PNG 的默认参数就够，这是给人看的 36px 小图
            let props = NSDictionary::new();
            // SAFETY: 空字典对 properties 的泛型参数没有要求（空集合里没有值）。
            let png = unsafe {
                rep.representationUsingType_properties(NSBitmapImageFileType::PNG, &props)
            }?;
            Some(png.to_vec())
        }

        /// 缩小到 ICON_PX 见方。
        ///
        /// 为什么用 lockFocus 这条老路：NSImage 没有缩放接口，而它内部那几十档 rep
        /// （实测 24/48/128/…/2048）都不是 NSBitmapImageRep，拿不到它们的编码器。
        /// lockFocus 是 AppKit 一直以来的离屏画法，本命令跑在主线程（同 lib.rs 里
        /// paste_text 保持同步的理由），且每个应用一个会话只跑一次。
        fn resized_png(icon: &NSImage) -> Option<Vec<u8>> {
            let size = NSSize::new(ICON_PX, ICON_PX);
            let small = NSImage::initWithSize(NSImage::alloc(), size);
            small.lockFocus();
            icon.drawInRect(NSRect::new(NSPoint::new(0.0, 0.0), size));
            small.unlockFocus();
            encode_png(&small)
        }

        // runningApplications 是 NSWorkspace 上的方法（不是 NSRunningApplication 的）
        let workspace = NSWorkspace::sharedWorkspace();
        let running = workspace.runningApplications();
        let want = name.trim().to_lowercase();
        for app in running.iter() {
            // 三种身份逐个比：包名（bundle 路径末段）/ 显示名 / bundle id
            let stem = app
                .bundleURL()
                .and_then(|url| url.path())
                .and_then(|path| {
                    std::path::Path::new(&path.to_string())
                        .file_stem()
                        .map(|s| s.to_string_lossy().into_owned())
                });
            let display = app.localizedName().map(|s| s.to_string());
            let id = app.bundleIdentifier().map(|s| s.to_string());
            let hit = [stem, display, id]
                .iter()
                .flatten()
                .any(|candidate| candidate.to_lowercase() == want);
            if !hit {
                continue;
            }
            let icon = app.icon()?;
            // 缩不出来就不画图标：宁可退回中性的线条标记，也不塞一张几 MB 的原图过去
            let png = resized_png(&icon)?;
            return Some(format!(
                "data:image/png;base64,{}",
                base64::engine::general_purpose::STANDARD.encode(png)
            ));
        }
        None
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    /// 非 macOS 没有系统级前台查询，结构保持一致，永远返回 None。
    #[derive(Clone, serde::Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct FrontmostApp {
        pub name: String,
        pub bundle: Option<String>,
        pub id: Option<String>,
    }

    pub fn frontmost_app() -> Option<FrontmostApp> {
        None
    }

    pub fn icon_png_data_url(_bundle: &str) -> Option<String> {
        None
    }
}

pub use imp::{frontmost_app, icon_png_data_url, FrontmostApp};
