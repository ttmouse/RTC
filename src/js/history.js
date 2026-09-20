import { state } from './state.js';
import { $, addLine, scrollListToBottom, prependEntries, setListTopHint, updateJumpBtn } from './ui.js';
import {
  appendTranscriptEvent,
  clearTranscriptEvents,
  fetchTranscriptEvents,
} from './storage.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const CHUNK_DAYS = 3;   // 每次向前翻几天
const MAX_PROBES = 10;  // 连续空日（那几天没录音）最多往前探这么多次，约 30 天
const FILL_ROUNDS = 5;  // 内容不足一屏时（无法滚动）最多主动补几轮
// 必须与 server.js 的 SEARCH_LIMIT 保持一致：超过这个数就是被服务端截断过的结果集，
// 界面上不能再说「跨全部历史 N 条」。
const SEARCH_LIMIT = 300;

function todayStart() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

export function setTodayCount(count) {
  const value = Number.isFinite(count) ? count : 0;
  const countEl = $('todayCount');
  if (countEl) countEl.textContent = String(value);
  state.todayCount = value;
}

/**
 * 一条转写记录入库。
 *
 * `activeApp` 是说话时的前台应用快照，`pasteStatus` 是独立的粘贴结果。
 * 两者都可能是 Promise，因为前台查询与识别定型并行进行；查询失败只影响旁路字段，
 * 不影响正文入库。
 */
export async function saveEntry(text, activeApp, pasteStatus, engineOverride = null) {
  const ts = new Date().toISOString();
  // engine 在 await 之前取好：等待期间用户可能切换引擎，记录该记当时那个。
  const engine = engineOverride || state.asrEngine || null;
  let foreground = null;
  let status = 'not-pasted';
  try {
    foreground = (await Promise.resolve(activeApp)) || null;
  } catch (e) {
    foreground = null;
  }
  try {
    status = (await Promise.resolve(pasteStatus)) || 'not-pasted';
  } catch (e) {
    status = 'not-pasted';
  }
  try {
    await appendTranscriptEvent(text, ts, engine, foreground, status);
    setTodayCount((state.todayCount || 0) + 1);
  } catch (e) {
    console.error('[transcript] JSONL append failed:', e.message || e);
  }
}

// 无搜索词时取「窗口起点 → 现在」；窗口起点默认今天 00:00，向前翻页后不断上移。
// 有搜索词时服务端忽略时间窗，跨全部历史匹配。
export async function loadHistory() {
  const now = new Date();
  const from = state.historyFrom ? new Date(state.historyFrom) : todayStart();
  const events = await fetchTranscriptEvents(from, now, state.searchQuery);
  // 服务端带 q 时已经过滤过；这里再过滤一次是为了兼容还没重启的旧后端（它不认识 q，
  // 只会回当天数据）。过滤是幂等的，新版后端下不多余。
  return state.searchQuery
    ? events.filter(e => String(e.text || '').toLowerCase().includes(state.searchQuery.toLowerCase()))
    : events;
}

export async function clearHistory() {
  state.historyFrom = null;
  state.historyExhausted = false;
  state.historyLoading = false;
  setListTopHint('');
  await clearTranscriptEvents();
  await renderHistory(true);
}

/**
 * 向前翻页：取窗口起点之前的 CHUNK_DAYS 天，插到列表顶部。
 * 那几天没录音（返回空）时自动继续往前探，最多 MAX_PROBES 次，避免一次滚动读太多文件。
 */
export async function loadEarlier() {
  if (state.historyLoading || state.historyExhausted || state.searchQuery) return;
  const list = $('list');
  if (!list) return;
  state.historyLoading = true;
  let cursor = state.historyFrom || todayStart().getTime();
  setListTopHint('加载更早的记录…');
  try {
    let events = [];
    for (let probe = 0; probe < MAX_PROBES; probe += 1) {
      const from = cursor - CHUNK_DAYS * DAY_MS;
      events = await fetchTranscriptEvents(new Date(from), new Date(cursor), '');
      cursor = from;
      if (events.length) break;
      if (probe < MAX_PROBES - 1) setListTopHint(`加载更早的记录…（已回溯 ${(probe + 1) * CHUNK_DAYS} 天）`);
    }
    state.historyFrom = cursor;
    // 窗口两端是闭区间，边界那条会重复取回，必须按 eventId 去重；
    // 同时映射成列表条目 {t, text}（字段名与 renderHistory 一致，prependEntries 按 t 读）
    const fresh = events
      .filter(e => {
        const key = e.eventId || (e.ts + e.text);
        if (state.rendered.has(key)) return false;
        state.rendered.add(key);
        return true;
      })
      .map(e => ({
        t: e.ts,
        text: e.text,
        activeApp: e.activeApp || null,
        pasteStatus: e.pasteStatus || (e.targetApp ? 'pasted' : 'not-pasted'),
      }));
    if (!fresh.length) {
      state.historyExhausted = true;
      setListTopHint('更早没有记录了');
      return;
    }
    // 先插入、再移除提示条：顺序反了会把补偿过的滚动位置顶偏一行
    prependEntries(fresh);
    setListTopHint('');
  } finally {
    state.historyLoading = false;
  }
}

