/**
 * 场次显示用的纯函数（下拉里的标题 / 小字 / 日期）。
 *
 * 白板下拉现在跨天：既有今天刚识别出来的场次，也有检索出来的历史场次。历史场次必须能
 * 一眼看出是哪一天——否则正在开会时打开上一场的记录，标题会一模一样地写着「会议 11:41」，
 * 屏幕上没有任何东西能说明自己在看哪一天的文档。今天则相反，加日期只是噪音。
 */

/** 本地日期戳 YYYY-MM-DD。不能用 toISOString()，否则午夜附近会算成 UTC 的另一天。 */
export function localDateStamp(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** '2026-09-16' → '9月16日'。解析不出来就原样返回：宁可难看，也不要显示 NaN月NaN日。 */
export function formatDayLabel(date) {
  const matched = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || ''));
  if (!matched) return String(date || '');
  return `${Number(matched[2])}月${Number(matched[3])}日`;
}

/** 今天不加日期前缀；历史场次加。 */
export function sessionDisplayTitle(session, today = localDateStamp()) {
  const title = (session && session.title) || '未命名会议';
  if (!session || !session.date || session.date === today) return title;
  return `${formatDayLabel(session.date)} · ${title}`;
}

/** 下拉里那行小字：日期 + 记录条数 + 这份记录整理过没有。 */
export function sessionMetaLabel(session, today = localDateStamp()) {
  const date = session && session.date;
  const day = !date || date === today ? '今天' : formatDayLabel(date);
  return `${day} · ${(session && session.count) || 0} 条记录 · ${session && session.hasDocument ? '可编辑' : '待整理'}`;
}
