import { state } from './state.js';

export function $(id) {
  return document.getElementById(id);
}

export function esc(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

export function toast(msg) {
  const e = $('err');
  e.textContent = msg;
  e.style.display = 'block';
  setTimeout(() => { e.style.display = 'none'; }, 5000);
}

export function setStatus(t, on) {
  $('statusText').textContent = t;
  $('dot').className = on ? 'on' : '';
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

/** 滚到底部；force=true 时忽略用户当前滚动位置（切换查询区间/强制重载时用） */
export function scrollListToBottom(force) {
  const list = $('list');
  if (!list) return;
  if (!force && !state.stickToBottom) return;
  list.scrollTop = list.scrollHeight;
  state.stickToBottom = true;
}

/** 绑定一次滚动监听，持续更新 state.stickToBottom */
export function initListAutoScroll() {
  const list = $('list');
  if (!list || list.dataset.autoscrollBound) return;
  list.dataset.autoscrollBound = '1';
  list.addEventListener('scroll', () => {
    state.stickToBottom = listNearBottom();
  }, { passive: true });
}

export function tsParts(d) {
  const p = n => String(n).padStart(2, '0');
  return {
    day: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`,
    time: `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`,
  };
}

export function addLine(dateObj, text, isInterim) {
  if (!isInterim) {
    const lastLine = $('list').querySelector('.line:last-child');
    if (lastLine) {
      const lastTxt = lastLine.querySelector('.txt');
      if (lastTxt && lastTxt.textContent === text) return;
    }
  }
  const { day, time } = tsParts(dateObj);
  const emp = $('list').querySelector('.empty');
  if (emp) emp.remove();
  if (day !== state.lastDay) {
    state.lastDay = day;
    const sep = document.createElement('div');
    sep.className = 'daysep';
    sep.textContent = day;
    $('list').appendChild(sep);
  }
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
  $('list').appendChild(div);
  scrollListToBottom();
}
