use std::io::Read;
use std::path::PathBuf;
use std::process::{Command, Child, Stdio};
use std::sync::Mutex;
use std::net::TcpStream;
use std::time::{Duration, Instant};
use tauri::Manager;

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
#[tauri::command]
fn copy_to_clipboard(text: String) -> Result<String, String> {
    let start = Instant::now();
    write_clipboard(&text)?;
    log_timing("copy_to_clipboard.total", start.elapsed());
    Ok("ok".into())
}

/// 粘贴文本到当前光标位置（通用粘贴）。
///
/// 只做两件事：把文本写入系统剪贴板，然后无条件向系统发送 Cmd+V。
/// 不做任何前台应用 / AX 输入框判断——用户可能在任意可输入处使用
/// （微信、Codex、浏览器、甚至本软件自己的控制台），自绘 UI 不暴露
/// AX 焦点，白名单式判断只会误拦截。`ok` 只表示按键已发出；是否真正
/// 写入目标输入框由目标应用决定。
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

    let cmd = if auto_enter.unwrap_or(false) {
        concat!(
            "delay 0.1\n",
            "tell application \"System Events\"\n",
            "  keystroke \"v\" using command down\n",
            "  delay 0.3\n",
            "  keystroke return\n",
            "end tell",
        )
    } else {
        "tell application \"System Events\" to keystroke \"v\" using command down"
    };

    let paste_start = Instant::now();
    let outcome = match run_osascript(cmd) {
        Ok(_) => PasteOutcome { status: "ok" },
        Err(e) => {
            eprintln!("[paste] osascript 失败（降级为仅剪贴板）: {}", e);
            PasteOutcome {
                status: "clipboard_only",
            }
        }
    };
    log_timing("paste_text.osascript", paste_start.elapsed());
    log_timing("paste_text.total", start.elapsed());
    Ok(outcome)
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

/// 启动 Node.js 服务（server.js）
fn start_node_server(app_handle: &tauri::AppHandle) -> Option<Child> {
    let project_dir = resolve_project_dir(app_handle);
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

fn start_asr_server(app_handle: &tauri::AppHandle) -> Option<Child> {
    let project_dir = resolve_project_dir(app_handle);
    let server_py = project_dir.join("asr_local").join("server.py");

    if !server_py.exists() {
        println!("[tauri] asr_local/server.py 未找到，跳过本地 ASR 启动");
        return None;
    }

    let python_bin = match find_binary("python3") {
        Some(p) => p,
        None => {
            eprintln!("[tauri] 找不到 python3 可执行文件");
            return None;
        }
    };

    println!("[tauri] 启动本地 ASR ({}): {:?}", python_bin, server_py);

    match Command::new(python_bin)
        .args(["-u", &server_py.to_string_lossy()])
        .current_dir(&project_dir)
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(child) => {
            println!("[tauri] 本地 ASR 已启动 (PID: {})", child.id());
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

fn window_state_path(handle: &tauri::AppHandle) -> Option<PathBuf> {
    let dir = handle.path().app_config_dir().ok()?;
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
        })
        .invoke_handler(tauri::generate_handler![
            paste_text,
            copy_to_clipboard,
            accessibility_permission,
            request_accessibility_permission
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            restore_window_state(&handle);

            // 启动 Node.js 服务
            let node_child = start_node_server(&handle);
            if let Some(child) = node_child {
                let state = app.state::<AppState>();
                *state.node_server.lock().unwrap() = Some(child);
            }

            // 启动本地 ASR
            let asr_started = {
                let asr_child = start_asr_server(&handle);
                let started = asr_child.is_some();
                if let Some(child) = asr_child {
                    let state = app.state::<AppState>();
                    *state.asr_server.lock().unwrap() = Some(child);
                }
                started
            };

            // 轮询等待 Node.js 服务就绪（最多 15 秒）
            let node_ready = wait_for_http("http://127.0.0.1:8931", 15);
            if node_ready {
                println!("[tauri] Node.js 服务就绪");
            } else {
                eprintln!("[tauri] 警告: Node.js 服务未在 15 秒内就绪，继续启动窗口");
            }

            // 轮询等待本地 ASR 就绪（最多 30 秒，模型加载约 2-3 秒）
            if asr_started {
                let asr_ready = wait_for_tcp("127.0.0.1", 8932, 30);
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
