use std::collections::VecDeque;
use std::io::Read;
use std::path::PathBuf;
use std::process::{Command, Child, Stdio};
use std::sync::Mutex;
use std::net::TcpStream;
use std::time::{Duration, Instant};
use tauri::image::Image;
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::Manager;

/// 「现在最前面的是哪个应用」——粘贴目标。实现在 mac_frontmost.rs，那里写清了为什么
/// 不用 osascript 问 System Events。
mod mac_frontmost;

#[cfg(target_os = "macos")]
mod mac_accessibility {
    use core_foundation::base::TCFType;
    use core_foundation::boolean::CFBoolean;
    use core_foundation::dictionary::CFDictionary;
    use core_foundation::string::CFString;

    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn AXIsProcessTrusted() -> u8;
        fn AXIsProcessTrustedWithOptions(options: *const core::ffi::c_void) -> u8;
    }

    pub fn is_trusted() -> bool {
        unsafe { AXIsProcessTrusted() != 0 }
    }

    pub fn request_trust() {
        let key = CFString::new("AXTrustedCheckOptionPrompt");
        let value = CFBoolean::true_value();
        let options = CFDictionary::from_CFType_pairs(&[(key.as_CFType(), value.as_CFType())]);
        let raw = options.as_concrete_TypeRef() as *const core::ffi::c_void;
        unsafe {
            AXIsProcessTrustedWithOptions(raw);
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod mac_accessibility {
    pub fn is_trusted() -> bool {
        true
    }

    pub fn request_trust() {}
}

// 管理子进程生命周期
struct AppState {
    node_server: Mutex<Option<Child>>,
    asr_server: Mutex<Option<Child>>,
    /// 本机 ASR（模型）服务最近的日志行（stderr 环形缓冲）。
    ///
    /// 打包后的 .app 从访达启动时没有 stderr：python 侧的崩溃原因（缺依赖、端口被占、
    /// 模型文件损坏）只会走 eprintln!，用户手上一条都拿不到。于是界面只能写一句
    /// 「模型服务未启动」，说不出为什么，也没有下一步——用户唯一的出路是退出重开。
    /// 留最近若干行，设置页在异常时把它翻成人话。
    asr_log: Mutex<VecDeque<String>>,
}

#[derive(serde::Deserialize, serde::Serialize)]
#[serde(default)]
struct WindowState {
    width: f64,
    height: f64,
    maximized: bool,
}

impl Default for WindowState {
    fn default() -> Self {
        Self {
            width: 840.0,
            height: 560.0,
            maximized: false,
        }
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PasteOutcome {
    status: &'static str,
}

fn timing_enabled() -> bool {
    std::env::var("RTC_TIMING_LOGS").map(|v| v == "1").unwrap_or(false)
}

fn log_timing(stage: &str, duration: Duration) {
    if timing_enabled() {
        eprintln!("[timing-rust] {} {:.1}ms", stage, duration.as_secs_f64() * 1000.0);
    }
}

fn run_osascript(script: &str) -> Result<String, String> {
    let start = Instant::now();
    let child = Command::new("osascript")
        .args(["-e", script])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("osascript 启动失败: {}", e))?;

    let child_id = child.id();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(child.wait_with_output());
    });

    let result = match rx.recv_timeout(Duration::from_secs(5)) {
        Ok(Ok(output)) => {
            if output.status.success() {
                Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
            } else {
                Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
            }
        }
        Ok(Err(e)) => Err(format!("osascript 等待失败: {}", e)),
        Err(_) => {
            let _ = Command::new("kill")
                .args(["-9", &child_id.to_string()])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn();
            Err("osascript 超时".into())
        }
    };
    log_timing("osascript", start.elapsed());
    result
}

fn read_clipboard() -> Result<String, String> {
    let output = Command::new("/usr/bin/pbpaste")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("LC_ALL", "en_US.UTF-8")
        .output()
        .map_err(|e| format!("pbpaste 启动失败: {}", e))?;

    if !output.status.success() {
        return Err(format!(
            "pbpaste 退出码: {}",
            output.status.code().unwrap_or(-1)
        ));
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

fn clipboard_matches(text: &str) -> Result<bool, String> {
    let content = read_clipboard()?;
    Ok(content == text)
}

fn write_clipboard_with_nspasteboard(text: &str) -> Result<bool, String> {
    let mut clipboard = arboard::Clipboard::new()
        .map_err(|e| format!("NSPasteboard 打开失败: {:?}", e))?;
    clipboard
        .set_text(text)
        .map_err(|e| format!("NSPasteboard 写入失败: {:?}", e))?;

    std::thread::sleep(Duration::from_millis(40));
    match clipboard.get_text() {
        Ok(actual) => {
            if actual != text {
                eprintln!(
                    "[clipboard] NSPasteboard 读回不一致: expected={:?} actual={:?}",
                    text, actual
                );
            }
            Ok(actual == text)
        }
        Err(e) => {
            eprintln!("[clipboard] NSPasteboard 读回失败: {:?}", e);
            Ok(false)
        }
    }
}

fn write_clipboard(text: &str) -> Result<(), String> {
    match write_clipboard_with_nspasteboard(text) {
        Ok(true) => return Ok(()),
        Ok(false) => {
            eprintln!("[clipboard] NSPasteboard 写入后读回不一致，改用 pbcopy");
        }
        Err(e) => {
            eprintln!("[clipboard] NSPasteboard 写入失败，改用 pbcopy: {}", e);
        }
    }

    match write_clipboard_with_pbcopy(text) {
        Ok(true) => return Ok(()),
        Ok(false) => {
            eprintln!("[clipboard] pbcopy 写入后读回不一致，改用 osascript");
        }
        Err(e) => {
            eprintln!("[clipboard] pbcopy 写入失败，改用 osascript: {}", e);
        }
    }

    write_clipboard_with_osascript(text)
}

fn write_clipboard_with_pbcopy(text: &str) -> Result<bool, String> {
    for attempt in 0..2 {
        use std::io::Write;
        let mut pbcopy = Command::new("/usr/bin/pbcopy")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .env("LC_ALL", "en_US.UTF-8")
            .spawn()
            .map_err(|e| format!("pbcopy 启动失败: {}", e))?;

        if let Some(ref mut stdin) = pbcopy.stdin {
            stdin
                .write_all(text.as_bytes())
                .map_err(|e| format!("pbcopy 写入失败: {}", e))?;
        }
        drop(pbcopy.stdin.take());
        let output = pbcopy
            .wait_with_output()
            .map_err(|e| format!("pbcopy 等待失败: {}", e))?;
        if !output.status.success() {
            return Err(format!(
                "pbcopy 退出码: {}",
                output.status.code().unwrap_or(-1)
            ));
        }

        std::thread::sleep(Duration::from_millis(80));
        let matched = clipboard_matches(text)?;
        eprintln!(
            "[clipboard] 第 {} 次写入: 期望={:?} 实际={:?} 匹配={}",
            attempt + 1,
            text,
            read_clipboard().unwrap_or_default(),
            matched
        );
        if matched {
            return Ok(true);
        }
    }

    Ok(false)
}

fn write_clipboard_with_osascript(text: &str) -> Result<(), String> {
    let escaped = text
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\r', "\\r")
        .replace('\n', "\\n");
    let script = format!("set the clipboard to \"{}\"", escaped);
    run_osascript(&script)?;

    std::thread::sleep(Duration::from_millis(80));
    if clipboard_matches(text)? {
        return Ok(());
    }
    Err("osascript 写入剪贴板后内容校验失败".into())
}

/// 复制文本到剪贴板，不模拟按键。
///
/// 与 `paste_text` 同理保持同步：`write_clipboard` 碰的是 NSPasteboard，
/// macOS 要求主线程访问。不要为了省那点阻塞改成 async。
#[tauri::command]
fn copy_to_clipboard(text: String) -> Result<String, String> {
    let start = Instant::now();
    write_clipboard(&text)?;
    log_timing("copy_to_clipboard.total", start.elapsed());
    Ok("ok".into())
}

/// 读取当前应用的选中文本，同时恢复用户原来的剪贴板内容。
///
/// 优先走 macOS 辅助功能的 AXSelectedText，不依赖剪贴板是否发生变化；
/// 某些应用不暴露 AX 选区时，再退回 Cmd+C 方案。
#[tauri::command]
fn read_selected_text() -> Result<Option<String>, String> {
    let accessibility_script = r#"
        tell application "System Events"
            set frontApp to first application process whose frontmost is true
            tell frontApp
                try
                    set focusedElement to value of attribute "AXFocusedUIElement"
                    return value of attribute "AXSelectedText" of focusedElement
                on error
                    return ""
                end try
            end tell
        end tell
    "#;
    if let Ok(selected) = run_osascript(accessibility_script) {
        let selected = selected.trim().to_string();
        if !selected.is_empty() {
            return Ok(Some(selected));
        }
    }

    let previous = read_clipboard()?;
    run_osascript("tell application \"System Events\" to keystroke \"c\" using command down")?;
    std::thread::sleep(Duration::from_millis(180));
    let selected = read_clipboard()?;
    write_clipboard(&previous)?;
    if selected.is_empty() || selected == previous {
        return Ok(None);
    }
    Ok(Some(selected))
}

/// 粘贴文本到当前光标位置（通用粘贴）。
///
/// 只做两件事：把文本写入系统剪贴板，然后无条件向系统发送 Cmd+V。
/// 不做任何前台应用 / AX 输入框判断——用户可能在任意可输入处使用
/// （微信、Codex、浏览器、甚至本软件自己的控制台），自绘 UI 不暴露
/// AX 焦点，白名单式判断只会误拦截。`ok` 只表示按键已发出；是否真正
/// 写入目标输入框由目标应用决定。
///
/// 保持同步（Blocking）执行，**不能**改成 `#[tauri::command(async)]`：
/// `write_clipboard` 走的是 arboard/NSPasteboard，而 macOS 要求在主线程访问它。
/// 挪到线程池会引入无提示的剪贴板写入失败（表现为「粘贴出来还是旧内容」）。
/// 这里确实会阻塞主线程约 0.1~0.5 秒，但那是一次明确、有限、用户主动触发的操作，
/// 比一个只在某些机器上复现的剪贴板竞态好得多。
#[tauri::command]
fn paste_text(text: String, auto_enter: Option<bool>) -> Result<PasteOutcome, String> {
    let start = Instant::now();
    write_clipboard(&text)?;
    log_timing("paste_text.clipboard_write", start.elapsed());

    // 给 pasteboard 同步留一点时间，避免目标应用读到旧内容。
    std::thread::sleep(Duration::from_millis(100));
    log_timing("paste_text.clipboard_sync_sleep", Duration::from_millis(100));

    if !mac_accessibility::is_trusted() {
        mac_accessibility::request_trust();
        log_timing("paste_text.total", start.elapsed());
        return Ok(PasteOutcome {
            status: "clipboard_only",
        });
    }

    // 先只发送 Cmd+V，让前端在粘贴完成后立即播放反馈音。
    // 旧实现把「等待 300ms + 回车」放在同一个 osascript 里，导致文字已经出现，
    // 但提示音要等回车结束后才响，用户感知为粘贴卡顿。
    let paste_start = Instant::now();
    let outcome = match run_osascript("tell application \"System Events\" to keystroke \"v\" using command down") {
        Ok(_) => PasteOutcome { status: "ok" },
        Err(e) => {
            eprintln!("[paste] osascript 失败（降级为仅剪贴板）: {}", e);
            PasteOutcome {
                status: "clipboard_only",
            }
        }
    };
    log_timing("paste_text.osascript", paste_start.elapsed());

    // 自动发送仍保留 300ms 的缓冲，但不阻塞粘贴结果和提示音返回。
    if auto_enter.unwrap_or(false) && outcome.status == "ok" {
        std::thread::spawn(|| {
            std::thread::sleep(Duration::from_millis(300));
            if let Err(e) = run_osascript("tell application \"System Events\" to keystroke return") {
                eprintln!("[paste] 自动回车失败: {}", e);
            }
        });
    }

    log_timing("paste_text.total", start.elapsed());
    Ok(outcome)
}

/// 当前最前台的应用（`paste_text` 的 Cmd+V 会打到它身上），带显示名 / 包名 / bundle id。
///
/// 前端在自动粘贴总闸开着时调用，一份结果两处用：判「这次该不该粘」
/// （应用名单按身份匹配，见 settings.appInList）以及随这句话一起入库，
/// 于是记录里能看出「这句是发到微信的」。
///
/// 返回 `None` 有三种情况，调用方一律当「不知道」，不影响这句话照常入库：
/// 前台是本程序自己（说明这次 Cmd+V 打回了本窗口，没有任何输入框能接住）、
/// 非 macOS / 网页版没有系统级能力、以及查询本身失败。
#[tauri::command]
fn frontmost_app() -> Option<mac_frontmost::FrontmostApp> {
    mac_frontmost::frontmost_app()
}

/// 某个应用图标的 PNG data URL（记录行上「这句去哪了」的徽标用）。
///
/// `name` 三种身份都收：.app 包名（设置页名单里存的）、显示名（事件记录里存的）、
/// bundle id。理由与缩图细节见 mac_frontmost.rs；前端按名字缓存，一个应用一个会话只问一次。
#[tauri::command]
fn app_icon(name: String) -> Option<String> {
    mac_frontmost::icon_png_data_url(&name)
}

/// 激活指定应用。
///
/// 不做白名单限制（应用名由前端指令/LLM 学习/CLI 传入，产品允许打开任意已安装应用）；
/// 仅做字符集校验防注入：`open -a` 以参数形式接收（无 shell 拼接），
/// 但防御性校验只允许安全字符，避免异常输入。`open` 对不存在的应用会失败返回，无破坏面。
#[tauri::command]
fn activate_app(app: String) -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        if app.is_empty() || app.len() > 64 {
            return Err("无效的应用名".into());
        }
        if !app.chars().all(|c| c.is_alphanumeric() || c.is_whitespace() || "-_.".contains(c)) {
            return Err("应用名包含非法字符".into());
        }
        let status = Command::new("/usr/bin/open")
            .args(["-a", app.as_str()])
            .status()
            .map_err(|e| format!("启动应用失败: {}", e))?;
        if status.success() {
            Ok("ok".into())
        } else {
            Err(format!("应用不存在或无法打开: {}", app))
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Err("应用指令目前仅支持 macOS".into())
    }
}

/// 在访达中显示指定路径（目录→打开该目录，文件→在父目录中选中）。
///
/// 为什么不用 tauri-plugin-shell 的 `open`：该命令对 JS 侧传入路径做 scope 校验，
/// 默认只放行 `http(s)://`、`mailto:`、`tel:`，本地路径必然返回 Validation 错误
/// （且错误被前端 catch 吞掉，表现为「点了没反应」）。这里直接调 /usr/bin/open，
/// 以参数形式传路径，无 shell 拼接，不做 URL schema 限制。
#[tauri::command]
fn reveal_in_finder(path: String) -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        if path.is_empty() || path.len() > 1024 {
            return Err("无效的路径".into());
        }
        let p = std::path::Path::new(&path);
        if !p.exists() {
            return Err(format!("路径不存在：{}", path));
        }
        let status = if p.is_dir() {
            Command::new("/usr/bin/open").arg(&path).status()
        } else {
            Command::new("/usr/bin/open").args(["-R", &path]).status()
        }
        .map_err(|e| format!("调用 open 失败: {}", e))?;
        if status.success() {
            Ok("ok".into())
        } else {
            Err(format!("打开失败：{}", path))
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = path;
        Err("在访达中显示目前仅支持 macOS".into())
    }
}

#[tauri::command]
fn accessibility_permission() -> bool {
    mac_accessibility::is_trusted()
}

#[tauri::command]
fn request_accessibility_permission() -> bool {
    mac_accessibility::request_trust();
    mac_accessibility::is_trusted()
}

/// 本机 ASR（模型）服务当前的状况。
///
/// 界面在「模型服务未启动」时要靠它说清「为什么」：进程还在不在、是本应用启动的
/// 还是复用了别人起的，以及最近的服务日志（日志是用户唯一能拿到的失败线索）。
#[derive(serde::Serialize)]
struct LocalAsrStatus {
    /// 这个进程是本应用启动的（本应用持有句柄）。false = 复用了别人起的服务，
    /// 本应用重启不了它，只能请用户在启动它的地方重启。
    managed: bool,
    running: bool,
    pid: Option<u32>,
    /// 8933（模型管理 HTTP）有人在听
    port_open: bool,
    log_tail: Vec<String>,
}

fn asr_status_snapshot(app: &tauri::AppHandle) -> LocalAsrStatus {
    let state = app.state::<AppState>();
    let (managed, running, pid) = {
        let mut guard = state.asr_server.lock().unwrap();
        let pid = guard.as_ref().map(|c| c.id());
        let running = match guard.as_mut() {
            Some(child) => matches!(child.try_wait(), Ok(None)),
            None => false,
        };
        if !running {
            // 进程已经退出：句柄留着没用，还会让下一次重启误以为有个活的要杀
            guard.take();
        }
        (pid.is_some(), running, pid)
    };
    let log_tail = state
        .asr_log
        .lock()
        .map(|l| l.iter().cloned().collect())
        .unwrap_or_default();
    LocalAsrStatus {
        managed,
        running,
        pid,
        port_open: port_open(8933),
        log_tail,
    }
}

/// 本机模型服务的当前状况（设置页在「模型服务未启动」时用它拿原因）。
#[tauri::command]
fn local_asr_status(app: tauri::AppHandle) -> LocalAsrStatus {
    asr_status_snapshot(&app)
}

// ============================================================
// 菜单栏图标（macOS 顶部状态栏）
//
// 它存在的唯一理由：应用在后台（用户正在别的软件里说话）时，这是唯一能回答
// 「现在到底有没有在工作」的地方。窗口在别人后面时，用户看不到主界面状态区。
//
// 分工：**状态判断只在前端**（src/js/ui.js 的 computeRunStatus，产品原则 3：状态单一来源），
// 前端把「用哪个字形 + 什么颜色」算好后调 set_tray_status；Rust 只负责换图、上色、写 tooltip。
// 这里不重新判断状态——否则菜单栏和主界面迟早会说两套话。
// ============================================================

/// 菜单栏图标 id（前端改状态时按它找回这个图标）
const TRAY_ID: &str = "rtc-status";

/// 菜单栏那一格的宽度（pt）。**写死一个值，不靠图片算**：
/// - 按钮会在图片两侧各留一段内边距（实测比图片宽 16pt），所以「把图片缩窄」调不准；
/// - 固定宽度意味着三种状态切换时**旁边那排图标不会左右跳**（说话是每句话都会发生的事）。
///
/// 28pt 是这么来的：里面的图形（参考 `speaking` 那根波浪）约 13.5pt 宽，
/// 两侧各留 7pt 左右的呼吸 → 胶囊看起来才不像被图形撑满的长条。觉得宽/窄就改这一个数。
const TRAY_SLOT_WIDTH: f64 = 28.0;

/// 字形名 → 图片。字形语义互斥（见 src/js/tray.js 的映射表）：
/// idle=待命（麦克风）、dot=在录但没听到声音（圆点，就是「录音灯」）、
/// speaking=正在说话（电平柱，底色由按钮图层另行画出，见 paint_tray_background）、
/// mic-off=麦克风/声音输入异常、service-error=服务侧异常。
///
/// 全部都是**模板图**（纯黑+透明）：默认交给 macOS 按模板图渲染（跟随系统明暗），
/// 需要颜色时由 set_tray_status 临时着色——不另存彩色版本，见 tint_rgba。
///
/// 所有字形统一是 **36×36 画布**（= 18×18pt，tray 固定按高 18pt 渲染）。
/// 菜单栏那一格的宽度不靠图片决定，而是写死 `TRAY_SLOT_WIDTH`（见 paint_tray_background），
/// 所以三种状态切换时**旁边那排图标不会左右跳**。
fn tray_glyph_bytes(glyph: &str) -> Option<&'static [u8]> {
    Some(match glyph {
        "idle" => include_bytes!("../icons/tray/idle.png"),
        "dot" => include_bytes!("../icons/tray/dot.png"),
        "speaking" => include_bytes!("../icons/tray/speaking.png"),
        "mic-off" => include_bytes!("../icons/tray/mic-off.png"),
        "service-error" => include_bytes!("../icons/tray/service-error.png"),
        _ => return None,
    })
}

