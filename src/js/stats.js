import { $, esc } from './ui.js';
import { fetchTranscriptEvents } from './storage.js';

function distribution(items, total) {
  if (!items.length) return '<div class="stats-empty">暂无数据</div>';
  return items.map(([label, count]) => {
    const percent = total ? Math.round(count / total * 100) : 0;
    return `<div class="stats-bar-row"><span class="stats-bar-label">${esc(label)}</span><div class="stats-bar-track"><i style="width:${percent}%"></i></div><span class="stats-bar-value">${count}</span></div>`;
  }).join('');
}

function hourChart(hours) {
  const max = Math.max(...hours, 0);
  if (!max) return '<div class="stats-empty">暂无数据</div>';
  return `<div class="stats-hour-chart" role="img" aria-label="24 小时记录分布">${hours.map((count, hour) => {
    const height = count ? Math.max(4, Math.round(count / max * 100)) : 0;
    return `<div class="stats-hour-col" title="${String(hour).padStart(2, '0')}:00 · ${count} 条"><span class="stats-hour-value">${count || ''}</span><div class="stats-hour-bar-wrap"><i style="height:${height}%"></i></div><span class="stats-hour-label">${String(hour).padStart(2, '0')}</span></div>`;
  }).join('')}</div>`;
}

function dayChart(days) {
  const max = Math.max(...days.map(([, count]) => count), 0);
  if (!max) return '<div class="stats-empty">暂无数据</div>';
  return `<div class="stats-day-chart-scroll"><div class="stats-day-chart" style="--day-count:${days.length}" role="img" aria-label="每天记录数量分布">${days.map(([day, count]) => {
    const height = count ? Math.max(4, Math.round(count / max * 100)) : 0;
    const label = day.slice(5).replace('-', '/');
    return `<div class="stats-hour-col stats-day-col" title="${day} · ${count} 条"><span class="stats-hour-value">${count}</span><div class="stats-hour-bar-wrap"><i style="height:${height}%"></i></div><span class="stats-hour-label">${label}</span></div>`;
  }).join('')}</div></div>`;
}

function renderStats(events) {
  const total = events.length;
  const chars = events.reduce((sum, event) => sum + String(event.text || '').length, 0);
  const days = new Set(events.map(event => new Date(event.ts).toLocaleDateString())).size;
  const apps = new Map();
  const engines = new Map();
  const hours = new Map();
  const dayCounts = new Map();
  events.forEach(event => {
    const app = event.targetApp || '未识别目标';
    apps.set(app, (apps.get(app) || 0) + 1);
    const date = new Date(event.ts);
    const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    dayCounts.set(day, (dayCounts.get(day) || 0) + 1);
    const engine = event.engine || '未知引擎';
    engines.set(engine, (engines.get(engine) || 0) + 1);
    const hour = new Date(event.ts).getHours();
    hours.set(hour, (hours.get(hour) || 0) + 1);
  });
  const sortDesc = map => [...map.entries()].sort((a, b) => b[1] - a[1]);
  const hourItems = Array.from({ length: 24 }, (_, hour) => hours.get(hour) || 0);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const recentDays = Array.from({ length: 14 }, (_, index) => {
    const date = new Date(today);
    date.setDate(today.getDate() - 13 + index);
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    return [key, dayCounts.get(key) || 0];
  });

  $('statsTotal').textContent = total;
  $('statsChars').textContent = chars.toLocaleString();
  $('statsDays').textContent = days;
  $('statsApps').innerHTML = distribution(sortDesc(apps).slice(0, 8), total);
  $('statsEngines').innerHTML = distribution(sortDesc(engines), total);
  $('statsHours').innerHTML = hourChart(hourItems);
  $('statsDaysChart').innerHTML = dayChart(recentDays);
}

export async function refreshStats() {
  const body = $('statsPageBody');
  if (!body) return;
  body.classList.add('loading');
  try {
    const events = await fetchTranscriptEvents(new Date(0), new Date());
    renderStats(events);
  } catch (error) {
    console.error('[stats] load failed:', error.message || error);
    $('statsTotal').textContent = '—';
    $('statsChars').textContent = '—';
    $('statsDays').textContent = '—';
  } finally {
    body.classList.remove('loading');
  }
}

export function showStatsPage(show) {
  $('statsPage').classList.toggle('hidden', !show);
  $('statsBtn').setAttribute('aria-expanded', show ? 'true' : 'false');
  if (show) void refreshStats();
}

$('statsPage').addEventListener('click', event => {
  const close = event.target.closest('#statsPageClose');
  if (close) showStatsPage(false);
});
