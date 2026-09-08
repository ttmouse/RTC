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
  div.innerHTML = `<span class="ts"><b>${day}</b>${time}</span>` +
    `<span class="txt${isInterim ? ' interim' : ''}"></span>`;
  const el = div.querySelector('.txt');
  if (isInterim) {
    el.innerHTML = esc(text) + '<span class="cursor"></span>';
  } else {
    el.textContent = text;
  }
  $('list').appendChild(div);
  $('list').scrollTop = $('list').scrollHeight;
}
