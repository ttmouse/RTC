import { state } from './state.js';
import { $, addLine } from './ui.js';
import {
  appendTranscriptEvent,
  clearTranscriptEvents,
  fetchTranscriptEvents,
} from './storage.js';

function currentRange() {
  const now = Date.now();
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const start = state.qMinutes > 0
    ? now - state.qMinutes * 60 * 1000
    : todayStart.getTime();
  return { start: new Date(start), end: new Date(now) };
}

export function saveEntry(text) {
  const ts = new Date().toISOString();
  appendTranscriptEvent(text, ts, state.asrEngine || null).catch(e => {
    console.error('[transcript] JSONL append failed:', e.message || e);
  });
}

export async function loadHistory() {
  const { start, end } = currentRange();
  return fetchTranscriptEvents(start, end);
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
      $('list').innerHTML = '<div class="empty">该时间段暂无记录</div>';
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

  for (const entry of entries) {
    const d = new Date(entry.t);
    const key = entry.id || (entry.t + entry.text);
    if (state.rendered.has(key)) continue;
    const existingLines = document.querySelectorAll('.line .txt');
    let alreadyShown = false;
    for (const el of existingLines) {
      if (el.textContent === entry.text) {
        alreadyShown = true;
        break;
      }
    }
    if (alreadyShown) continue;
    state.rendered.add(key);
    addLine(d, entry.text, false);
  }

  const emp = $('list').querySelector('.empty');
  if (emp && entries.length) emp.remove();
  $('list').scrollTop = $('list').scrollHeight;
}

export function startHistPoll() {
  stopHistPoll();
  state.histTimer = setInterval(() => {
    renderHistory(false).catch(e => {
      console.error('[transcript] history poll failed:', e.message || e);
    });
  }, 5000);
}

export function stopHistPoll() {
  if (state.histTimer) clearInterval(state.histTimer);
  state.histTimer = null;
}
