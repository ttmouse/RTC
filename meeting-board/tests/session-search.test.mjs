// 跨天场次下拉的显示回归。
//
// 这一组用例守的是一条产品规则：**历史场次必须能看出是哪一天**。同一天里「会议 11:41」
// 是唯一的，跨天就不再唯一——如果标题不带日期，正在开会的人打开上一场的记录时，
// 屏幕上没有任何东西能说明自己在看哪一天的白板。
import {
  formatDayLabel,
  localDateStamp,
  sessionDisplayTitle,
  sessionMetaLabel,
} from '../src/lib/sessionSearch.js';

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
};

const TODAY = '2026-09-17';
const today_session = { id: 'a', date: TODAY, title: '会议 11:41', count: 110, hasDocument: true };
const past_session = { id: 'b', date: '2026-09-16', title: '会议 11:41', count: 78, hasDocument: false };

// —— 日期戳 ——
check('本地日期戳按本地时区算，不按 UTC（午夜附近不能差一天）',
  localDateStamp(new Date(2026, 8, 17, 0, 30)) === '2026-09-17'
  && localDateStamp(new Date(2026, 8, 17, 23, 30)) === '2026-09-17',
  localDateStamp(new Date(2026, 8, 17, 0, 30)));

check('月份和日期补零到两位',
  localDateStamp(new Date(2026, 0, 5, 12, 0)) === '2026-01-05',
  localDateStamp(new Date(2026, 0, 5, 12, 0)));

// —— 日期标签 ——
check('日期标签去掉前导零，写成中文月日',
  formatDayLabel('2026-09-16') === '9月16日' && formatDayLabel('2026-01-05') === '1月5日',
  formatDayLabel('2026-09-16'));

check('解析不了的日期原样返回，不显示 NaN',
  formatDayLabel('') === '' && formatDayLabel('bad') === 'bad' && formatDayLabel(undefined) === '',
  formatDayLabel('bad'));

// —— 标题：同一天的场次标题一模一样，这正是必须加日期的理由 ——
check('今天不加日期前缀（全是今天时加日期是噪音）',
  sessionDisplayTitle(today_session, TODAY) === '会议 11:41', sessionDisplayTitle(today_session, TODAY));

check('历史场次加日期前缀（否则和今天的标题完全分不开）',
  sessionDisplayTitle(past_session, TODAY) === '9月16日 · 会议 11:41', sessionDisplayTitle(past_session, TODAY));

check('今天与历史同名时，两者的显示标题必须不同',
  sessionDisplayTitle(today_session, TODAY) !== sessionDisplayTitle(past_session, TODAY));

check('缺少日期信息时按今天处理，不崩',
  sessionDisplayTitle({ id: 'c', title: '会议 09:00' }, TODAY) === '会议 09:00');

check('没有标题时给一个兜底名字',
  sessionDisplayTitle({ id: 'd', date: TODAY }, TODAY) === '未命名会议');

// —— 小字 ——
check('今天的场次小字写「今天」',
  sessionMetaLabel(today_session, TODAY) === '今天 · 110 条记录 · 可编辑', sessionMetaLabel(today_session, TODAY));

check('历史场次小字带日期，并如实说明整理状态',
  sessionMetaLabel(past_session, TODAY) === '9月16日 · 78 条记录 · 待整理', sessionMetaLabel(past_session, TODAY));

check('字段缺失时不产生 undefined / NaN',
  sessionMetaLabel({ id: 'e', date: TODAY }, TODAY) === '今天 · 0 条记录 · 待整理', sessionMetaLabel({ id: 'e', date: TODAY }, TODAY));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
