import { state } from './state.js';
import { apiUrl } from './api.js';

export function $(id) {
  return document.getElementById(id);
}

export function esc(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// 上一条提示的隐藏定时器。不留句柄的话，5 秒内连着来两条提示时，
// 第一条的定时器会把第二条也一起提前隐藏——典型的「配置错了 + 启动失败」连击场景。
let toastTimer = null;

export function toast(msg) {
  const e = $('err');
  e.textContent = msg;
  e.style.display = 'block';
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    e.style.display = 'none';
    toastTimer = null;
  }, 5000);
}

// ============================================================
// 顶栏运行状态机（单一渲染来源）：这里唯一决定状态点、状态文字、时间区。
// 其它模块只改 state（recording / asrReady / serverOk / micError）后调用
// renderRunStatus()，禁止各自 setTextContent。
// ============================================================

/** 服务是否确定可达：/api/status 探测成功，或 ASR WebSocket 已经打开 */
function serverReachable() {
  if (state.serverOk === true) return true;
  const ws = state.asrWs;
  return !!(ws && ws.readyState === WebSocket.OPEN);
}

/** 秒 → mm:ss / h:mm:ss */
function fmtDuration(totalSec) {
  const s = Math.max(0, Math.floor(totalSec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = n => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

/**
 * 计算当前唯一运行状态（互斥且无遗漏）。
 * key 只用于渲染分支，不给其它模块做判断。
 *   dot：''=空闲灰点 / 'on'=录音红点 / 'err'=异常红点
 *   time：'rec'=本段录音时长 / 'uptime'=服务运行时长 / 'none'=不显示时长
 */
export function computeRunStatus() {
  const recording = !!state.recording;
  const ws = state.asrWs;
  const wsOpen = !!ws && ws.readyState === WebSocket.OPEN;
  const wsPending = !!ws && (ws.readyState === WebSocket.CONNECTING || (wsOpen && !state.asrReady));
  const serverUp = serverReachable();
  const serverDown = state.serverOk === false && !serverUp;

  // ① 麦克风拿不到（权限被拒/无设备）：优先暴露，此时不可能在录音
  if (state.micError) return { key: 'mic-error', text: '麦克风不可用', dot: 'err', time: 'none' };
  // ② 录音中：ASR 任务就绪→识别中；服务不可达→服务未连接；任务协商中→正在连接；其余为缓冲等待
  if (recording) {
    if (state.asrReady) return { key: 'recognizing', text: '识别中', dot: 'on', time: 'rec' };
    if (serverDown) return { key: 'offline', text: '服务未连接', dot: 'err', time: 'rec' };
    if (wsPending) return { key: 'connecting', text: '正在连接', dot: '', time: 'rec' };
    return { key: 'recording', text: '录音中', dot: 'on', time: 'rec' };
  }
  // ③ 空闲 + 服务不可达：不得再显示「就绪」
  if (serverDown) return { key: 'offline', text: '服务未连接', dot: 'err', time: 'none' };
  // ④ 首次探测尚未回来
  if (state.serverOk === null && !serverUp) return { key: 'connecting', text: '正在连接', dot: '', time: 'none' };
  // ⑤ 空闲 + 服务正常
  return { key: 'ready', text: '就绪', dot: '', time: 'uptime' };
}

export function renderRunStatus() {
  const st = computeRunStatus();
  const textEl = $('statusText');
  const dotEl = $('dot');
  const timeEl = $('statusTime');
  if (textEl) {
    textEl.textContent = st.text;
    textEl.classList.toggle('up-offline', st.key === 'offline' || st.key === 'mic-error');
  }
  if (dotEl) dotEl.className = st.dot;
  if (!timeEl) return;
  if (st.time === 'rec' && state.recStartTs) {
    timeEl.textContent = fmtDuration((Date.now() - state.recStartTs) / 1000);
  } else if (st.time === 'uptime') {
    timeEl.textContent = fmtDuration(state.serverUptime);
  } else {
    timeEl.textContent = '';
  }
  timeEl.classList.toggle('up-offline', st.key === 'offline');
}

/**
 * 启动顶栏状态机：探测 /api/status 拿服务运行时长基准，之后每秒重渲染。
 * 服务不可达时置 serverOk=false，状态机据此显示「服务未连接」并停止累加时长。
 */
export function initRunStatus() {
  let retryTimer = null;

  const fetchUptime = async () => {
    try {
      const res = await fetch(apiUrl('/api/status'));
      if (!res.ok) throw new Error('status ' + res.status);
      const data = await res.json();
      if (data && typeof data.uptime === 'number') state.serverUptime = data.uptime;
      state.serverOk = true;
    } catch {
      state.serverOk = false;
    }
    renderRunStatus();
    // 离线时快速重试（否则「服务未连接」会停留到下一次 1 分钟校准）；正常时 60s 校准一次
    clearTimeout(retryTimer);
    retryTimer = setTimeout(fetchUptime, state.serverOk ? 60000 : 5000);
  };

  fetchUptime();
  setInterval(() => {
    if (state.serverOk === true) state.serverUptime += 1;
    renderRunStatus();
  }, 1000);
}

export function setRecordBtn(recording) {
  // 按钮已简化成纯图标圆形按钮：文案只留在 title/aria-label，保证可访问性
  const label = recording ? '停止录音' : '开始录音';
  const btn = $('btn');
  if (btn) { btn.title = label; btn.setAttribute('aria-label', label); }
  const iconMic = $('btnIconMic');
  const iconPause = $('btnIconPause');
  if (iconMic) iconMic.classList.toggle('hidden', !!recording);
  if (iconPause) iconPause.classList.toggle('hidden', !recording);
}

// ---------- 列表跟随滚动 ----------
// 只在用户本来就贴在底部时才自动跟随新内容，避免每 5s 的历史轮询
// 把正在向上翻阅的人强行拽回底部。
const BOTTOM_SLACK = 40;

function listNearBottom() {
  const list = $('list');
  if (!list) return true;
  return list.scrollHeight - list.scrollTop - list.clientHeight <= BOTTOM_SLACK;
}

// 「回到最新」浮层按钮：离开底部超过这个距离才浮出（轻微滚动不弹）
const JUMP_SLACK = 120;

/** 同步「回到最新」按钮的显隐；滚动、前插、重渲染后都要调一次 */
export function updateJumpBtn() {
  const list = $('list');
  const btn = $('jumpBottom');
  if (!list || !btn) return;
  const away = list.scrollHeight - list.scrollTop - list.clientHeight;
  btn.classList.toggle('show', away > JUMP_SLACK);
}

/** 滚到底部；force=true 时忽略用户当前滚动位置（切换查询区间/强制重载时用） */
export function scrollListToBottom(force) {
  const list = $('list');
  if (!list) return;
  if (!force && !state.stickToBottom) return;
  list.scrollTop = list.scrollHeight;
  state.stickToBottom = true;
}

/** 绑定一次滚动监听，持续更新 state.stickToBottom 与「回到最新」按钮 */
export function initListAutoScroll() {
  const list = $('list');
  if (!list || list.dataset.autoscrollBound) return;
  list.dataset.autoscrollBound = '1';
  list.addEventListener('scroll', () => {
    state.stickToBottom = listNearBottom();
    updateJumpBtn();
  }, { passive: true });
  const btn = $('jumpBottom');
  if (btn) {
    // 直接跳到底（不做平滑滚动）：用户要的是「一步到最新」
    btn.onclick = () => {
      scrollListToBottom(true);
      updateJumpBtn();
    };
  }
  updateJumpBtn();
}

export function tsParts(d) {
  const p = n => String(n).padStart(2, '0');
  return {
    day: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`,
    time: `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`,
  };
}

function buildDaySep(day) {
  const sep = document.createElement('div');
  sep.className = 'daysep';
  sep.textContent = day;
  return sep;
}

/** 构造一行（时间 + 文本）；isInterim 时带光标 */
function buildLine(dateObj, text, isInterim) {
  const { day, time } = tsParts(dateObj);
  const div = document.createElement('div');
  div.className = 'line';
  div.innerHTML = `<span class="ts">${time}</span>` +
    `<span class="txt${isInterim ? ' interim' : ''}"></span>`;
  const el = div.querySelector('.txt');
  if (isInterim) {
    el.innerHTML = esc(text) + '<span class="cursor"></span>';
  } else {
    el.textContent = text;
  }
  return { day, el: div };
}

export function addLine(dateObj, text, isInterim) {
  if (!isInterim) {
    const lastLine = $('list').querySelector('.line:last-child');
    if (lastLine) {
      const lastTxt = lastLine.querySelector('.txt');
      if (lastTxt && lastTxt.textContent === text) return;
    }
  }
  const { day, el } = buildLine(dateObj, text, isInterim);
  const emp = $('list').querySelector('.empty');
  if (emp) emp.remove();
  if (day !== state.lastDay) {
    state.lastDay = day;
    $('list').appendChild(buildDaySep(day));
  }
  $('list').appendChild(el);
  scrollListToBottom();
}

// ---------- 聊天式向前翻页 ----------

const TOP_SLACK = 120; // 距顶部这么近就认为用户想往前翻

/** 距列表顶部是否已经很近 */
export function listNearTop() {
  const list = $('list');
  if (!list) return false;
  return list.scrollTop <= TOP_SLACK;
}

/** 列表顶部提示条（「加载更早的记录…」「更早没有记录了」）；传空串则移除 */
export function setListTopHint(text) {
  const list = $('list');
  if (!list) return;
  let hint = $('listHint');
  // 用 scrollHeight 差值补偿，而不是取提示条自身高度：
  // 顶部插入元素会同时改变外边距折叠（首条 .daysep 的 margin-top 不再与容器顶边合并），
  // 只按提示条高度补会漏掉这一截。
  if (!text) {
    if (!hint) return;
    const before = list.scrollHeight;
    // 本来就贴底时不要补偿：补偿会把已贴底的位置往上拽（实测离底部 53px），
    // 而这种情况下滚动条本来就该留在最底。
    const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight <= BOTTOM_SLACK;
    hint.remove();
    if (!atBottom) list.scrollTop = Math.max(0, list.scrollTop - (before - list.scrollHeight));
    return;
  }
  if (hint) {
    hint.textContent = text;
    return;
  }
  hint = document.createElement('div');
  hint.id = 'listHint';
  hint.className = 'listHint';
  // 必须先填文字再插入：空盒高度只有 padding（10px），比真实高度少一行，
  // 会把插入时的滚动补偿算少，视口随后被浏览器补正时就会跳一下。
  hint.textContent = text;
  const before = list.scrollHeight;
  list.insertBefore(hint, list.firstChild);
  list.scrollTop += list.scrollHeight - before;
}

/**
 * 把更早的记录插到列表顶部。entries 形如 [{t: ISO 时间, text}]（也容忍原样的 {ts}）。
 * 四个坑：
 * ① 不能复用 addLine 的追加路径：它内部会调 scrollListToBottom() 把视图拽回底部；
 * ② state.lastDay 是「顺序推进」状态，前插不得污染它（须保持等于列表末尾那条的日期）；
 * ③ 插入后要按高度差补偿 scrollTop，否则视口会跟着内容整体下跳；
 * ④ 调用时机：顶部提示条要等前插完成后再移除（见 setListTopHint 的高度补偿）。
 */
export function prependEntries(entries) {
  const list = $('list');
  if (!list || !entries.length) return;
  const emp = list.querySelector('.empty');
  if (emp) emp.remove();
  const hadContent = !!list.querySelector('.line');
  const prevHeight = list.scrollHeight;
  const tsOf = entry => entry.t || entry.ts;
  // 块内最后一天若与列表当前首条同天，就省略该天的分隔线，否则同一天会出现两条
  const firstDayInList = list.querySelector('.daysep')?.textContent || null;
  const days = entries.map(e => tsParts(new Date(tsOf(e))).day);
  const lastDay = days[days.length - 1];
  const skipSepAt = lastDay === firstDayInList ? days.lastIndexOf(lastDay) : -1;
  const frag = document.createDocumentFragment();
  let prevDay = null;
  entries.forEach((entry, i) => {
    const { day, el } = buildLine(new Date(tsOf(entry)), entry.text, false);
    if (day !== prevDay) {
      prevDay = day;
      if (i !== skipSepAt) frag.appendChild(buildDaySep(day));
    }
    frag.appendChild(el);
  });
  const hint = $('listHint');
  list.insertBefore(frag, hint && hint.parentNode === list ? hint.nextSibling : list.firstChild);
  if (hadContent) {
    list.scrollTop += list.scrollHeight - prevHeight;
  } else {
    // 列表原本是空的（今天还没有记录）→ 直接落到最新一条
    list.scrollTop = list.scrollHeight;
  }
  // 前插后「离底部」的距离变大，按钮该跟着浮出来
  updateJumpBtn();
}
