// js/updater.js — 应用内更新（Tauri updater + GitHub Releases）
// 依赖 withGlobalTauri 注入的 window.__TAURI__.updater / .process / .app
import { $, toast } from './ui.js';

export const UPDATE_STATE = {
  checking: false,
  installing: false,
  available: null,
};

export async function getAppVersion() {
  try {
    return await window.__TAURI__.app.getVersion();
  } catch {
    return '1.0.16';
  }
}

export async function updateVersionBadge() {
  const badge = $('versionBadge');
  if (badge) badge.textContent = 'v' + (await getAppVersion());
}

function setUpdateStatus(text) {
  const el = $('updateStatus');
  if (el) el.textContent = text;
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
      setUpdateStatus(`已是最新版本（v${await getAppVersion()}）`);
      if (manual) toast('已是最新版本');
    }
  } catch (e) {
    console.error('[updater] check failed:', e);
    hideUpdateBanner();
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
  try {
    await update.downloadAndInstall((ev) => {
      if (!ev || ev.event !== 'Progress' || !ev.data) return;
      const p = ev.data.percent;
      if (typeof p === 'number') {
        setUpdateStatus(`正在下载更新 ${p.toFixed(0)}%…`);
      } else if (ev.data.downloaded) {
        setUpdateStatus(`正在下载更新…（${Math.round(ev.data.downloaded / 1048576)} MB）`);
      }
    });
    setUpdateStatus('更新下载完成，正在重启应用…');
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
