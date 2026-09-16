export type InsertCommandSurface = "slash" | "browse";
export type InsertCommandBrowseCategory = "basic" | "list" | "media" | "structure" | "callout";
export type InsertCommandCategory = InsertCommandBrowseCategory;
export type InsertCommandAvailability = "always" | "image" | "table" | "math";

export type InsertCommandId =
  | "text" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "quote" | "divider"
  | "bullet-list" | "ordered-list" | "task-list"
  | "image" | "code" | "table" | "math"
  | "columns"
  | "bookmark" | "video" | "audio" | "file"
  | "callout-note" | "callout-tip" | "callout-important" | "callout-warning" | "callout-caution";

export type InsertCommandCapabilities = {
  image: boolean;
  table: boolean;
  math: boolean;
};

export type InsertCommand = Readonly<{
  id: InsertCommandId;
  execute: InsertCommandId;
  category: InsertCommandCategory;
  label: Readonly<{ zh: string; en: string }>;
  search: Readonly<{
    fullPinyin: string;
    initials: string;
    abbreviations: readonly string[];
  }>;
  availability: InsertCommandAvailability;
  browse: Readonly<{
    category: InsertCommandBrowseCategory;
    shortcutRank: number | null;
  }>;
  glyph: string;
}>;

const command = (
  id: InsertCommandId,
  category: InsertCommandCategory,
  zh: string,
  en: string,
  fullPinyin: string,
  initials: string,
  abbreviations: readonly string[],
  glyph: string,
  options: {
    availability?: InsertCommandAvailability;
    shortcutRank?: number;
  } = {},
): InsertCommand => Object.freeze({
  id,
  execute: id,
  category,
  label: Object.freeze({ zh, en }),
  search: Object.freeze({ fullPinyin, initials, abbreviations: Object.freeze([...abbreviations]) }),
  availability: options.availability ?? "always",
  browse: Object.freeze({
    category,
    shortcutRank: options.shortcutRank ?? null,
  }),
  glyph,
});

/**
 * Slash 与空块 `+` 的唯一命令注册表。命令量有限，拼音和缩写显式登记，避免在线服务、
 * 平台词典或大型拼音依赖造成排序漂移。数组顺序也是空查询和浏览菜单的稳定默认顺序。
 */
const INSERT_COMMAND_REGISTRY: readonly InsertCommand[] = Object.freeze([
  command("text", "basic", "正文", "Text", "zhengwen", "zw", ["paragraph", "p"], "T"),
  command("h1", "basic", "一级标题", "Heading 1", "yijibiaoti", "yjbt", ["heading1", "title1"], "H1", { shortcutRank: 0 }),
  command("h2", "basic", "二级标题", "Heading 2", "erjibiaoti", "ejbt", ["heading2", "title2"], "H2", { shortcutRank: 1 }),
  command("h3", "basic", "三级标题", "Heading 3", "sanjibiaoti", "sjbt", ["heading3", "title3"], "H3", { shortcutRank: 2 }),
  command("h4", "basic", "四级标题", "Heading 4", "sijibiaoti", "sjbt4", ["heading4", "title4"], "H4"),
  command("h5", "basic", "五级标题", "Heading 5", "wujibiaoti", "wjbt", ["heading5", "title5"], "H5"),
  command("h6", "basic", "六级标题", "Heading 6", "liujibiaoti", "ljbt", ["heading6", "title6"], "H6"),
  command("quote", "basic", "引用", "Quote", "yinyong", "yy", ["blockquote"], "❝", { shortcutRank: 7 }),
  command("divider", "basic", "分割线", "Divider", "fengexian", "fgx", ["hr", "rule"], "—", { shortcutRank: 9 }),

  command("bullet-list", "list", "无序列表", "Bullet List", "wuxuliebiao", "wxlb", ["bullets", "ul"], "•", { shortcutRank: 4 }),
  command("ordered-list", "list", "有序列表", "Ordered List", "youxuliebiao", "yxlb", ["numbered", "ol"], "1.", { shortcutRank: 3 }),
  command("task-list", "list", "待办清单", "To-do List", "daibanqingdan", "dbqd", ["todo", "task", "checklist"], "☑", { shortcutRank: 5 }),

  command("image", "media", "图片", "Image", "tupian", "tp", ["img", "photo"], "▧", { availability: "image" }),
  command("code", "structure", "代码块", "Code Block", "daimakuai", "dmk", ["code", "pre"], "</>", { shortcutRank: 6 }),
  command("table", "structure", "表格", "Table", "biaoge", "bg", ["grid"], "▦", { availability: "table" }),
  command("columns", "structure", "分栏", "Columns", "fenlan", "fl", ["layout", "columns", "split"], "▥"),
  command("math", "structure", "数学公式", "Equation", "shuxuegongshi", "sxgs", ["math", "latex", "formula"], "fx", { availability: "math" }),
  command("bookmark", "media", "网页书签", "Web bookmark", "wangyeshuqian", "wysq", ["bookmark", "linkcard", "link-card"], "⌑"),
  command("video", "media", "视频", "Video", "shipin", "sp", ["movie"], "▶"),
  command("audio", "media", "音频", "Audio", "yinpin", "yp", ["music", "sound"], "♪"),
  command("file", "media", "文件", "File", "wenjian", "wj", ["attachment", "attach"], "⌕"),

  command("callout-note", "callout", "提示框·笔记", "Callout · Note", "tishikuangbiji", "tskbj", ["note", "calloutnote"], "i", { shortcutRank: 8 }),
  command("callout-tip", "callout", "提示框·提示", "Callout · Tip", "tishikuangtishi", "tskts", ["tip", "callouttip"], "i"),
  command("callout-important", "callout", "提示框·重要", "Callout · Important", "tishikuangzhongyao", "tskzy", ["important", "calloutimportant"], "!"),
  command("callout-warning", "callout", "提示框·注意", "Callout · Warning", "tishikuangzhuyi", "tskzyi", ["warning", "calloutwarning"], "!"),
  command("callout-caution", "callout", "提示框·警告", "Callout · Caution", "tishikuangjinggao", "tskjg", ["caution", "calloutcaution"], "!"),
]);

