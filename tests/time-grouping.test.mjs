import assert from 'node:assert/strict';
import { shouldShowTimestamp, TIMESTAMP_GAP_MS } from '../src/js/timeGrouping.js';

const at = '2026-09-18T13:00:00+08:00';

assert.equal(shouldShowTimestamp(at, null), true, '第一条记录显示时间');
assert.equal(
  shouldShowTimestamp(new Date(new Date(at).getTime() + TIMESTAMP_GAP_MS - 1), at),
  false,
  '五分钟以内隐藏重复时间',
);
assert.equal(
  shouldShowTimestamp(new Date(new Date(at).getTime() + TIMESTAMP_GAP_MS), at),
  true,
  '达到五分钟显示新时间',
);
assert.equal(
  shouldShowTimestamp(new Date(new Date(at).getTime() + TIMESTAMP_GAP_MS * 2), at),
  true,
  '时间判断基于上一次已显示时间，而不是上一条消息',
);
assert.equal(
  shouldShowTimestamp('2026-09-19T00:01:00+08:00', '2026-09-18T23:59:59+08:00'),
  true,
  '跨天显示新时间',
);
assert.equal(shouldShowTimestamp('not-a-date', at), true, '异常时间不隐藏时间');

console.log('time grouping tests passed');
