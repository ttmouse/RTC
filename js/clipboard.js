import { state } from './state.js';
import { toast } from './ui.js';

export function pasteToCursor(text, autoEnter) {
  const t0 = performance.now();
  const logTiming = (stage, ok = true) => {
    console.log('[timing-js]', JSON.stringify({
      stage,
      ms: Math.round((performance.now() - t0) * 10) / 10,
      textLen: text.length,
      ok,
    }));
  };
  console.log('[paste] 进入粘贴, text:', text.slice(0, 30), 'autoEnter:', autoEnter);
  const tauriInvoke = window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke;
  const reportPasteError = e => {
    const msg = (e && e.message) ? e.message : String(e);
    logTiming('paste.error', false);
    console.error('[paste] 失败:', e);
    if (/1002|assistive|辅助功能|not allowed to send keystrokes/i.test(msg)) {
      toast('自动粘贴被 macOS 拦截：请开启“辅助功能”权限后再试');
      ensurePastePermission();
    } else {
      toast('粘贴失败：' + msg);
    }
  };

  if (tauriInvoke) {
    tauriInvoke('paste_text', { text, autoEnter })
      .then(result => {
        const status = result && typeof result === 'object' ? result.status : result;
        if (status === 'clipboard_only') {
          logTiming('paste.done_clipboard_only');
          console.log('[paste] Tauri paste 完成（仅剪贴板，无自动粘贴）');
          toast('已复制到剪贴板，请手动 Cmd+V 粘贴');
        } else {
          logTiming('paste.done');
          console.log('[paste] Tauri Cmd+V 已发送');
        }
      })
      .catch(reportPasteError);
    return;
  }

  const endpoint = (location.protocol === 'http:' || location.protocol === 'https:') && location.port === '8931'
    ? '/paste'
    : 'http://127.0.0.1:8931/paste';
  fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, autoEnter }),
  })
    .then(async res => {
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
      if (data.warn === 'auto_paste_disabled') {
        logTiming('paste.done_clipboard_only');
        console.log('[paste] 服务端 paste 完成（仅剪贴板，无自动粘贴）');
        toast('已复制到剪贴板，请手动 Cmd+V 粘贴');
      } else {
        logTiming('paste.done');
        console.log('[paste] 服务端 paste 成功');
      }
    })
    .catch(reportPasteError);
}

export async function ensurePastePermission() {
  const tauriInvoke = window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke;
  if (!tauriInvoke) return true;
  try {
    const trusted = await tauriInvoke('accessibility_permission');
    if (trusted) return true;
    if (!state.pastePermPrompting) {
      state.pastePermPrompting = true;
      toast('自动粘贴需要“辅助功能”权限：请在系统设置中允许“实时逐字稿”，然后重试一句');
      tauriInvoke('request_accessibility_permission')
        .catch(e => console.error('[paste] 权限申请失败:', e))
        .finally(() => { state.pastePermPrompting = false; });
    }
    return false;
  } catch (e) {
    console.error('[paste] 权限检查失败:', e);
    return false;
  }
}

export function copyToSystemClipboard(text) {
  const t0 = performance.now();
  const tauriInvoke = window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke;
  const copyTask = tauriInvoke
    ? tauriInvoke('copy_to_clipboard', { text }).catch(e => {
        console.error('[clipboard] Tauri 复制失败，尝试 Web Clipboard:', e);
        return navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject(e);
      })
    : navigator.clipboard
      ? navigator.clipboard.writeText(text)
      : Promise.reject(new Error('剪贴板 API 不可用'));

  copyTask
    .then(() => {
      console.log('[timing-js]', JSON.stringify({
        stage: 'clipboard.done',
        ms: Math.round((performance.now() - t0) * 10) / 10,
        textLen: text.length,
        ok: true,
      }));
      console.log('[clipboard] 复制成功:', text.slice(0, 30));
    })
    .catch(e => {
      const msg = (e && e.message) ? e.message : String(e);
      console.log('[timing-js]', JSON.stringify({
        stage: 'clipboard.error',
        ms: Math.round((performance.now() - t0) * 10) / 10,
        textLen: text.length,
        ok: false,
      }));
      console.error('[clipboard] 复制失败:', e);
      toast('复制到系统剪贴板失败：' + msg);
    });
}
