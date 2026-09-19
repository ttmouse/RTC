import { state } from './state.js';
import { toast } from './ui.js';
import { apiUrl } from './api.js';
import { playPaste } from './sfx.js';

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

  // 粘贴结果只有这一处分流：Tauri 与 HTTP 两条路径共用，避免以后再加通道时
  // 漏掉音效、或各写一份重复发声（UX.FEEDBACK.001：同一动作共享同一反馈）。
  // 只在真正发出 Cmd+V 后出声：clipboard_only 表示被 macOS 拦下且已有报错 toast，
  // 此时再补一声「成功」音只会误导用户。
  const afterPaste = (status, source) => {
    if (status === 'clipboard_only') {
      logTiming('paste.done_clipboard_only');
      console.log(`[paste] ${source} 完成（仅剪贴板，无自动粘贴）`);
      return status;
    }
    logTiming('paste.done');
    console.log(`[paste] ${source} Cmd+V 已发送`);
    playPaste();
    return status;
  };
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
    return tauriInvoke('paste_text', { text, autoEnter })
      .then(result => {
        const status = result && typeof result === 'object' ? result.status : result;
        return afterPaste(status, 'Tauri paste');
      })
      .catch(reportPasteError);
  }

  const endpoint = apiUrl('/paste');
  return fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, autoEnter }),
  })
    .then(async res => {
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
      return afterPaste(data.warn === 'auto_paste_disabled' ? 'clipboard_only' : 'ok', '服务端 paste');
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
