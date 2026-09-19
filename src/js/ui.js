import { state } from './state.js';
import { apiUrl } from './api.js';
import { setLineTarget, setLinePasteState, specFromActiveApp } from './pastebadge.js';
import { shouldShowTimestamp } from './timeGrouping.js';
import { syncTrayStatus } from './tray.js';

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
// 运行状态机（单一渲染来源）：这里唯一决定状态点、状态文字、时间区。
// 渲染位置在 footer 电平尺一行右侧（2026-09-15 从顶栏移下来；文案仍叫状态区，别按位置找）。
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
  // 本地引擎的识别还依赖本机的模型服务（127.0.0.1:8933，见 model.js 的探测）。
  // 它没起来而状态区还写「就绪」，用户就会以为能录，实际一个字都不会出——
  // 这正是 core-product-principles 第 3 条要禁的假状态。
  // 只有本地引擎才可能为 true；百炼走云端，model.js 在此时把该字段置 null。
  const audioDead = !!state.audioStalled;
  const modelDown = state.modelServiceOk === false;

  // ① 麦克风拿不到（权限被拒/无设备）：优先暴露，此时不可能在录音
  if (state.micError) return { key: 'mic-error', text: '麦克风不可用', dot: 'err', time: 'none' };
  // ①b 录音中但麦克风回调一次都不来：管道已经断了（睡眠唤醒、设备被切走）。
  // 这排在最前面是因为它比「识别中」更确定也更紧急：音频根本没离开这台机器，
  // 无论 ASR 连没连上，用户现在说的话都不会被存下来。
  // 判据是结构性的（回调停了，见 audio.js 的 startAudioFlowWatch），
  // 不是「安静」——用户不说话是正常的，那种情况仍然是「识别中」。
  if (recording && audioDead) return { key: 'no-audio', text: '没有声音输入', dot: 'err', time: 'rec' };
  // ② 录音中：ASR 任务就绪→识别中；服务不可达→服务未连接；任务协商中→正在连接；其余为缓冲等待
  if (recording) {
    if (state.asrReady) return { key: 'recognizing', text: '识别中', dot: 'on', time: 'rec' };
    if (serverDown) return { key: 'offline', text: '服务未连接', dot: 'err', time: 'rec' };
    // 模型服务没起来时，ASR 任务永远协商不出来（要等 15 秒超时才报错并停录），
    // 所以这里排在「正在连接」之前，如实告诉用户卡在哪
    if (modelDown) return { key: 'model-down', text: '模型服务未启动', dot: 'err', time: 'rec' };
    if (wsPending) return { key: 'connecting', text: '正在连接', dot: '', time: 'rec' };
    return { key: 'recording', text: '录音中', dot: 'on', time: 'rec' };
  }
  // ③ 空闲 + 服务不可达：不得再显示「就绪」
  if (serverDown) return { key: 'offline', text: '服务未连接', dot: 'err', time: 'none' };
  // ③b 空闲 + 代理服务正常但本地模型服务未启动：同样不是「就绪」
  if (modelDown) return { key: 'model-down', text: '模型服务未启动', dot: 'err', time: 'uptime' };
  // ④ 首次探测尚未回来
  if (state.serverOk === null && !serverUp) return { key: 'connecting', text: '正在连接', dot: '', time: 'none' };
  // ⑤ 空闲 + 服务正常
  return { key: 'ready', text: '就绪', dot: '', time: 'uptime' };
}

/** 异常状态说法的统一清单（点与文字都用告警色，见 style.css 的 .up-offline） */
const ABNORMAL_KEYS = new Set(['offline', 'mic-error', 'model-down', 'no-audio']);

