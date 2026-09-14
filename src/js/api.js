/**
 * 后端地址的唯一来源。
 *
 * 这套前端可以在三种宿主里跑：Node 服务托管的网页（:8931）、Tauri 打包后的
 * tauri://localhost、以及开发时直接在浏览器里开。旧代码把
 * `location.port === '8931' ? '' : 'http://127.0.0.1:8931'` 抄了四份
 * （main.js / storage.js / clipboard.js / asr.js），改端口要改四个地方，
 * 漏一个就是「部分功能连得上、部分功能连接被拒」这种最难查的毛病。
 *
 * 规则很简单：页面本身就是 http(s) 提供的，就和后端同源，用相对路径（不发跨域请求）；
 * 否则（tauri:// 自定义协议）才回落到硬编码回环地址。
 */
export function apiBase() {
  return location.protocol === 'http:' || location.protocol === 'https:'
    ? ''
    : 'http://127.0.0.1:8931';
}

/** 拼出后端 HTTP 接口地址。传 '/api/config' 这种前导斜杠路径。 */
export function apiUrl(path) {
  return apiBase() + path;
}

/** 后端 WebSocket 代理地址：同源时跟随当前 host，自定义协议回落到回环地址。 */
export function wsProxyUrl() {
  const base = apiBase();
  if (!base) {
    return `ws://${location.host}`;
  }
  return base.replace(/^http/, 'ws');
}
