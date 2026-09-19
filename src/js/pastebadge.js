import { state } from './state.js';
import { patchLocalConfig } from './storage.js';

/**
 * 记录行内的「这句去哪了」徽标。
 *
 * 用户的原话（2026-09-18）：「在每一条历史记录这里面去展示当前这条历史记录它有没有
 * 粘贴到目标应用……在上面相联软件列表里面，他就可以看到这一句消息是发生到哪里的。」
 * （先前把它做成了底栏一格「最近一句」，那是错的：去向是**每条记录**的属性。）
 *
 * 一行一个标记，贴在内容左侧，表示说这句话时的前台应用，不表示粘贴结果。
 * 粘贴结果由正文颜色表达，避免把「在哪个应用说话」和「有没有粘贴」混成一个状态。
 * 应用图标拿不到时退回应用名文字；没有前台快照时显示「未识别前台应用」图标。
 */

/** 粘出去了：徽标规格（纯函数，便于单测） */
export function pasteBadgeSpec({ paste, appName = null } = {}) {
  if (!paste) return { kind: 'none', name: null, label: '没粘出去' };
  return { kind: 'app', name: appName || '', label: appName ? `已粘给 ${appName}` : '已粘出去' };
}

/** 说话时的前台应用快照，只负责展示当时用户在哪个应用里。 */
export function specFromActiveApp(activeApp) {
  const app = activeApp && typeof activeApp === 'object' ? activeApp : null;
  const name = typeof activeApp === 'string' ? activeApp : app?.name;
  const identity = app?.bundle || app?.id || name;
  return name
    ? { kind: 'app', name: String(name), app: String(identity), target: app || { name: String(name) }, label: `说话时前台应用：${name}` }
    : { kind: 'unknown', name: null, app: null, target: null, label: '说话时未识别前台应用' };
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

let appMenu = null;
let appMenuSpec = null;

function copyMenuText(text) {
  const invoke = tauriInvoke();
  const task = invoke
    ? invoke('copy_to_clipboard', { text })
    : navigator.clipboard?.writeText(text);
  if (task && typeof task.catch === 'function') task.catch(error => console.error('[pastebadge] 复制失败:', error));
}

function appIsInRule(rule, app) {
  const list = state[rule + 'Apps'];
  if (!Array.isArray(list) || !list.length) return true; // 空名单 = 全部应用
  if (!app) return false;
  const keys = [app.name, app.bundle, app.id].filter(Boolean).map(value => String(value).toLowerCase());
  return list.some(value => keys.includes(String(value).toLowerCase()));
}

function ensureAppMenu() {
  if (appMenu) return appMenu;
  appMenu = document.createElement('div');
  appMenu.className = 'appContextMenu hidden';
  appMenu.setAttribute('role', 'menu');
  appMenu.innerHTML = '<div class="appContextMenuTitle"></div>' +
    '<button type="button" class="appContextMenuCopy" data-action="copy" role="menuitem">复制这句话</button>' +
    '<button type="button" role="menuitemcheckbox" data-rule="autoPaste"></button>' +
    '<button type="button" role="menuitemcheckbox" data-rule="autoEnter"></button>';
  document.body.appendChild(appMenu);
  appMenu.addEventListener('click', event => {
    const copy = event.target.closest('[data-action="copy"]');
    if (copy && appMenuSpec) {
      const text = appMenuSpec.line?.querySelector('.txt')?.textContent?.trim();
      if (text) copyMenuText(text);
      hideAppMenu();
      return;
    }
    const item = event.target.closest('[data-rule]');
    if (!item || item.disabled || !appMenuSpec) return;
    const rule = item.dataset.rule;
    const listKey = rule + 'Apps';
    const list = Array.isArray(state[listKey]) ? [...state[listKey]] : [];
    // 空名单代表全局生效，不能在这里把它误改成“只允许当前应用”。
    if (!list.length || !appMenuSpec.app) return;
    const enabled = appIsInRule(rule, appMenuSpec.target);
    const keys = [appMenuSpec.target.name, appMenuSpec.target.bundle, appMenuSpec.target.id]
      .filter(Boolean).map(value => String(value).toLowerCase());
    const next = enabled
      ? list.filter(value => !keys.includes(String(value).toLowerCase()))
      : [...list, appMenuSpec.app];
    // 最后一个名单项移除后会变成“全部应用”，所以不允许通过菜单制造反向结果。
    if (enabled && !next.length) return;
    state[listKey] = next;
    void patchLocalConfig({ [listKey]: next }).catch(error => {
      console.error('[pastebadge] 保存应用规则失败:', error);
    });
    renderAppMenu(appMenuSpec);
    hideAppMenu();
  });
  document.addEventListener('click', event => {
    if (appMenu && !appMenu.contains(event.target)) hideAppMenu();
  });
  document.addEventListener('contextmenu', event => {
    if (appMenu && !appMenu.contains(event.target) && !event.target.closest('.pasteBadge')) hideAppMenu();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') hideAppMenu();
  });
  return appMenu;
}

function renderAppMenu(spec) {
  const menu = ensureAppMenu();
  appMenuSpec = spec;
  menu.querySelector('.appContextMenuTitle').textContent = spec.name || '这句话';
  for (const item of menu.querySelectorAll('[data-rule]')) {
    const rule = item.dataset.rule;
    const totalOn = rule === 'autoPaste' ? state.autoPaste : state.autoEnter;
    const list = state[rule + 'Apps'];
    const hasApp = spec.kind === 'app' && !!spec.target && !!spec.app;
    const global = !Array.isArray(list) || !list.length;
    const enabled = hasApp && totalOn && appIsInRule(rule, spec.target);
    item.disabled = !hasApp || global || !totalOn || (enabled && list.length === 1);
    item.setAttribute('aria-checked', enabled ? 'true' : 'false');
    const status = !hasApp ? '未识别应用' : global ? '全部应用' : enabled ? '已开启' : '未开启';
    const label = `${rule === 'autoPaste' ? '自动粘贴' : '自动发送'}：${status}`;
    item.innerHTML = `<span>${label}</span><span class="appContextMenuCheck">${enabled ? PASTE_DONE_SVG : ''}</span>`;
    item.title = !hasApp ? '这条记录没有可识别的前台应用' : global ? '当前为空名单，表示全部应用；请到设置页改为按应用管理' :
      (enabled && list.length === 1 ? '至少保留一个应用名单项，避免误变成全部应用' : '点击切换此应用的设置');
  }
  return menu;
}

function hideAppMenu() {
  if (appMenu) appMenu.classList.add('hidden');
  appMenuSpec = null;
}

function showAppMenu(spec, event, line) {
  spec = { ...spec, line };
  const menu = renderAppMenu(spec);
  event.preventDefault();
  event.stopPropagation();
  menu.classList.remove('hidden');
  menu.style.left = `${event.clientX}px`;
  menu.style.top = `${event.clientY}px`;
  requestAnimationFrame(() => {
    const rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.min(event.clientX, window.innerWidth - rect.width - 8)}px`;
    menu.style.top = `${Math.min(event.clientY, window.innerHeight - rect.height - 8)}px`;
  });
}

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

/** 未识别前台应用：细线圆角矩形作为应用外框，内部问号表达身份未知。 */
const UNKNOWN_APP_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<rect x="2.5" y="2.5" width="19" height="19" rx="5"/>' +
  '<path d="M9.35 9.1a2.8 2.8 0 1 1 5.35 1.15c-.55 1.35-2.7 1.7-2.7 3.55"/>' +
  '<path d="M12 16.9h.01" stroke-width="1.2"/></svg>';

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
  lineEl.oncontextmenu = event => showAppMenu(spec, event, lineEl);
  badge.onclick = null;
  badge.onkeydown = null;
  badge.removeAttribute('role');
  badge.removeAttribute('tabindex');
  badge.removeAttribute('title');
  badge.oncontextmenu = null;
  if (spec.kind === 'unknown') {
    badge.innerHTML = UNKNOWN_APP_SVG;
    return;
  }
  if (spec.kind !== 'app') {
    // 兼容旧的粘贴徽标调用：没有粘贴结果时不显示前台应用图标。
    badge.innerHTML = '';
    return;
  }
  // 名字先摆进去：图标要等系统回话，拿不到图标时就让它一直当文字用（网页版也是这样）
  if (!spec.name) {
    badge.textContent = '';
    return;
  }
  badge.textContent = '';   // 这一行可能复用了旧徽标，先把上一次的内容清掉
  badge.setAttribute('role', 'button');
  badge.setAttribute('tabindex', '0');
  badge.title = `激活${spec.name}`;
  badge.oncontextmenu = event => showAppMenu(spec, event, lineEl);
  const activate = () => {
    const invoke = tauriInvoke();
    if (!invoke || !spec.app) return;
    invoke('activate_app', { app: spec.app }).catch(e => {
      console.error('[pastebadge] 激活应用失败:', e);
    });
  };
  badge.onclick = event => {
    event.stopPropagation();
    activate();
  };
  badge.onkeydown = event => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    event.stopPropagation();
    activate();
  };
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