export function renderRunStatus() {
  const st = computeRunStatus();
  const textEl = $('statusText');
  const dotEl = $('dot');
  const timeEl = $('statusTime');
  if (textEl) {
    textEl.textContent = st.text;
    textEl.classList.toggle('up-offline', ABNORMAL_KEYS.has(st.key));
  }
  if (dotEl) dotEl.className = st.dot;
  const statusEl = $('status');
  if (statusEl) {
    // 异常时补一句「怎么办」：状态文字只说出了问题，用户下一步得知道去哪看。
    // 用 data-tip 而不是 title——两者会用时弹（见 style.css 那节注释）。
    if (st.key === 'model-down') {
      statusEl.dataset.tip = '本地识别依赖本机的模型服务（127.0.0.1:8933），它没有在运行。打开设置 →「识别方式」可以看原因并一键重启。';
    } else if (st.key === 'no-audio') {
      // 异常必须带下一步，而且这一步真的有用：重建麦克风是这句话背后的动作，
      // 停止再开始录音就是手工做同一件事（会重新取一次麦克风与新开音频会话）。
      statusEl.dataset.tip = '录音里没有收到麦克风的声音（睡眠唤醒、或换了输入设备时会出现）。点录音按钮停一下再开一次；如果还不行，退出重开应用。';
    } else {
      delete statusEl.dataset.tip;
    }
  }
  // 菜单栏图标和状态区共用这一次结论（应用在后台时，它是唯一能看到状态的地方）。
  // 除了状态，还要告诉它「现在有没有人在说话」：VAD 一判定到音超过门槛就会立刻
  // 再调一次本函数（见 asr.js 的 updateSpeechState），所以菜单栏上的「说话中」不是
  // 秒级轮询，而是和电平尺同一时刻的事实。onExpire 是「已听到」回执到期时叫我们重渲染。
  syncTrayStatus(st, {
    speaking: state.vadState === 'speech',
    onExpire: () => renderRunStatus(),
  });

  if (!timeEl) return;
  if (st.time === 'rec' && state.recStartTs) {
    timeEl.textContent = fmtDuration((Date.now() - state.recStartTs) / 1000);
  } else if (st.time === 'uptime') {
    timeEl.textContent = fmtDuration(state.serverUptime);
  } else {
    timeEl.textContent = '';
  }
  timeEl.classList.toggle('up-offline', st.key === 'offline' || st.key === 'model-down');
}

/**
 * 启动运行状态机：探测 /api/status 拿服务运行时长基准，之后每秒重渲染。
 * 服务不可达时置 serverOk=false，状态机据此显示「服务未连接」并停止累加时长。
 */
let statusProbeTimer = null;

/**
 * 立刻重探一次程序自己的服务（/api/status），并安排下一次校准。
 * 导出它是为了唤醒后立刻重核：睡一觉回来服务可能已经不一样了，
 * 而状态区平时是 60 秒才校准一次——「就绪」这两个字如果停留在旧结论上就是在说谎。
 */
export async function refreshServerStatus() {
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
  clearTimeout(statusProbeTimer);
  statusProbeTimer = setTimeout(refreshServerStatus, state.serverOk ? 60000 : 5000);
}

/**
 * 启动运行状态机：探测 /api/status 拿服务运行时长基准，之后每秒重渲染。
 * 服务不可达时置 serverOk=false，状态机据此显示「服务未连接」并停止累加时长。
 */
export function initRunStatus() {
  void refreshServerStatus();
  setInterval(() => {
    if (state.serverOk === true) state.serverUptime += 1;
    renderRunStatus();
  }, 1000);
}

// 状态切换的「按下」确认：给元素加一次短促脉冲（样式见 style.css 的 .toggled）。
// 同一套动画同时服务底部两个开关和录制按钮，别再各写一份。
// 先摘 class 再读一次布局，是为了连点两次时动画能重新播；定时器按元素存，
// 同一颗按钮的两次脉冲不会互相截断。
const pulseTimers = new WeakMap();

export function flashPulse(el) {
  if (!el) return;
  el.classList.remove('toggled');
  void el.offsetWidth;
  el.classList.add('toggled');
  clearTimeout(pulseTimers.get(el));
  pulseTimers.set(el, setTimeout(() => el.classList.remove('toggled'), 340));
}

