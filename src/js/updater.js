// js/updater.js — 应用内更新（Tauri updater + GitHub Releases）
// 依赖 withGlobalTauri 注入的 window.__TAURI__.updater / .process / .app
import { $, toast } from './ui.js';
import { apiUrl } from './api.js';

export const UPDATE_STATE = {
  checking: false,
  installing: false,
  available: null,
};

/**
 * 应用版本号。桌面端以 Tauri 为准；网页端向本地服务取（服务端读的是 package.json），
 * 这样版本号只有 package.json 一处来源，前端不必各写一份。
 */
export async function getAppVersion() {
  try {
    return await window.__TAURI__.app.getVersion();
  } catch {
    /* 非 Tauri 环境（浏览器 / 开发网页端），走下面的服务端查询 */
  }
  try {
    const r = await fetch(apiUrl('/api/status'));
    const data = await r.json();
    if (data && data.version) return data.version;
  } catch {
    /* 服务不可达 */
  }
  return null;
}

/** 首屏落一次版本信息（唯一显示处是设置页「软件更新」里的状态行） */
export async function updateVersionInfo() {
  const version = await getAppVersion();
  if (version) setUpdateStatus(`当前版本 v${version}`);
}

function setUpdateStatus(text) {
  const el = $('updateStatus');
  if (el) el.textContent = text;
}

// ---------- 进度条 ----------
// Tauri updater 的 DownloadEvent 形如 { event, data }：
//   Started  -> data.contentLength（可能为 null）
//   Progress -> data.chunkLength（单块字节数，需自行累加）
//   Finished -> 无 data
// 插件不提供累计字节/百分比，所以这里自己累加。

function updateProgressEls() {
  return ['updateProgress', 'updateBannerProgress']
    .map((id) => $(id))
    .filter(Boolean);
}

function resetUpdateProgress() {
  updateProgressEls().forEach((wrap) => {
    wrap.classList.add('hidden');
    wrap.classList.remove('indeterminate');
    const fill = wrap.querySelector('.update-progress-fill');
    const text = wrap.querySelector('.update-progress-text');
    if (fill) fill.style.width = '0%';
    if (text) text.textContent = '0%';
  });
}

function renderUpdateProgress({ percent = 0, indeterminate = false, label = '处理中' }) {
  updateProgressEls().forEach((wrap) => {
    wrap.classList.remove('hidden');
    wrap.classList.toggle('indeterminate', indeterminate);
    const fill = wrap.querySelector('.update-progress-fill');
    const text = wrap.querySelector('.update-progress-text');
    if (indeterminate) {
      // 清掉 inline 宽度，否则会盖住 CSS 的 35% 扫动宽度
      if (fill) fill.style.width = '';
      if (text) text.textContent = label;
      return;
    }
    const p = Math.max(0, Math.min(100, percent));
    if (fill) fill.style.width = p + '%';
    if (text) text.textContent = p.toFixed(0) + '%';
  });
}

function fmtMB(bytes) {
  return Math.round((bytes || 0) / 1048576) + ' MB';
}

export function showUpdateBanner(update) {
  const banner = $('updateBanner');
  if (!banner) return;
  const text = $('updateBannerText');
  if (text) {
    const date = update.date ? `（${String(update.date).slice(0, 10)}）` : '';
    text.textContent = `发现新版本 v${update.version}${date}`;
  }
  banner.classList.remove('hidden');
}

export function hideUpdateBanner() {
  const banner = $('updateBanner');
  if (banner) banner.classList.add('hidden');
}