/// 解析 `#RRGGBB`（前端传的色值）。认不出来返回 None —— 宁可不看色（退回黑白模板图），
/// 也不猜一个可能与状态无关的颜色。
fn parse_hex_color(s: &str) -> Option<(u8, u8, u8)> {
    let s = s.trim().trim_start_matches('#');
    if s.len() != 6 {
        return None;
    }
    Some((
        u8::from_str_radix(&s[0..2], 16).ok()?,
        u8::from_str_radix(&s[2..4], 16).ok()?,
        u8::from_str_radix(&s[4..6], 16).ok()?,
    ))
}

/// 把黑色像素换成指定颜色，**alpha 原样保留**——字形本身就是一张 alpha 遮罩，
/// 所以着色不需要另存一套彩色图片：只改 RGB。
fn tint_rgba(src: &[u8], (r, g, b): (u8, u8, u8)) -> Vec<u8> {
    let mut out = src.to_vec();
    for px in out.chunks_exact_mut(4) {
        px[0] = r;
        px[1] = g;
        px[2] = b;
    }
    out
}

/// 前端状态每变一次就调这里：`glyph` = 图标字形，`color` = 颜色（None = 黑白模板图），
/// `tooltip` = 悬停说明。
///
/// **没有文字参数**：菜单栏那一格只放图标，状态全写在图形与颜色里
/// （图标边上的文字已按用户 2026-09-19 的要求全部去掉）；要看原因与下一步就悬停或点开主界面。
///
/// 失败不 panic 也不报错弹窗：菜单栏只是旁路出口，它坏了不能影响录音主流程（产品原则 4）。
#[tauri::command]
fn set_tray_status(
    app: tauri::AppHandle,
    glyph: String,
    color: Option<String>,
    background: Option<String>,
    tooltip: String,
) -> Result<(), String> {
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return Err("菜单栏图标不存在（可能是启动时创建失败）".into());
    };
    if let Some(bytes) = tray_glyph_bytes(&glyph) {
        let img = Image::from_bytes(bytes).map_err(|e| e.to_string())?;
        let (w, h) = (img.width(), img.height());
        match color.as_deref().and_then(parse_hex_color) {
            Some(rgb) => {
                // 有色 → 必须关掉模板模式，否则 macOS 会把颜色丢掉、按系统明暗重绘成黑白
                let tinted = tint_rgba(img.rgba(), rgb);
                let icon = Image::new(&tinted, w, h).to_owned();
                tray.set_icon_with_as_template(Some(icon), false)
                    .map_err(|e| e.to_string())?;
            }
            // 无色 → 模板图：自动跟随菜单栏明暗（空闲态就该安静，不抢眼）
            None => {
                tray.set_icon_with_as_template(Some(img), true)
                    .map_err(|e| e.to_string())?;
            }
        }
    }
    // 背景块（「正在说话」那块橙底）画在按钮自己的图层上：高度由系统给，
    // 所以和系统点击时那块高亮底**天然一样高**——图片做不到这件事（见函数注释）。
    #[cfg(target_os = "macos")]
    paint_tray_background(&tray, background.as_deref().and_then(parse_hex_color))?;
    #[cfg(not(target_os = "macos"))]
    let _ = &background;

    tray.set_tooltip(Some(tooltip)).map_err(|e| e.to_string())?;
    Ok(())
}

