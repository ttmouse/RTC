// 微信式时间分组：同一天内，距离上一次已显示的时间标记不足 5 分钟就隐藏重复时间。
export const TIMESTAMP_GAP_MS = 5 * 60 * 1000;

function toMs(value) {
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function localDay(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

/** 是否应该在当前消息前展示时间。输入消息必须按时间升序传入。 */
export function shouldShowTimestamp(current, previous) {
  const currentMs = toMs(current);
  const previousMs = toMs(previous);
  if (currentMs === null || previousMs === null) return true;
  if (localDay(new Date(currentMs)) !== localDay(new Date(previousMs))) return true;
  return currentMs - previousMs >= TIMESTAMP_GAP_MS;
}
