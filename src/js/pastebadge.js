/**
 * 记录行内的「这句去哪了」徽标。
 *
 * 用户的原话（2026-09-18）：「在每一条历史记录这里面去展示当前这条历史记录它有没有
 * 粘贴到目标应用……在上面相联软件列表里面，他就可以看到这一句消息是发生到哪里的。」
 * （先前把它做成了底栏一格「最近一句」，那是错的：去向是**每条记录**的属性。）
 *
 * 一行一个标记，贴在内容左侧，表示说这句话时的前台应用，不表示粘贴结果。
 * 粘贴结果由正文颜色表达，避免把「在哪个应用说话」和「有没有粘贴」混成一个状态。
 * 应用图标拿不到时退回应用名文字；没有前台快照时不伪造图标。
 */

/** 粘出去了：徽标规格（纯函数，便于单测） */
export function pasteBadgeSpec({ paste, appName = null } = {}) {
  if (!paste) return { kind: 'none', name: null, label: '没粘出去' };
  return { kind: 'app', name: appName || '', label: appName ? `已粘给 ${appName}` : '已粘出去' };
}

/** 说话时的前台应用快照，只负责展示当时用户在哪个应用里。 */
export function specFromActiveApp(activeApp) {
  const name = typeof activeApp === 'string' ? activeApp : activeApp?.name;
  return name
    ? { kind: 'app', name: String(name), label: `说话时前台应用：${name}` }
    : { kind: 'none', name: null, label: '说话时未识别前台应用' };
}

// 兼容旧调用方和旧测试：旧字段代表粘贴去向，不改变旧徽标语义。
export function specFromTargetApp(appName) {
  return appName
    ? { kind: 'app', name: String(appName), label: `已粘给 ${appName}` }
    : { kind: 'none', name: null, label: '没粘出去' };
}

// 图标按名字缓存：同一个应用（以及往前翻页的每一行）一个会话只问系统一次
const iconCache = new Map();

const tauriInvoke = () =>
  (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke) || null;

function loadIcon(name) {
  if (iconCache.has(name)) return Promise.resolve(iconCache.get(name));
  const invoke = tauriInvoke();
  if (!invoke) {
    // 网页版没有系统级能力：记住「问过了、没有」，别重复问
    iconCache.set(name, null);
    return Promise.resolve(null);
  }
  return invoke('app_icon', { name })
    .then(url => {
      iconCache.set(name, url || null);
      return url || null;
    })
    .catch(e => {
      console.error('[pastebadge] 取应用图标失败:', e);
      iconCache.set(name, null);
      return null;
    });
}

/** 已粘贴标记：Lucide 风格的线条图标，直接插入正文末尾。 */
const PASTE_DONE_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m20 6-11 11-5-5"/></svg>';

/** 旧徽标测试与兼容数据仍保留的未粘贴标记 */
const SKIP_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
  'stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/>' +
  '<line x1="6.6" y1="17.4" x2="17.4" y2="6.6"/></svg>';

/**
 * 给一行贴上徽标。只写徽标自己那一个元素（`.pasteBadge`），行里别的东西一概不碰：
 * 行是历史记录，内容必须保持原样。图标是异步取的，回来时若这一行已经被换掉
 * （重新渲染）就丢掉——用 `isConnected` 判断，不做全局序号。
 */
export function setLineTarget(lineEl, spec) {
  if (!lineEl || !spec) return;
  let badge = lineEl.querySelector('.pasteBadge');
  if (!badge) {
    badge = document.createElement('span');
    badge.className = 'pasteBadge';
    const textEl = lineEl.querySelector('.txt');
    if (textEl) lineEl.insertBefore(badge, textEl);
    else lineEl.appendChild(badge);
  }
  badge.dataset.kind = spec.kind;
  badge.setAttribute('aria-label', spec.label);
  if (spec.kind !== 'app') {
    // 没有前台应用快照时不伪造一个状态图标，文本状态单独表达粘贴结果。
    badge.innerHTML = '';
    return;
  }
  // 名字先摆进去：图标要等系统回话，拿不到图标时就让它一直当文字用（网页版也是这样）
  if (!spec.name) {
    badge.textContent = '';
    return;
  }
  badge.textContent = '';   // 这一行可能复用了旧徽标，先把上一次的内容清掉
  const nameEl = document.createElement('span');
  nameEl.className = 'pasteBadgeName';
  nameEl.textContent = spec.name;
  badge.appendChild(nameEl);
  loadIcon(spec.name).then(url => {
    if (!url || !badge.isConnected) return;
    const img = document.createElement('img');
    img.alt = '';
    img.width = 15;
    img.height = 15;
    img.src = url;
    badge.textContent = '';
    badge.appendChild(img);
  });
}

/** 给一组行贴同一个说话时前台应用图标。 */
export function setLineTargets(lines, spec) {
  for (const line of lines || []) {
    if (line && line.isConnected) setLineTarget(line, spec);
  }
}

/** 文本颜色表达是否执行了自动粘贴，不再用第二个图标重复表达。 */
export function setLinePasteState(lineOrLines, pasted) {
  const lines = Array.isArray(lineOrLines) ? lineOrLines : [lineOrLines];
  for (const line of lines) {
    if (!line || !line.isConnected) continue;
    const text = line.querySelector('.txt');
    if (!text) continue;
    text.classList.toggle('pasteNotDone', !pasted);
    const oldIcon = text.querySelector('.pasteDoneIcon');
    if (pasted) {
      if (oldIcon) continue;
      const icon = document.createElement('span');
      icon.className = 'pasteDoneIcon';
      icon.innerHTML = PASTE_DONE_SVG;
      text.appendChild(icon);
    } else if (oldIcon) {
      oldIcon.remove();
    }
  }
}