/** 内容不足一屏时用户无从「向上翻」，主动往前补，直到能滚动或到最早 */
async function fillIfNotScrollable() {
  const list = $('list');
  if (!list || state.searchQuery) return;
  for (let i = 0; i < FILL_ROUNDS; i += 1) {
    if (state.historyExhausted) return;
    if (list.scrollHeight > list.clientHeight + 4) return;
    const before = list.querySelectorAll('.line').length;
    await loadEarlier();
    if (list.querySelectorAll('.line').length === before) return;
  }
}

export async function renderHistory(force) {
  const events = await loadHistory();
  if (!state.searchQuery && !state.historyFrom) setTodayCount(events.length);
  const entries = events.map(event => ({
    id: event.eventId,
    t: event.ts,
    text: event.text,
    // activeApp 与 pasteStatus 是两条独立事实；旧事件用 targetApp 兼容展示。
    activeApp: event.activeApp || null,
    pasteStatus: event.pasteStatus || (event.targetApp ? 'pasted' : 'not-pasted'),
  }));

  if (!entries.length) {
    if (force) {
      $('list').innerHTML = `<div class="empty">${state.searchQuery ? '没有匹配的记录' : '今天暂无记录'}</div>`;
      state.rendered.clear();
      state.lastDay = '';
    }
    if (state.searchQuery) setListTopHint('');
    else if (state.historyExhausted) setListTopHint('更早没有记录了');
    // 今天还没记录 → 主动往前找最近有记录的几天，否则开局就是空列表
    else await fillIfNotScrollable();
    updateJumpBtn();
    return;
  }

  entries.sort((a, b) => new Date(a.t) - new Date(b.t));

  if (force) {
    $('list').innerHTML = '';
    state.rendered.clear();
    state.lastDay = '';
    // 列表被清空后，asr.js 手里那个「正在识别」的临时行已经不在 DOM 里了——
    // 句柄必须一起清掉。否则录音中在搜索框里打字触发重渲染，后续增量文字会继续写进
    // 那个游离节点：屏幕上当前这句话凭空消失，而 finalizePending 还会把它当作已显示
    // 内容存进历史。宁可让它作为新行重新出现，也不要显示与落盘不一致。
    state.pendingLine = null;
  }

  for (const entry of entries) {
    const d = new Date(entry.t);
    const key = entry.id || (entry.t + entry.text);
    if (state.rendered.has(key)) continue;
    // 这里以前还有一道「按文本内容去重」。同一个人在同一天把同一句话再说一遍是很正常的事
    // （「好」「谢谢」「下一个」），按文本去重会让第二条永远不显示——数据在 JSONL 里，
    // 界面上却是空的。eventId 已经能可靠区分事件，不需要再猜。
    state.rendered.add(key);
    addLine(d, entry.text, false, entry.activeApp, entry.pasteStatus);
  }

  const emp = $('list').querySelector('.empty');
  if (emp && entries.length) emp.remove();
  scrollListToBottom(force);
  if (state.searchQuery) {
    // 搜索结果是跨全历史的快照：此时不参与向前翻页，把命中条数告诉用户。
    // 必须说清「可能被截断」：服务端搜索有 SEARCH_LIMIT（300）上限，只回最新的一批，
    // 而这里直接写「跨全部历史 · N 条匹配」，等于拿一个被截断的数字断言完整性——
    // 命中 500 条时界面会理直气壮地显示「300 条匹配」，用户以为找全了。
    const truncated = entries.length >= SEARCH_LIMIT;
    setListTopHint(truncated
      ? `匹配较多，仅显示最新 ${SEARCH_LIMIT} 条（可能有更多）`
      : `跨全部历史 · ${entries.length} 条匹配`);
  } else {
    setListTopHint('');
    await fillIfNotScrollable();
  }
  // 重渲染 / 自动补屏之后滚动位置已变，按钮显隐按最终位置重算
  updateJumpBtn();
}

// 这里原本有一个每 5s 的全量轮询（startHistPoll/stopHistPoll），已移除：
// 事件的唯一写入方就是这个窗口自己（见 asr.js 里 4 处 saveEntry），而且每处都是
// 先同步渲染到列表、再落盘。轮询拉回来的永远是自己刚写的那几条，去重后什么也不做。
// 列表更新由两条路径负责：asr.js 识别结果的同步渲染 + 搜索框输入后的强制重载。
// 若将来出现第二个查看窗口（自己不在录音、只看别人写的事件），再补事件推送（SSE）。
