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
    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSImage, NSWorkspace};
    use objc2_foundation::{NSCopying, NSDictionary, NSRect, NSSize, NSString};

    /// 辅助功能（AX）取窗口标题所需的最小 FFI。ApplicationServices 已由 lib.rs 链接。
    /// 只声明这三个符号：不引新 crate，拿不到标题就静默返回 None，绝不抛错
    /// （验收 DOU-10：微信这类拿不到稳定会话标题时不能阻塞主流程）。
    mod ax {
        use core_foundation::base::TCFType;
        use core_foundation::string::CFString;

        // 两个 use 都在用：as_CFTypeRef（TCFType trait）与 CFString::new。
        #[link(name = "ApplicationServices", kind = "framework")]
        extern "C" {
            fn AXUIElementCopyAttributeValue(
                element: *const core::ffi::c_void,
                attribute: *const core::ffi::c_void,
                value: *mut *const core::ffi::c_void,
            ) -> i32;
        }

        pub fn frontmost_window_title(pid: i32) -> Option<String> {
            extern "C" {
                fn AXUIElementCreateApplication(pid: i32) -> *const core::ffi::c_void;
            }
            let element = unsafe { AXUIElementCreateApplication(pid) };
            if element.is_null() {
                return None;
            }
            let result = focused_window_title(element);
            unsafe { core_foundation::base::CFRelease(element) };
            result
        }

        /// AXUIElementCopyAttributeValue 只有 3 个参数（无 options）。
        fn focused_window_title(element: *const core::ffi::c_void) -> Option<String> {
            let focused = CFString::new("AXFocusedWindow");
            let title = CFString::new("AXTitle");
            let mut window: *const core::ffi::c_void = std::ptr::null();
            let status = unsafe {
                AXUIElementCopyAttributeValue(
                    element,
                    focused.as_CFTypeRef(),
                    &mut window,
                )
            };
            if status != 0 || window.is_null() {
                return None;
            }
            let mut title_ref: *const core::ffi::c_void = std::ptr::null();
            let title_status = unsafe {
                AXUIElementCopyAttributeValue(
                    window,
                    title.as_CFTypeRef(),
                    &mut title_ref,
                )
            };
            unsafe { core_foundation::base::CFRelease(window) };
            if title_status != 0 || title_ref.is_null() {
                return None;
            }
            let title = unsafe { CFString::wrap_under_create_rule(title_ref as *const _) };
            let owned = title.to_string();
            let trimmed = owned.trim();
            (!trimmed.is_empty()).then(|| trimmed.to_string())
        }
    }

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
        /// 前台应用焦点窗口的标题（尽力而为，拿不到就是 None）。
        /// 记录里用来看「这句话发到了哪个会话 / 哪个文档」。
        pub window_title: Option<String>,
    }

    /// 前台应用（"微信" / "Google Chrome"）。认不出来返回 None。
    ///
    /// `window_title` 是该应用当前焦点窗口的标题，尽力而为：微信这类非标准 AX
    /// 树的应用拿不到时返回 None，**不失败、不阻塞**（验收 DOU-10）。权限不足
    /// （未开辅助功能）同样返回 None，与「应用不暴露 AX」无法区分，也不再发
    /// 权限弹窗 —— frontmost_app 是每句话都要调的高频路径，弹窗会打断听写。
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
        let name = app.localizedName()?;
        let name = name.to_string();
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
        // 窗口标题尽力而为：拿不到（权限 / 非 AX 应用 / 无窗口）就不带，上游记 null。
        let window_title = ax::frontmost_window_title(app.processIdentifier());
        Some(FrontmostApp {
            name,
            bundle,
            id: app.bundleIdentifier().map(|s| s.to_string()),
            window_title,
        })
    }

    /// 图标出图的像素数：记录行那一格是 21pt（`.pasteBadge img`，见 src/css/style.css），
    /// @2x 屏就是 42px。**必须按这个数出图**：以前给的是 36px，浏览器要把它放大到 42
    /// 才显示，字面意义上的糊（用户 2026-09-30 报的「看着很模糊」）。
    ///
    /// 不再往上加：原图本身是 1024（Cindy 的图标 PNG 有 2.9 MB），再大只是白费内存。
    const ICON_PX: f64 = 42.0;

    /// 应用自己的图标——**没有系统那圈投影**。
    ///
    /// 为什么不用 `NSWorkspace.iconForFile`：它给的是「访达 / 程序坞」看的那张图，
    /// 外面自带一圈黑色投影（2026-09-30 实测：最外 1~2 像素是 alpha 15~33 的黑）。
    /// 画进记录行 21pt 的小格子里，那圈投影就是一圈灰边，看着又脏又糊。
    /// `Bundle.image(forResource:)` 取的是应用自己的原始图（Assets.car 或 .icns），没有投影。
    ///
    /// 图标名先取 `CFBundleIconName`（新，资产目录），再取 `CFBundleIconFile`（旧，直接指 .icns）。
    /// 两个键都没有的应用返回 None（2026-09-30 实测 443 个里 86 个，多是第三方小工具），
    /// 调用方退回系统那张带投影的——有投影也比只剩文字强。
    fn bundle_icon(app_path: &str) -> Option<Retained<NSImage>> {
        use objc2_app_kit::NSBundleImageExtension;
        use objc2_foundation::NSBundle;

        let bundle = NSBundle::bundleWithPath(&NSString::from_str(app_path))?;
        let name = ["CFBundleIconName", "CFBundleIconFile"]
            .into_iter()
            .find_map(|key| {
                let value = bundle.objectForInfoDictionaryKey(&NSString::from_str(key))?;
                value.downcast::<NSString>().ok()
            })?;
        bundle.imageForResource(&name)
    }

    /// 缩小到 ICON_PX 见方，返回 1x 的位图（PNG 就从它编码出来）。
    ///
    /// 使用 NSImage 的分辨率无关绘制回调，而不是 lockFocus/unlockFocus：后者已被
    /// AppKit 标记为弃用，在 Retina 与非 Retina 环境下可能产生错误的绘制尺寸。
    ///
    /// 返回位图而不是 PNG 字节：投影那条回归测试要按像素验证「最外圈是透明的」，
    /// 而 PNG 解回来还要多一个解码依赖。
    fn resized_rep(icon: &NSImage) -> Option<Retained<NSBitmapImageRep>> {
        let size = NSSize::new(ICON_PX, ICON_PX);
        // 绘制回调可能由 NSImage 延后调用，因此不能捕获借用的 `icon`。
        let source = icon.copy();
        let drawing_handler: RcBlock<dyn Fn(NSRect) -> objc2::runtime::Bool> =
            RcBlock::new(move |rect: NSRect| {
                source.drawInRect(rect);
                objc2::runtime::Bool::YES
            });
        let small = NSImage::imageWithSize_flipped_drawingHandler(size, false, &drawing_handler);
        // NSImage 本身不产 PNG：走 TIFF 位图中转
        let tiff = small.TIFFRepresentation()?;
        NSBitmapImageRep::imageRepWithData(&tiff)
    }

    /// 位图 → PNG 字节
    fn encode_png(rep: &NSBitmapImageRep) -> Option<Vec<u8>> {
        // 不传编码选项（空字典）：PNG 的默认参数就够，这是给人看的 42px 小图
        let props = NSDictionary::new();
        // SAFETY: 空字典对 properties 的泛型参数没有要求（空集合里没有值）。
        let png = unsafe {
            rep.representationUsingType_properties(NSBitmapImageFileType::PNG, &props)
        }?;
        Some(png.to_vec())
    }

    /// 某个应用的图标，编成 PNG data URL（给记录行上那个「这句去哪了」的徽标用）。
    ///
    /// `name` / `bundle` / `id` 是同一个应用的三种身份：macOS 本地化显示名（`微信`，
    /// 事件记录里存的是它）、`.app` 包名（`WeChat`，设置页名单里存的是它）、bundle id。
    /// 三个都收：徽标既要服务于「刚粘给谁」（手里可能是包名），也要服务于历史记录
    /// （手里是显示名）——只认其中一种名字，另一半就永远画不出图标。
    ///
    /// **先看正在运行的应用，找不到再去已安装的应用里找。** 徽标展示的常常是几小时前
    /// 那句话发去的应用，那个应用现在多半已经退出（微信、钉钉都是用完就关）；只查运行中
    /// 列表会让历史记录里一大片退回文字（2026-09-21 实测：9 月 18 日以后的记录里 36%
    /// 没图标）。应用装在硬盘上，图标就一直在，没有理由因为「它现在没开」画不出来。
    ///
    /// 找不到（没装 / 裸二进制没有 bundle / 编码失败）返回 None，调用方退回文字。
    ///
    /// 为什么单列一个函数（而不是塞进 frontmost_app 的返回值）：图标缩完也有几十 KB，
    /// 而 frontmost_app 每句话定型都要调一次；前端按身份缓存，同一个应用一个会话只取一次。
    pub fn icon_png_data_url(
        name: &str,
        bundle: Option<&str>,
        id: Option<&str>,
    ) -> Option<String> {
        use base64::Engine;
        use objc2_app_kit::{NSRunningApplication, NSWorkspace};
        use objc2_foundation::NSString;

        /// 运行中的应用的三种身份（`.app` 包名 / 显示名 / bundle id），比较时统一小写。
        fn app_identities(app: &NSRunningApplication) -> [Option<String>; 3] {
            // 包名从 bundle 路径的末段取（/Applications/WeChat.app → WeChat）：
            // 不用 CFBundleName，它和包名不一定相同（见 frontmost_app 里的同一处说明）。
            let stem = app
                .bundleURL()
                .and_then(|url| url.path())
                .and_then(|path| {
                    std::path::Path::new(&path.to_string())
                        .file_stem()
                        .map(|s| s.to_string_lossy().into_owned())
                });
            [
                stem,
                app.localizedName().map(|s| s.to_string()),
                app.bundleIdentifier().map(|s| s.to_string()),
            ]
        }

        /// 已安装应用（不管现在开没开）在硬盘上的 `.app` 路径：按 bundle id / 包名 / 显示名定位。
        ///
        /// 两个来源，按可信度试：
        /// 1. bundle id —— 交给 LaunchServices 自己找（`URLForApplicationWithBundleIdentifier`），
        ///    应用装在哪个目录都行，不用去猜 /Applications；
        /// 2. 包名 / 显示名 —— 在常见安装目录里直接找 `<名字>.app`，覆盖没有 bundle id 的记录。
        ///
        /// 返回路径而不是图标：图标只能从这个 .app 里取（见 `bundle_icon`）。
        fn installed_app_path(
            workspace: &NSWorkspace,
            id: Option<&str>,
            bundle: Option<&str>,
            name: &str,
        ) -> Option<String> {
            let clean = |value: &str| {
                let trimmed = value.trim().to_string();
                (!trimmed.is_empty()).then_some(trimmed)
            };
            // 1) bundle id → LaunchServices
            if let Some(id) = id.and_then(clean) {
                let url = workspace.URLForApplicationWithBundleIdentifier(&NSString::from_str(&id));
                if let Some(path) = url.and_then(|url| url.path()).map(|p| p.to_string()) {
                    if is_app_bundle(&path) {
                        return Some(path);
                    }
                }
            }
            // 2) 包名 / 显示名 → 常见安装目录里的 <名字>.app
            for stem in [bundle, Some(name)].into_iter().flatten().filter_map(clean) {
                for dir in app_dirs() {
                    let candidate = format!("{dir}/{stem}.app");
                    if is_app_bundle(&candidate) {
                        return Some(candidate);
                    }
                }
            }
            None
        }

        /// 常见安装目录。只列一级目录：装在这些目录下面的子文件夹里的应用（少数全家桶）
        /// 交给上面的 bundle id 分支去找，不为它们在这里递归。
        fn app_dirs() -> Vec<String> {
            let mut dirs = vec![
                "/Applications".to_string(),
                "/Applications/Utilities".to_string(),
                "/System/Applications".to_string(),
                "/System/Applications/Utilities".to_string(),
                "/System/Library/CoreServices".to_string(),
                "/System/Library/CoreServices/Applications".to_string(),
            ];
            if let Ok(home) = std::env::var("HOME") {
                dirs.push(format!("{home}/Applications"));
            }
            dirs
        }

        /// 路径确实是一个 .app 包：不是的话 `iconForFile` 会给一张文件夹/文稿图标，
        /// 画到徽标上就是错的。
        fn is_app_bundle(path: &str) -> bool {
            path.ends_with(".app") && std::path::Path::new(path).is_dir()
        }

        // 要认的身份，按可信度排序：bundle id（改名、换语言都不影响）> 包名 > 显示名。
        let wants: Vec<String> = [id, bundle, Some(name)]
            .into_iter()
            .flatten()
            .map(|value| value.trim().to_lowercase())
            .filter(|value| !value.is_empty())
            .collect();
        if wants.is_empty() {
            return None;
        }

        // runningApplications 是 NSWorkspace 上的方法（不是 NSRunningApplication 的）
        let workspace = NSWorkspace::sharedWorkspace();
        let running = workspace.runningApplications();
        // 运行中的应用与已安装的应用，最后都落到同一个问题：**硬盘上那个 .app 在哪**。
        // 路径是两边唯一的共同入口——原始图标只能从 bundle 里取（见 bundle_icon），
        // 而没在运行的应用没有 app 对象，手里只有路径。
        // 1) 正在运行的应用：从它自己的 bundleURL 拿路径
        // 2) 没在运行：去已安装的应用里找 .app
        let app_path = running
            .iter()
            .find(|app| {
                app_identities(app)
                    .iter()
                    .flatten()
                    .any(|candidate| wants.contains(&candidate.to_lowercase()))
            })
            .and_then(|app| app.bundleURL())
            .and_then(|url| url.path())
            .map(|path| path.to_string())
            .or_else(|| installed_app_path(&workspace, id, bundle, name))?;

        // 先要应用自己的原始图标（无投影）；实在取不到（Info.plist 里两个图标键都缺的应用）
        // 才退回系统那张带一圈投影的
        let icon = bundle_icon(&app_path)
            .unwrap_or_else(|| workspace.iconForFile(&NSString::from_str(&app_path)));

        // 缩不出来就不画图标：宁可退回中性的线条标记，也不塞一张几 MB 的原图过去
        let rep = resized_rep(&icon)?;
        let png = encode_png(&rep)?;
        Some(format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(png)
        ))
    }

    #[cfg(test)]
    mod tests {
        /// 应用**没开着**也要能拿到图标——这是徽标最常见的处境（记录里那句话是几小时前
        /// 发去的，微信 / 钉钉早关了）。用「计算器」是因为它一定装着、又几乎不会开着。
        /// 它要是恰好开着，这条测试退化成走运行中分支，仍然该通过。
        #[test]
        fn icon_resolves_for_installed_app_even_when_not_running() {
            let url = super::icon_png_data_url(
                "Calculator",
                Some("Calculator"),
                Some("com.apple.calculator"),
            );
            let url = url.expect("已安装的应用（计算器）应当能取到图标");
            assert!(
                url.starts_with("data:image/png;base64,"),
                "图标应当是 PNG data URL，实际是：{}",
                &url[..url.len().min(60)]
            );
            assert!(url.len() > 200, "42px PNG 不该是空图");
        }

        /// 图标四周不许有投影——用户 2026-09-30 报的就是这圈灰边。
        ///
        /// 判据：把图标按记录行的实际尺寸（ICON_PX）画出来，**最外圈必须完全透明**。
        /// 系统那张带投影的图（`NSWorkspace.iconForFile`）最外 1~2 像素是 alpha 15~33 的黑，
        /// 正是「四周有投影、看着模糊」的像素级来源；应用自己的原始图最外圈是 0。
        ///
        /// 样本用计算器：它一定装着，而且它的图标不铺到画布边缘（Obsidian 那类满幅图标的
        /// 最外圈本来就不透明，拿它量会误报）。
        #[test]
        fn icon_has_no_drop_shadow_ring() {
            let path = "/System/Applications/Calculator.app";
            assert!(
                std::path::Path::new(path).is_dir(),
                "样本应用不在这台机器上：{path}"
            );
            let icon = super::bundle_icon(path).expect("计算器的原始图标应当取得到");
            let rep = super::resized_rep(&icon).expect("图标应当画得出来");
            let (w, h) = (rep.pixelsWide(), rep.pixelsHigh()); // NSInteger（isize）
            let alpha_at = |x: isize, y: isize| -> f64 {
                rep.colorAtX_y(x, y)
                    .map(|c| c.alphaComponent())
                    .unwrap_or(1.0)
            };
            let mut opaque_edge = Vec::new();
            for x in 0..w {
                for y in [0, h - 1] {
                    let a = alpha_at(x, y);
                    if a > 0.0 {
                        opaque_edge.push((x, y, a));
                    }
                }
            }
            for y in 0..h {
                for x in [0, w - 1] {
                    let a = alpha_at(x, y);
                    if a > 0.0 {
                        opaque_edge.push((x, y, a));
                    }
                }
            }
            assert!(
                opaque_edge.is_empty(),
                "图标最外圈应当完全透明（有投影就是从这圈开始的），实际不透明的像素：{:?}",
                &opaque_edge[..opaque_edge.len().min(8)]
            );
        }

        /// 没装的应用仍然老老实实返回 None，调用方退回文字。
        #[test]
        fn unknown_app_has_no_icon() {
            let url = super::icon_png_data_url(
                "RtcNoSuchAppForTest",
                Some("RtcNoSuchAppForTest"),
                Some("com.example.rtc-no-such-app"),
            );
            assert!(url.is_none());
        }
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
        pub window_title: Option<String>,
    }

    pub fn frontmost_app() -> Option<FrontmostApp> {
        None
    }

    pub fn icon_png_data_url(
        _name: &str,
        _bundle: Option<&str>,
        _id: Option<&str>,
    ) -> Option<String> {
        None
    }
}

pub use imp::{frontmost_app, icon_png_data_url, FrontmostApp};