/** 检查更新。manual=true 时显示 toast；否则静默，有更新时弹横幅提醒。 */
export async function checkForUpdates(manual = false) {
  if (UPDATE_STATE.checking) return;
  if (!window.__TAURI__ || !window.__TAURI__.updater) {
    if (manual) toast('当前运行环境不支持在线更新');
    return;
  }
  UPDATE_STATE.checking = true;
  if (manual) setUpdateStatus('正在检查更新…');
  try {
    const update = await window.__TAURI__.updater.check();
    UPDATE_STATE.available = update;
    if (update) {
      setUpdateStatus(`发现新版本 v${update.version}`);
      showUpdateBanner(update);
      if (manual) toast(`发现新版本 v${update.version}，点击横幅立即更新`);
    } else {
      hideUpdateBanner();
      resetUpdateProgress();
      // 版本号缺失时（服务不可达）不显示 "vnull"
      const latest = await getAppVersion();
      setUpdateStatus(latest ? `已是最新版本（v${latest}）` : '已是最新版本');
      if (manual) toast('已是最新版本');
    }
  } catch (e) {
    console.error('[updater] check failed:', e);
    hideUpdateBanner();
    resetUpdateProgress();
    setUpdateStatus(`检查更新失败：${e.message || e}`);
    if (manual) toast('检查更新失败：' + (e.message || e));
  } finally {
    UPDATE_STATE.checking = false;
  }
}

/** 下载并安装已发现的更新，完成后自动重启应用。 */
export async function installUpdate() {
  const update = UPDATE_STATE.available;
  if (!update || UPDATE_STATE.installing) return;
  UPDATE_STATE.installing = true;
  const btn = $('updateInstallBtn');
  if (btn) btn.disabled = true;
  setUpdateStatus('正在下载更新…');
  resetUpdateProgress();
  renderUpdateProgress({ indeterminate: true, label: '连接中' });
  let downloaded = 0;
  let total = 0;
  try {
    await update.downloadAndInstall((ev) => {
      if (!ev || !ev.event) return;
      const data = ev.data || {};
      if (ev.event === 'Started') {
        total = typeof data.contentLength === 'number' ? data.contentLength : 0;
        downloaded = 0;
        if (total > 0) {
          renderUpdateProgress({ percent: 0 });
        } else {
          renderUpdateProgress({ indeterminate: true, label: '下载中' });
        }
      } else if (ev.event === 'Progress') {
        downloaded += data.chunkLength || 0;
        if (total > 0) {
          const p = (downloaded / total) * 100;
          renderUpdateProgress({ percent: p });
          setUpdateStatus(`正在下载更新 ${p.toFixed(0)}%（${fmtMB(downloaded)} / ${fmtMB(total)}）…`);
        } else {
          renderUpdateProgress({ indeterminate: true, label: fmtMB(downloaded) });
          setUpdateStatus(`正在下载更新…（已下载 ${fmtMB(downloaded)}）`);
        }
      } else if (ev.event === 'Finished') {
        // 下载结束，接下来是解压/安装，总量未知 -> 不确定态
        renderUpdateProgress({ indeterminate: true, label: '安装中' });
        setUpdateStatus('更新下载完成，正在安装…');
      }
    });
    resetUpdateProgress();
    setUpdateStatus('更新安装完成，正在重启应用…');
    toast('更新完成，正在重启应用…');
    setTimeout(() => {
      try {
        window.__TAURI__.process.relaunch();
      } catch (e) {
        console.error('[updater] relaunch failed:', e);
        setUpdateStatus('更新已安装，请手动重启应用生效');
      }
    }, 800);
  } catch (e) {
    console.error('[updater] install failed:', e);
    resetUpdateProgress();
    setUpdateStatus('更新失败，请重试');
    toast('更新失败：' + (e.message || e));
    if (btn) btn.disabled = false;
    UPDATE_STATE.installing = false;
  }
}

export function setupUpdateUI() {
  const checkBtn = $('checkUpdateBtn');
  if (checkBtn) checkBtn.onclick = () => checkForUpdates(true);
  const installBtn = $('updateInstallBtn');
  if (installBtn) installBtn.onclick = installUpdate;
  const closeBtn = $('updateBannerClose');
  if (closeBtn) closeBtn.onclick = hideUpdateBanner;
}
