/**
 * 「现在最前面的是哪个应用、它是谁」—— 也就是这次 Cmd+V 会打到谁身上。
 *
 * 自动粘贴总闸开着时就问一句（见 asr.js 的 resolvePaste）：名单是按应用分的，
 * 不知道目标就判不出「这次该不该粘」。拿到的身份有两个去处：决定粘不粘、以及随
 * 这句话一起入库（记录里能看出「这句是发到微信的」）。自动粘贴发生时本窗口在
 * 后台，所以前台就是收到文字的那个软件。
 *
 * 返回 `{ name, bundle, id }`：`name` 是 macOS 显示名（"微信"），`bundle` 是 `.app`
 * 包名（"WeChat"），`id` 是 bundle id。**三个都要**——设置页的名单存的是包名
 * （系统应用列表给的），这里给的是显示名，两个名字经常不一样，判定必须按身份匹配
 * （见 settings.appInList 里记的那次事故：名单里存着 WeChat，前台回的是微信）。
 *
 * 拿不到就返回 null，绝不抛错、也不阻塞：认不认识目标，跟这句话该不该被记下来无关
 * （产品原则 4：旁路不能挡住主路径）。以下情况都会是 null —— 前台是本程序自己
 * （说明按键打回了本窗口，没有输入框能接住）、网页版没有系统级能力、以及查询本身失败。
 */
export async function getFrontmostApp() {
  const invoke = window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke;
  if (!invoke) return null;
  try {
    // 桌面端由 Rust 侧查 NSWorkspace（微秒级、不需要额外权限）。
    // 不用 osascript 问 System Events：那要约 150ms 且依赖辅助功能权限，
    // 详见 src-tauri/src/mac_frontmost.rs。
    const info = await invoke('frontmost_app');
    if (!info) return null;
    // 旧版后端只回一个显示名字符串（开发模式下前端会被热更新、Rust 侧要整体重启才会变）。
    // 这里兼容成同一个形状，并如实说明少了什么——否则用户看到的是「明明加了微信却不粘」，
    // 而真正的原因（后端没重启，拿不到包名）一个字都没露出来。
    if (typeof info === 'string') {
      console.warn('[frontmost] 后端返回的是旧格式（只有显示名）：改过 Rust 后需要整体重启 dev 才会带上包名 / bundle id');
      return { name: info, bundle: null, id: null };
    }
    return info;
  } catch (e) {
    console.error('[frontmost] 取前台应用失败:', e);
    return null;
  }
}