export function setRecordBtn(recording) {
  // 按钮已简化成纯图标圆形按钮：文案只留在 title/aria-label，保证可访问性
  const label = (recording ? '停止录音' : '开始录音') + ' · 空格键';
  const btn = $('btn');
  if (btn) { btn.title = label; btn.setAttribute('aria-label', label); }
  // 录制按钮的两种状态（常态黑底 / 录音中红底）只在这里切换，脉冲也挂在同一个
  // 地方：点击、⌘⇧V 之外的键盘入口、全局热键、启动自动开录全都经过这个函数，
  // 不会漏掉反馈。只在「状态真的变了」时脉冲——麦克风授权失败的回滚会再调一次
  // setRecordBtn(false)，那一次不该给用户一个「成了」的动静。
  const wasOn = !!(btn && btn.classList.contains('on'));
  if (btn) btn.classList.toggle('on', !!recording);
  if (btn && wasOn !== !!recording) flashPulse(btn);
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

/** 构造一行（应用去向 + 文本）；时间作为列表中的独立分隔条展示 */
function buildLine(dateObj, text, isInterim) {
  const { day } = tsParts(dateObj);
  const div = document.createElement('div');
  div.className = 'line';
  div.dataset.ts = dateObj.toISOString();
  div.innerHTML = `<span class="txt${isInterim ? ' interim' : ''}"></span>`;
  const el = div.querySelector('.txt');
  if (isInterim) {
    el.innerHTML = esc(text) + '<span class="cursor"></span>';
  } else {
    el.textContent = text;
  }
  return { day, el: div };
}

/**
 * 按微信的时间规则刷新整条列表：后台每条记录仍保留精确时间，前端只在
 * 时间组开始前插入一个居中的独立时间分隔条。整表重算是必要的，因为向前
 * 翻页可能改变边界处下一条消息是否应该显示时间。
 */
export function refreshTimestampVisibility() {
  const list = $('list');
  if (!list) return;
  list.querySelectorAll('.timeSep').forEach(sep => sep.remove());
  const lines = [...list.querySelectorAll('.line')];
  let lastShown = null;
  for (const line of lines) {
    const current = new Date(line.dataset.ts || '');
    if (!shouldShowTimestamp(current, lastShown)) continue;
    const sep = document.createElement('div');
    sep.className = 'timeSep';
    sep.textContent = tsParts(current).time;
    sep.setAttribute('aria-label', `时间 ${sep.textContent}`);
    list.insertBefore(sep, line);
    lastShown = current;
  }
}

/**
 * 追加一行记录（直播转写的每一句走这里）。
 *
 * `activeApp` 是说话时的前台应用快照；`pasteStatus` 独立表示是否执行了自动粘贴。
 * 两者不传时，行先按普通正文创建，稍后由 asr.js 异步补上。
 * 返回这一行的元素，供调用方稍后补状态；被去重跳过时返回 null。
 */
export function addLine(dateObj, text, isInterim, activeApp, pasteStatus) {
  if (!isInterim) {
    const lastLine = $('list').querySelector('.line:last-child');
    if (lastLine) {
      const lastTxt = lastLine.querySelector('.txt');
      if (lastTxt && lastTxt.textContent === text) return null;
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
  refreshTimestampVisibility();
  scrollListToBottom();
  if (activeApp !== undefined) setLineTarget(el, specFromActiveApp(activeApp));
  if (pasteStatus !== undefined) setLinePasteState(el, pasteStatus === 'pasted');
  return el;
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
    // 没有 activeApp 的旧事件不补造前台应用，改用未识别图标保留左侧位置。
    setLineTarget(el, specFromActiveApp(entry.activeApp));
    setLinePasteState(el, entry.pasteStatus === 'pasted');
    if (day !== prevDay) {
      prevDay = day;
      if (i !== skipSepAt) frag.appendChild(buildDaySep(day));
    }
    frag.appendChild(el);
  });
  const hint = $('listHint');
  list.insertBefore(frag, hint && hint.parentNode === list ? hint.nextSibling : list.firstChild);
  refreshTimestampVisibility();
  if (hadContent) {
    list.scrollTop += list.scrollHeight - prevHeight;
  } else {
    // 列表原本是空的（今天还没有记录）→ 直接落到最新一条
    list.scrollTop = list.scrollHeight;
  }
  // 前插后「离底部」的距离变大，按钮该跟着浮出来
  updateJumpBtn();
}
