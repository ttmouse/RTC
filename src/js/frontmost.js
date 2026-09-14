/**
 * 「现在最前面的是哪个应用」—— 也就是这次 Cmd+V 会打到谁身上。
 *
 * 只在「这一次定型会真的自动粘贴」时调用（见 asr.js），拿到的名字随这句话
 * 一起入库，于是记录里能看出「这句是发到微信的」。自动粘贴发生时本窗口在
 * 后台，所以前台就是收到文字的那个软件。
 *
 * 拿不到就返回 null，绝不抛错、也不阻塞：认不认识目标，跟这句话该不该被
 * 记下来无关（产品原则 4：旁路不能挡住主路径）。以下情况都会是 null ——
 * 前台是本程序自己（说明按键打回了本窗口，没有输入框能接住）、网页版没有
 * 系统级能力、以及查询本身失败。
 */
export async function getFrontmostApp() {
  const invoke = window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke;
  if (!invoke) return null;
  try {
    // 桌面端由 Rust 侧查 NSWorkspace（微秒级、不需要额外权限）。
    // 不用 osascript 问 System Events：那要约 150ms 且依赖辅助功能权限，
    // 详见 src-tauri/src/mac_frontmost.rs。
    return (await invoke('frontmost_app')) || null;
  } catch (e) {
    console.error('[frontmost] 取前台应用失败:', e);
    return null;
  }
}