/// 给菜单栏项自己的按钮画/清背景块。
///
/// 为什么不用图片画：**tray 固定把图片按高 18pt 渲染**（tray-icon 里写死 `icon_height = 18.0`），
/// 所以图片做出来的色块最多 18pt 高；而系统点击时那块高亮底是按钮自己的 bounds，比 18pt 高。
/// 用户要的正是「和那个高度一致」——那就只能画在按钮的图层上：高度由系统给，天然一样高，
/// 不用猜一个写死的数字，也不会因为换了显示器/分辨率而错位。
///
/// 另一个好处：颜色仍然只有一处（src/js/tray.js 的 TONE_SPEAKING），不必把橙色烤进 PNG。
#[cfg(target_os = "macos")]
fn paint_tray_background(
    tray: &tauri::tray::TrayIcon<tauri::Wry>,
    rgb: Option<(u8, u8, u8)>,
) -> Result<(), String> {
    use objc2::MainThreadMarker;
    use objc2_app_kit::NSColor;
    use objc2_quartz_core::kCACornerCurveContinuous;

    tray.with_inner_tray_icon(move |inner| {
        let Some(item) = inner.ns_status_item() else { return };
        // 这个回调跑在主线程上；万一不是（未来实现变了），安静放弃比乱设更安全
        let Some(mtm) = MainThreadMarker::new() else { return };
        // 宽度每次都重设一遍：图标换过之后系统可能按内容重新量过
        item.setLength(TRAY_SLOT_WIDTH);
        let Some(button) = item.button(mtm) else { return };
        button.setWantsLayer(true); // layer() 在此之前返回 nil
        let Some(layer) = button.layer() else { return };
        match rgb {
            Some((r, g, b)) => {
                let color = NSColor::colorWithSRGBRed_green_blue_alpha(
                    r as f64 / 255.0,
                    g as f64 / 255.0,
                    b as f64 / 255.0,
                    1.0,
                );
                layer.setBackgroundColor(Some(&color.CGColor()));
                // 胶囊形状（用户 2026-09-19 要的「大圆角、像胶囊按钮」）：半径取高度的一半，
                // 这样它天然是个胶囊——不用写死数值，换显示器/菜单栏变高也不会变成半圆角矩形。
                layer.setCornerRadius(button.bounds().size.height / 2.0);
                // 苹果自己的胶囊用的是「连续圆角」（squircle），比正圆弧更顺眼；
                // 默认是 circular，不设的话两条边的转角会看出硬拐点。
                layer.setCornerCurve(unsafe { kCACornerCurveContinuous });
            }
            None => layer.setBackgroundColor(None),
        }
    })
    .map_err(|e| e.to_string())
}

