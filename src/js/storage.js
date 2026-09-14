import { apiUrl } from './api.js';

export async function appendTranscriptEvent(text, ts, engine) {
  const response = await fetch(apiUrl('/api/transcripts/events'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      event: {
        type: 'segment',
        text,
        ts: ts || new Date().toISOString(),
        engine: engine || null,
      },
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `HTTP ${response.status}`);
  }
  return data.event;
}

export async function fetchTranscriptEvents(from, to, q) {
  const query = new URLSearchParams({
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
  });
  // 带搜索词时服务端忽略 from/to，跨全部历史匹配
  if (q) query.set('q', q);
  const response = await fetch(apiUrl(`/api/transcripts/events?${query}`), {
    headers: { 'Content-Type': 'application/json' },
  });
  const data = await response.json().catch(() => ([]));
  if (!response.ok) {
    throw new Error(data.error || `HTTP ${response.status}`);
  }
  return data.filter(event => event.type === 'segment');
}

export async function clearTranscriptEvents() {
  const response = await fetch(apiUrl('/api/transcripts/events'), {
    method: 'DELETE',
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `HTTP ${response.status}`);
  }
}

export async function fetchLocalConfig() {
  const response = await fetch(apiUrl('/api/config'), {
    headers: { 'Content-Type': 'application/json' },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `HTTP ${response.status}`);
  }
  return data || {};
}

/**
 * 只更新 config 里的指定字段（服务端合并）。
 *
 * 前端有三类互相独立的 config 写入者：录音计时（totalDuration）、设置项（settings）、
 * 纠错规则（correctionRules）。旧写法各自「GET 全量 → 改自己那一个字段 → PUT 全量」，
 * 两个写入者交错时，后写的会用陈旧快照把对方刚存下的字段覆盖掉（丢失更新）；
 * 而且录音中计时每 1s 就跑一次，等于每秒把整份 config（含 API Key）重写一遍。
 * 合并挪到服务端串行执行后，各写各的，互不覆盖。
 */
export async function patchLocalConfig(partial) {
  const response = await fetch(apiUrl('/api/config'), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(partial),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `HTTP ${response.status}`);
  }
}
