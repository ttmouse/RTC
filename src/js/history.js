import { state } from './state.js';
import { $, addLine, scrollListToBottom } from './ui.js';
import {
  appendTranscriptEvent,
  clearTranscriptEvents,
  fetchTranscriptEvents,
} from './storage.js';

export function saveEntry(text) {
  const ts = new Date().toISOString();
  appendTranscriptEvent(text, ts, state.asrEngine || null).catch(e => {
    console.error('[transcript] JSONL append failed:', e.message || e);
  });
}

// 无搜索词时只取今天的记录；有搜索词时服务端忽略时间窗，跨全部历史匹配。
export async function loadHistory() {
  const now = new Date();
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const events = await fetchTranscriptEvents(todayStart, now, state.searchQuery);
  // 服务端带 q 时已经过滤过；这里再过滤一次是为了兼容还没重启的旧后端（它不认识 q，
  // 只会回当天数据）。过滤是幂等的，新版后端下不多余。
  return state.searchQuery
    ? events.filter(e => String(e.text || '').toLowerCase().includes(state.searchQuery.toLowerCase()))
    : events;
}

export async function clearHistory() {
  await clearTranscriptEvents();
  await renderHistory(true);
}

export async function renderHistory(force) {
  const events = await loadHistory();
  const entries = events.map(event => ({
    id: event.eventId,
    t: event.ts,
    text: event.text,
  }));

  if (!entries.length) {
    if (force) {
      $('list').innerHTML = `<div class="empty">${state.searchQuery ? '没有匹配的记录' : '今天暂无记录'}</div>`;
      state.rendered.clear();
      state.lastDay = '';
    }
    return;
  }

  entries.sort((a, b) => new Date(a.t) - new Date(b.t));

  if (force) {
    $('list').innerHTML = '';
    state.rendered.clear();
    state.lastDay = '';
  }

  // 一次性索引已显示的文本：旧实现每遇到一条新记录就遍历全部 .line .txt，
  // 长会议下是 O(新记录 × 已有行数) 的重复 DOM 扫描。
  const shownTexts = new Set();
  $('list').querySelectorAll('.line .txt').forEach(el => shownTexts.add(el.textContent));

  for (const entry of entries) {
    const d = new Date(entry.t);
    const key = entry.id || (entry.t + entry.text);
    if (state.rendered.has(key)) continue;
    if (shownTexts.has(entry.text)) continue;
    state.rendered.add(key);
    shownTexts.add(entry.text);
    addLine(d, entry.text, false);
  }

  const emp = $('list').querySelector('.empty');
  if (emp && entries.length) emp.remove();
  scrollListToBottom(force);
}

// 这里原本有一个每 5s 的全量轮询（startHistPoll/stopHistPoll），已移除：
// 事件的唯一写入方就是这个窗口自己（见 asr.js 里 4 处 saveEntry），而且每处都是
// 先同步渲染到列表、再落盘。轮询拉回来的永远是自己刚写的那几条，去重后什么也不做。
// 列表更新由两条路径负责：asr.js 识别结果的同步渲染 + 搜索框输入后的强制重载。
// 若将来出现第二个查看窗口（自己不在录音、只看别人写的事件），再补事件推送（SSE）。
