import type { BlockingEditorSurface } from "./editorSurfaces";
import type { InsertCommand, InsertCommandBrowseCategory } from "./insertCommands";

export type SlashInvocationOptions = {
  selectionAtEnd: boolean;
  inCode: boolean;
  inList: boolean;
  composing: boolean;
};

export type SlashInvocation = { query: string; slashOffset: number };

/** 只接受空白开头的当前文字块，避免执行块命令时静默吞掉已有正文。 */
export function parseSlashInvocation(
  text: string,
  options: SlashInvocationOptions,
): SlashInvocation | null {
  if (!options.selectionAtEnd || options.inCode || options.inList || options.composing) return null;
  const match = text.match(/^(\s*)\/([^\n]*)$/);
  if (!match) return null;
  return { query: match[2] ?? "", slashOffset: match[1]?.length ?? 0 };
}

export function moveInsertMenuActiveIndex(
  current: number,
  key: "ArrowUp" | "ArrowDown" | "Home" | "End",
  resultCount: number,
): number {
  if (resultCount <= 0) return 0;
  if (key === "Home") return 0;
  if (key === "End") return resultCount - 1;
  const delta = key === "ArrowDown" ? 1 : -1;
  return Math.max(0, Math.min(resultCount - 1, current + delta));
}

export function shouldExecuteInsertMenuCommand(input: {
  key: string;
  resultCount: number;
  imeEnter: boolean;
}): boolean {
  return input.key === "Enter" && input.resultCount > 0 && !input.imeEnter;
}

export type SlashMenuCloseReason = "dismiss" | "composition";

/** IME 组合期只收起 Omia 面板，不能放出仍会消费候选 Enter 的 Crepe 原生菜单。 */
export function shouldReleaseNativeSlashMenu(reason: SlashMenuCloseReason): boolean {
  return reason !== "composition";
}

export function insertMenuStatus(query: string, count: number, lang: "zh" | "en") {
  return lang === "en"
    ? {
        label: "Search insert blocks",
        status: `${count} ${count === 1 ? "result" : "results"}`,
        empty: `No command for “${query}” · Esc to close`,
      }
    : {
        label: "搜索插入区块",
        status: `${count} 个结果`,
        empty: `没有“${query}”命令 · Esc 关闭`,
      };
}

/** The visible native Slash surface supplies the caret anchor; it is not a competing intent. */
export function canOwnSlashInsertMenu(surface: BlockingEditorSurface | null): boolean {
  return surface === null || surface === "slash-menu";
}

export function canOpenBrowseInsertMenu(input: {
  isTextblock: boolean;
  isParagraph: boolean;
  contentSize: number;
  newDocument: boolean;
  blockIndex: number;
}): boolean {
  return input.isTextblock
    && input.isParagraph
    && input.contentSize === 0
    && !(input.newDocument && input.blockIndex === 0);
}

export function buildBrowseInsertMenu(commands: readonly InsertCommand[]) {
  const categories: readonly InsertCommandBrowseCategory[] = ["basic", "list", "media", "structure", "callout"];
  return {
    common: commands
      .filter((command) => command.browse.shortcutRank != null)
      .sort((a, b) => a.browse.shortcutRank! - b.browse.shortcutRank!),
    groups: categories.map((category) => ({
      category,
      commands: commands.filter((command) => command.browse.category === category),
    })).filter((group) => group.commands.length > 0),
  };
}

export type BlockMenuShortcut = "primary" | "accessible-fallback";

export function resolveBlockMenuShortcut(input: {
  key: string;
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  composing: boolean;
  blockedSurface: boolean;
}): BlockMenuShortcut | null {
  if (input.composing || input.blockedSurface) return null;
  if (
    (input.metaKey || input.ctrlKey)
    && !input.altKey
    && !input.shiftKey
    && (input.key === "/" || input.code === "Slash")
  ) return "primary";
  if (!input.metaKey && !input.ctrlKey && input.altKey && input.shiftKey && input.key.toLocaleLowerCase() === "m") {
    return "accessible-fallback";
  }
  return null;
}

export function blockMenuShortcutHint(platform: "mac" | "windows", lang: "zh" | "en"): string {
  const key = platform === "mac" ? "⌘/" : "Ctrl+/";
  return lang === "en" ? `${key} opens the current block menu` : `${key} 打开当前区块菜单`;
}