export function getInsertCommandRegistry(_surface: InsertCommandSurface): readonly InsertCommand[] {
  return INSERT_COMMAND_REGISTRY;
}

export function isInsertCommandAvailable(
  command: InsertCommand,
  capabilities: InsertCommandCapabilities,
): boolean {
  return command.availability === "always" || capabilities[command.availability];
}

const normalizeQuery = (query: string): string => query
  .trim()
  .replace(/^\/+/, "")
  .trim()
  .toLocaleLowerCase();

function insertCommandMatchRank(command: InsertCommand, query: string, lang: "zh" | "en"): number | null {
  const id = command.id.toLocaleLowerCase();
  if (id === query) return 0;
  if (id.startsWith(query)) return 1;

  const primary = command.label[lang].toLocaleLowerCase();
  if (primary === query || primary.startsWith(query)) return 2;

  const secondaryLang = lang === "zh" ? "en" : "zh";
  const aliases = [
    command.label[secondaryLang],
    command.search.fullPinyin,
    command.search.initials,
    ...command.search.abbreviations,
  ].map((term) => term.toLocaleLowerCase());
  if (aliases.some((term) => term === query || term.startsWith(query))) return 3;
  if ([primary, ...aliases, id].some((term) => term.includes(query))) return 4;
  return null;
}

/** 精确 ID/前缀 > 当前语言主标签前缀 > 显式别名前缀 > 包含；同级保持注册表顺序。 */
export function searchInsertCommands(query: string, lang: "zh" | "en"): readonly InsertCommand[] {
  const normalized = normalizeQuery(query);
  if (!normalized) return INSERT_COMMAND_REGISTRY;
  return INSERT_COMMAND_REGISTRY
    .map((command, index) => ({ command, index, rank: insertCommandMatchRank(command, normalized, lang) }))
    .filter((entry): entry is typeof entry & { rank: number } => entry.rank != null)
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(({ command }) => command);
}

export function insertCommandIcon(command: InsertCommand): string {
  const text = command.glyph.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;",
  })[character] ?? character);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="20" height="20"><rect x="2.5" y="2.5" width="19" height="19" rx="5" fill="none" stroke="currentColor" stroke-width="1.2"/><text x="12" y="15" text-anchor="middle" fill="currentColor" font-size="${text.length > 2 ? "7" : "9"}" font-family="system-ui,sans-serif" font-weight="700">${text}</text></svg>`;
}

// C20's persistent layout model is exported through the shared insertion
// module so Slash, `+` and the block menu cannot grow separate layout models.
export { createPersistentLayoutModel, linearizePersistentLayout } from "./layoutModel";