/// 点菜单栏图标 → 把主界面拿到前面。
/// 先 show 再聚焦：⌘H 隐藏过整个应用时，单一个 set_focus 叫不回来。
fn focus_main_window(app: &tauri::AppHandle) {
    #[cfg(target_os = "macos")]
    let _ = app.show();
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// 重启本机模型服务——设置页「模型服务未启动」时的恢复入口。
///
/// 为什么需要它：python 侧中途退出（崩溃、端口被别的程序抢走、依赖被卸载）时，
/// Rust 只在 setup 里拉起过一次、之后没有任何看护，界面也没有按钮。用户唯一的出路
/// 是退出重开应用，而且全程看不到原因——「模型服务未启动」是一句没有下文的话。
///
/// 刻意标成 async：非 async 的命令跑在主线程上，这里要等端口放开、再等最多 30 秒
/// 的服务就绪，会把整个窗口冻住。
#[tauri::command]
async fn restart_local_asr(app: tauri::AppHandle) -> Result<LocalAsrStatus, String> {
    let state = app.state::<AppState>();
    let previous = state.asr_server.lock().unwrap().take();
    if let Some(mut child) = previous {
        let _ = child.kill();
        let _ = child.wait();
    } else if port_open(8932) {
        // 复用来的服务（dev 模式下可能是用户自己在终端跑的）：不动别人的进程
        return Err("本机识别服务不是本应用启动的（开发模式复用了终端里的进程）：请在启动它的终端里重启".into());
    }

    // 等端口真正放开：kill 之后 socket 不会立刻消失，紧接着起新进程会绑不上 8932 直接退出
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline && port_open(8932) {
        std::thread::sleep(Duration::from_millis(200));
    }

    let child = match start_asr_server(&app) {
        Some(c) => c,
        None => return Err("起不来：找不到 python3 或 asr_local/server.py".into()),
    };
    let pid = child.id();
    *state.asr_server.lock().unwrap() = Some(child);

    if !wait_for_tcp("127.0.0.1", 8933, 30) {
        return Err(format!(
            "重启后 30 秒内没能连上 8933（进程 PID {}），多半是启动就崩了",
            pid
        ));
    }
    Ok(asr_status_snapshot(&app))
}

/// 获取项目根目录（开发模式从 src-tauri 上到父目录，生产模式从 resource_dir 开始）
fn resolve_project_dir(app_handle: &tauri::AppHandle) -> PathBuf {
    let resource_dir = app_handle
        .path()
        .resource_dir()
        .unwrap_or_else(|_| PathBuf::from("."));

    if cfg!(debug_assertions) {
        let cwd = std::env::current_dir().unwrap_or_else(|_| resource_dir);
        if cwd.ends_with("src-tauri") {
            cwd.parent().unwrap_or(&cwd).to_path_buf()
        } else {
            cwd
        }
    } else {
        resource_dir
    }
}

/// 查找捆绑 sidecar 的完整路径。
///
/// Tauri 2 externalBin 在 macOS 上打包到 Contents/MacOS/ 下，文件名不带 target triple；
/// 同时兼容放置于资源目录（带/不带 triple）的历史布局。
fn find_sidecar(project_dir: &std::path::Path, name: &str) -> Option<std::path::PathBuf> {
    let mut candidates = vec![
        project_dir.join(name),
        project_dir.join(format!("{}-aarch64-apple-darwin", name)),
    ];
    if let Some(parent) = project_dir.parent() {
        candidates.push(parent.join("MacOS").join(name));
    }
    candidates.into_iter().find(|p| p.is_file())
}

/// 在受限 PATH 下查找可执行文件（Finder 启动时 PATH 只有 /usr/bin:/bin:/usr/sbin:/sbin）
fn find_binary(name: &str) -> Option<String> {
    // 检查候选路径优先于 PATH（Finder 启动时 PATH 只有 /usr/bin:/bin:/usr/sbin:/sbin）
    // 特别是 python3 需要 Homebrew 版本（系统 Python 无 sherpa_onnx）
    let candidates: &[&str] = match name {
        "node" => &[
            "/usr/local/bin/node",
            "/opt/homebrew/bin/node",
            "/opt/homebrew/opt/node@22/bin/node",
            "/opt/homebrew/opt/node@20/bin/node",
            "/opt/homebrew/opt/node@18/bin/node",
        ],
        "python3" => &[
            "/opt/homebrew/bin/python3",
            "/usr/local/bin/python3",
            "/usr/bin/python3",
        ],
        _ => return None,
    };

    for path in candidates {
        if std::path::Path::new(path).is_file() {
            if Command::new(path)
                .arg("--version")
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .and_then(|mut c| c.wait())
                .is_ok()
            {
                return Some(path.to_string());
            }
        }
    }

    // 候选路径都不可用，回退到 PATH 查找
    if Command::new(name)
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .and_then(|mut c| c.wait())
        .is_ok()
    {
        return Some(name.to_string());
    }

    None
}

/// 本项目自己的进程特征。只清理这些，别去动别人的服务。
const OWN_PROCESS_MARKERS: [&str; 5] = [
    "node-server",
    "asr-server",
    "server.js",
    "dev.mjs",
    "rtc-transcriber",
];

/// 取出占用指定端口的 PID 列表（lsof 不可用时返回空）。
fn pids_on_port(port: u16) -> Vec<String> {
    Command::new("lsof")
        .args(["-ti", &format!("tcp:{}", port)])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| {
            s.lines()
                .map(|l| l.trim().to_string())
                .filter(|l| !l.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

/// 该 PID 是否属于本项目（ps comm= 里含项目特征串）。
fn is_own_process(pid: &str) -> bool {
    let comm = Command::new("ps")
        .args(["-p", pid, "-o", "comm="])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .unwrap_or_default();
    OWN_PROCESS_MARKERS.iter().any(|m| comm.contains(m))
}

/// 释放上一轮残留的自家进程。
///
/// 关键在 `is_own_process` 这道闸：老实现是 `lsof -ti tcp:PORT` 拿到什么就 `kill -9` 什么，
/// 用户自己在 8931 上跑的任何服务都会被 App 启动时无声打死。现在只清本项目自己的进程，
/// 别人的进程留着——端口冲突让 Node 自己报错，比静默谋杀强。
fn kill_previous_processes(port: u16) {
    for pid in pids_on_port(port) {
        if !is_own_process(&pid) {
            println!("[tauri] 端口 {port} 被非本项目进程占用 (PID: {pid})，跳过清理");
            continue;
        }
        println!("[tauri] 释放端口 {port} (PID: {pid})");
        let _ = Command::new("kill").args(["-9", &pid]).status();
    }
}

/// 启动 Node.js 服务（server.js）
fn start_node_server(app_handle: &tauri::AppHandle) -> Option<Child> {
    let project_dir = resolve_project_dir(app_handle);

    // 优先启动捆绑的 Node sidecar（bun 编译的单文件，无需系统安装 Node.js）
    if let Some(p) = find_sidecar(&project_dir, "node-server") {
        println!("[tauri] 启动捆绑 Node 服务 (sidecar): {:?}", p);
        match Command::new(&p)
            .current_dir(&project_dir)
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
        {
            Ok(mut child) => {
                if let Some(stderr) = child.stderr.take() {
                    std::thread::spawn(move || {
                        use std::io::BufRead;
                        for line in std::io::BufReader::new(stderr).lines().map_while(Result::ok) {
                            eprintln!("[node-sidecar] {}", line);
                        }
                    });
                }
                println!("[tauri] Node sidecar 已启动 (PID: {})", child.id());
                return Some(child);
            }
            Err(e) => eprintln!("[tauri] 启动 Node sidecar 失败: {}，回退系统 node", e),
        }
    }

    let server_path = project_dir.join("server.js");

    if !server_path.exists() {
        eprintln!("[tauri] server.js 未找到: {:?}", server_path);
        return None;
    }

    let node_bin = match find_binary("node") {
        Some(p) => p,
        None => {
            eprintln!("[tauri] 找不到 node 可执行文件，请确保已安装 Node.js");
            return None;
        }
    };

    match Command::new(node_bin)
        .arg(&server_path)
        .current_dir(&project_dir)
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(child) => {
            println!("[tauri] Node.js 服务已启动 (PID: {})", child.id());
            Some(child)
        }
        Err(e) => {
            eprintln!("[tauri] 启动 Node.js 服务失败: {}", e);
            None
        }
    }
}

/// 判断某个 python3 是否具备本地 ASR 所需依赖。
///
/// 只校验 `python3 --version` 会被系统 Python（无 sherpa_onnx）蒙混过关，
/// 导致服务启动即崩、用户只看到「无法连接本地模型服务」。
///
/// 这里只做探测、不代用户安装：装什么、装到哪个环境由用户决定，
/// 缺失时前端会给出该解释器对应的 pip 命令。
fn python_has_asr_deps(path: &str) -> bool {
    Command::new(path)
        .args(["-c", "import sherpa_onnx, numpy, websockets"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .and_then(|mut c| c.wait())
        .map(|s| s.success())
        .unwrap_or(false)
}

fn start_asr_server(app_handle: &tauri::AppHandle) -> Option<Child> {
    let project_dir = resolve_project_dir(app_handle);

    // 优先启动捆绑的 ASR sidecar（pyinstaller 单文件，含 sherpa-onnx/numpy/websockets）
    if let Some(p) = find_sidecar(&project_dir, "asr-server") {
        println!("[tauri] 启动捆绑 ASR 服务 (sidecar): {:?}", p);
        match Command::new(&p)
            .current_dir(&project_dir)
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
        {
            Ok(mut child) => {
                if let Some(stderr) = child.stderr.take() {
                    let handle = app_handle.clone();
                    std::thread::spawn(move || {
                        use std::io::BufRead;
                        for line in std::io::BufReader::new(stderr).lines().map_while(Result::ok) {
                            eprintln!("[asr-sidecar] {}", line);
                            push_asr_log(&handle, line);
                        }
                    });
                }
                println!("[tauri] ASR sidecar 已启动 (PID: {})", child.id());
                return Some(child);
            }
            Err(e) => eprintln!("[tauri] 启动 ASR sidecar 失败: {}，回退系统 python", e),
        }
    }

    let server_py = project_dir.join("asr_local").join("server.py");

    if !server_py.exists() {
        println!("[tauri] asr_local/server.py 未找到，跳过本地 ASR 启动");
        return None;
    }

    // 探测顺序不变（Homebrew 优先），但要求依赖齐全；
    // 全部不齐时返回第一个可用解释器，由其降级为「可下载模型、不可识别」。
    let mut fallback: Option<String> = None;
    let mut python_bin: Option<String> = None;
    for candidate in [
        "/opt/homebrew/bin/python3",
        "/usr/local/bin/python3",
        "/usr/bin/python3",
    ] {
        if !std::path::Path::new(candidate).is_file() {
            continue;
        }
        if python_has_asr_deps(candidate) {
            python_bin = Some(candidate.to_string());
            break;
        }
        if fallback.is_none() {
            fallback = Some(candidate.to_string());
        }
    }

    let python_bin = match python_bin.or(fallback).or_else(|| find_binary("python3")) {
        Some(p) => p,
        None => {
            eprintln!("[tauri] 找不到 python3 可执行文件，本地模型管理不可用");
            return None;
        }
    };

    // 依赖缺失不阻止启动：服务会降级为「可下载模型、不可识别语音」，
    // 缺失详情经 /model/status 的 environment 字段由设置面板呈现。
    if !python_has_asr_deps(&python_bin) {
        eprintln!(
            "[tauri] {} 缺少本地 ASR 依赖（sherpa-onnx/numpy/websockets），本地识别将不可用；\
             请在应用「设置 → 本地模型」按提示安装",
            python_bin
        );
    }

    println!("[tauri] 启动本地 ASR ({}): {:?}", python_bin, server_py);

    match Command::new(&python_bin)
        .args(["-u", &server_py.to_string_lossy()])
        .current_dir(&project_dir)
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(mut child) => {
            println!("[tauri] 本地 ASR 已启动 (PID: {})", child.id());
            // 读回 stderr：Python 侧崩溃信息（缺依赖/端口占用/模型损坏）
            // 此前被 Stdio::piped() 吞掉，用户只剩一个无信息的 "Load failed"。
            if let Some(stderr) = child.stderr.take() {
                // 除了打到控制台，还进环形缓冲：打包后的 .app 没有控制台，
                // 设置页要拿这几行才能说清「模型服务未启动」到底是为什么。
                let handle = app_handle.clone();
                std::thread::spawn(move || {
                    use std::io::BufRead;
                    for line in std::io::BufReader::new(stderr).lines().map_while(Result::ok) {
                        eprintln!("[asr_local] {}", line);
                        push_asr_log(&handle, line);
                    }
                });
            }
            Some(child)
        }
        Err(e) => {
            eprintln!("[tauri] 启动本地 ASR 失败: {}", e);
            None
        }
    }
}

/// 轮询 HTTP 端口直到服务就绪
fn wait_for_http(url: &str, timeout_secs: u64) -> bool {
    let start = Instant::now();
    let timeout = Duration::from_secs(timeout_secs);

    while start.elapsed() < timeout {
        if let Ok(mut resp) = Command::new("curl")
            .args(["-s", "-o", "/dev/null", "-w", "%{http_code}", url])
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
        {
            let mut output = String::new();
            let _ = resp.stdout.take().map(|mut s| s.read_to_string(&mut output));
            if let Ok(status) = resp.wait() {
                if status.success() && output.trim() == "200" {
                    return true;
                }
            }
        }
        std::thread::sleep(Duration::from_millis(300));
    }
    false
}

/// 轮询 TCP 端口直到服务就绪（用于 ASR WebSocket 服务）
fn wait_for_tcp(host: &str, port: u16, timeout_secs: u64) -> bool {
    let start = Instant::now();
    let timeout = Duration::from_secs(timeout_secs);

    while start.elapsed() < timeout {
        if TcpStream::connect_timeout(
            &format!("{}:{}", host, port).parse().unwrap(),
            Duration::from_millis(500),
        ).is_ok() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(300));
    }
    false
}

/// 本机 ASR 服务日志的保留行数（一个 python traceback 通常二三十行，80 行够覆盖最近一次崩溃）
const ASR_LOG_CAP: usize = 80;

/// 记一行本机 ASR 服务日志（超出容量丢最早的）。
fn push_asr_log(app: &tauri::AppHandle, line: String) {
    if let Some(state) = app.try_state::<AppState>() {
        if let Ok(mut log) = state.asr_log.lock() {
            while log.len() >= ASR_LOG_CAP {
                log.pop_front();
            }
            log.push_back(line);
        }
    }
}

/// 本机是否有东西在监听这个端口（只连一下，不发数据）。
fn port_open(port: u16) -> bool {
    TcpStream::connect_timeout(
        &format!("127.0.0.1:{}", port).parse().unwrap(),
        Duration::from_millis(300),
    )
    .is_ok()
}

/// 应用数据目录。
///
/// 明确用 `com.rtc.transcriber` 覆盖 Tauri 的默认值：Tauri 的 `app_config_dir()` 由
/// bundle identifier 推导，而 identifier 是反向域名 `io.rtc.transcriber`，于是窗口状态
/// 落在 `~/Library/Application Support/io.rtc.transcriber/`，而 config.json、commands.json、
/// transcripts、两个模型目录全在 `com.rtc.transcriber/`（server.js、asr_local/server.py、
/// scripts/*.mjs 都写死这个）。同一个 App 在磁盘上摊成两个目录，用户「重置配置」时
/// 只能清掉一半。
///
/// 不能改 identifier（会切断自动更新的既有签名/产物匹配），所以这里显式覆盖。
fn rtc_support_dir(handle: &tauri::AppHandle) -> Option<PathBuf> {
    let base = handle.path().app_config_dir().ok()?;
    Some(base.parent()?.join("com.rtc.transcriber"))
}

fn window_state_path(handle: &tauri::AppHandle) -> Option<PathBuf> {
    let dir = rtc_support_dir(handle)?;
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join("window-state.json"))
}

fn read_window_state(handle: &tauri::AppHandle) -> Option<WindowState> {
    let content = std::fs::read_to_string(window_state_path(handle)?).ok()?;
    serde_json::from_str(&content).ok()
}

fn restore_window_state(handle: &tauri::AppHandle) {
    let Some(state) = read_window_state(handle) else {
        return;
    };
    let Some(window) = handle.webview_windows().into_values().next() else {
        return;
    };

    let width = state.width.max(480.0);
    let height = state.height.max(360.0);
    if state.maximized {
        let _ = window.maximize();
    } else {
        let _ = window.set_size(tauri::Size::Logical(tauri::LogicalSize::new(width, height)));
    }
}

fn persist_window_state(handle: &tauri::AppHandle, label: &str) {
    let Some(window) = handle.get_webview_window(label) else {
        return;
    };
    let Ok(scale) = window.scale_factor() else {
        return;
    };
    let Ok(size) = window.inner_size() else {
        return;
    };
    let logical = size.to_logical::<f64>(scale);
    let state = WindowState {
        width: logical.width,
        height: logical.height,
        maximized: window.is_maximized().unwrap_or(false),
    };
    let Some(path) = window_state_path(handle) else {
        return;
    };
    let Ok(json) = serde_json::to_string_pretty(&state) else {
        return;
    };
    let _ = std::fs::write(path, json);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(AppState {
            node_server: Mutex::new(None),
            asr_server: Mutex::new(None),
            asr_log: Mutex::new(VecDeque::new()),
        })
        .invoke_handler(tauri::generate_handler![
            paste_text,
            frontmost_app,
            app_icon,
            copy_to_clipboard,
            read_selected_text,
            activate_app,
            reveal_in_finder,
            accessibility_permission,
            request_accessibility_permission,
            local_asr_status,
            restart_local_asr,
            set_tray_status
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            restore_window_state(&handle);

            // 菜单栏图标：常驻一个「待命」图标，之后由前端按状态换图换字（见 set_tray_status）。
            // 点一下把主界面拿到前面——图标只回答「在不在工作」，具体状态和下一步在主界面里，
            // 所以不做第二套菜单（同一个状态只在一个地方说）。
            {
                let mut builder = TrayIconBuilder::with_id(TRAY_ID)
                    .show_menu_on_left_click(false)
                    .tooltip("实时逐字稿")
                    .on_tray_icon_event(|tray, event| {
                        if let TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            ..
                        } = event
                        {
                            focus_main_window(tray.app_handle());
                        }
                    });
                if let Some(bytes) = tray_glyph_bytes("idle") {
                    if let Ok(img) = Image::from_bytes(bytes) {
                        builder = builder.icon(img).icon_as_template(true);
                    }
                }
                match builder.build(&handle) {
                    Ok(_) => println!("[tauri] 菜单栏图标已创建"),
                    // 建不出来也不拦启动：主界面照旧，只是少了一个后台状态出口
                    Err(e) => eprintln!("[tauri] 菜单栏图标创建失败: {e}"),
                }
            }

            // 系统级全局热键 ⌥⌘P：切换「自动粘贴」。
            // 为什么需要全局：典型场景是在别的应用里打字时临时开/关粘贴，
            // 切回本窗口会打断输入（应用内已有的 ⌘⇧V 只在窗口聚焦时有效）。
            // 注册失败（被别的进程占用等）不影响启动，只打印警告。
            {
                use tauri::Emitter;
                use tauri_plugin_global_shortcut::{
                    Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState,
                };
                let toggle_paste = Shortcut::new(Some(Modifiers::ALT | Modifiers::META), Code::KeyP);
                app.handle().plugin(
                    tauri_plugin_global_shortcut::Builder::new()
                        .with_handler(move |app, _shortcut, event| {
                            // 按下触发一次（松开不再触发）
                            if event.state() == ShortcutState::Pressed {
                                let _ = app.emit("rtc:toggle-auto-paste", ());
                            }
                        })
                        .build(),
                )?;
                match app.global_shortcut().register(toggle_paste) {
                    Ok(()) => println!("[tauri] 全局热键已注册: ⌥⌘P = 切换自动粘贴"),
                    Err(e) => eprintln!("[tauri] 全局热键 ⌥⌘P 注册失败: {e}"),
                }
            }

            let is_dev = cfg!(debug_assertions);

            // 生产/打包版：清理上一轮残留进程后自启全套服务（端口被占时旧服务是最可能的来源）。
            // dev 模式：不杀任何已有进程——8931 可能由 npm run dev:web（dev.mjs）提供，
            // 8932/8933 可能由上轮残留或被复用的 ASR 占用；直接复用监听中的服务，
            // 缺失才补齐启动，避免重复起服务/会话中途被杀导致「停止录音后无法再开始」。
            let (node_child, node_reused) = if is_dev {
                if wait_for_tcp("127.0.0.1", 8931, 1) {
                    println!("[tauri] dev: 复用已有 Node 服务 (127.0.0.1:8931)");
                    (None, true)
                } else {
                    (start_node_server(&handle), false)
                }
            } else {
                kill_previous_processes(8931);
                kill_previous_processes(8932);
                kill_previous_processes(8933);
                (start_node_server(&handle), false)
            };
            let node_started = node_child.is_some();
            if let Some(child) = node_child {
                let state = app.state::<AppState>();
                *state.node_server.lock().unwrap() = Some(child);
            }

            let (asr_child, asr_reused) = if is_dev {
                if wait_for_tcp("127.0.0.1", 8932, 1) {
                    println!("[tauri] dev: 复用已有本地 ASR (127.0.0.1:8932)");
                    (None, true)
                } else {
                    (start_asr_server(&handle), false)
                }
            } else {
                (start_asr_server(&handle), false)
            };
            let asr_started = asr_child.is_some();
            if let Some(child) = asr_child {
                let state = app.state::<AppState>();
                *state.asr_server.lock().unwrap() = Some(child);
            }

            // 轮询等待 Node.js 服务就绪。
            //
            // 15 秒是不够的：node-server 是 bun 编译的单文件，首次启动要先解包，
            // 冷启动实测可到十几秒。原来的 15 秒会在正常启动路径上误判成「未就绪」，
            // 而它打印的只是一行 eprintln——Finder 启动的 .app 根本没有 stderr，
            // 于是用户看到的是「服务未连接」却没有任何原因。
            let node_ready = if node_reused || !node_started {
                true
            } else {
                wait_for_http("http://127.0.0.1:8931", 45)
            };
            if node_ready {
                if !node_started {
                    eprintln!("[tauri] 警告: Node 服务未能启动（sidecar/node/server.js 均不可用）");
                } else {
                    println!("[tauri] Node.js 服务就绪");
                }
            } else {
                eprintln!("[tauri] 警告: Node.js 服务未在 45 秒内就绪，继续启动窗口");
            }

            // 轮询等待本地 ASR 就绪（最多 30 秒，模型加载约 2-3 秒）
            if asr_started || asr_reused {
                let asr_ready = if asr_reused { true } else { wait_for_tcp("127.0.0.1", 8932, 30) };
                if asr_ready {
                    println!("[tauri] 本地 ASR 就绪");
                } else {
                    eprintln!("[tauri] 警告: 本地 ASR 未在 30 秒内就绪");
                }
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                let label = window.label().to_string();
                persist_window_state(window.app_handle(), &label);
                cleanup_server(&window, "node");
                cleanup_server(&window, "asr");
            }
        })
        .build(tauri::generate_context!())
        .expect("启动 Tauri 应用失败");

    app.run(|handle, event| {
        if matches!(
            event,
            tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
        ) {
            // 先杀 sidecar，再存窗口状态：⌘Q 也要清干净，别留孤儿进程和占用端口。
            cleanup_all_servers(&handle.state::<AppState>());
            if let Some((label, _window)) = handle.webview_windows().into_iter().next() {
                persist_window_state(handle, &label);
            }
        }
    });
}

fn cleanup_server(window: &tauri::Window, which: &str) {
    let child = {
        let state = window.state::<AppState>();
        let mut guard = match which {
            "node" => state.node_server.lock().unwrap(),
            _ => state.asr_server.lock().unwrap(),
        };
        guard.take()
    };
    if let Some(mut c) = child {
        let _ = c.kill();
        let _ = c.wait();
    }
}

/// 退出时杀掉两个 sidecar。
///
/// 原来只有 `CloseRequested`（红叉 / ⌘W）会走到 `cleanup_server`；macOS 的 ⌘Q、
/// 菜单里的「退出」、更新后的 `process.relaunch()` 走的都是
/// `RunEvent::ExitRequested` / `Exit`，那条路径只保存了窗口状态。结果是退出 App 后
/// node-server 和 434MB 的 asr-server 变成孤儿进程，8931/8932/8933 三个端口一直被占着，
/// 下次启动只能靠 `kill -9` 抢回来。这里按 `AppState` 取句柄，两条退出路径都能用。
fn cleanup_all_servers(state: &AppState) {
    for slot in [&state.node_server, &state.asr_server] {
        let child = slot.lock().map(|mut guard| guard.take()).ok().flatten();
        if let Some(mut c) = child {
            let _ = c.kill();
            let _ = c.wait();
        }
    }
}

#[cfg(test)]
mod tray_tests {
    use super::*;

    /// 每个字形必须都能解码，而且**画布尺寸完全一致**（36×36 = 18×18pt 的 @2x）。
    ///
    /// 尺寸一致这条比看起来重要：菜单栏那一格的宽度虽然由 `TRAY_SLOT_WIDTH` 定死，
    /// 但图形本身的画布一旦不一样大，图标在格子里的视觉大小就会跳（说话是每句话都会发生的事）。
    ///
    /// 这条测试为什么值得存在：`set_tray_status` 拿不到图片时是「静默不换图」——
    /// 图片改错名、被误删、或换了非 PNG 格式，菜单栏会**继续显示上一个状态的图标**，
    /// 界面不报错、日志不报错，只有用户看得见那句假状态。这正是产品原则 3 要禁的假状态。
    #[test]
    fn tray_glyphs_decode() {
        let mut canvas = None;
        for glyph in ["idle", "dot", "speaking", "mic-off", "service-error"] {
            let bytes = tray_glyph_bytes(glyph).unwrap_or_else(|| panic!("字形 {glyph} 没有图片"));
            let img = Image::from_bytes(bytes).unwrap_or_else(|e| panic!("字形 {glyph} 解码失败: {e}"));
            let size = (img.width(), img.height());
            assert_eq!(size, (36, 36), "字形 {glyph} 画布尺寸不对（应为 36×36 = 18×18pt 的 @2x）");
            match canvas {
                None => canvas = Some(size),
                Some(c) => assert_eq!(c, size, "字形 {glyph} 和别的字形画布不一样大，切换时会把旁边的图标推来推去"),
            }
        }
        assert!(tray_glyph_bytes("not-a-glyph").is_none(), "未定义字形应返回 None，而不是猜一个");
    }
}
