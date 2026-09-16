const NEW_DOCUMENT_MARKDOWN = "# \n\n";

export type NewDocumentStructure = {
  titleEmpty: boolean;
  bodyEmpty: boolean;
};

export type PointerSample = { x: number; y: number; at: number };

export type SlashMenuLayoutInput = {
  viewportTop: number;
  viewportBottom: number;
  anchorTop: number;
  anchorBottom: number;
  preferredMenuHeight: number;
  fixedChromeHeight: number;
  maxGroupHeight: number;
  gap?: number;
};

export type SlashMenuLayout = {
  placement: "above" | "below";
  top: number;
  groupMaxHeight: number;
};

export function resolveInsertMenuLeft(input: {
  viewportLeft: number;
  viewportRight: number;
  anchorLeft: number;
  menuWidth: number;
  padding?: number;
}): number {
  const padding = input.padding ?? 8;
  const firstLeft = input.viewportLeft + padding;
  const lastLeft = Math.max(firstLeft, input.viewportRight - padding - input.menuWidth);
  return Math.max(firstLeft, Math.min(lastLeft, input.anchorLeft));
}

/**
 * 斜杠菜单的碰撞布局：能完整放下时优先向下，否则向上；两边都不够时选空间更大的一侧，
 * 只压缩可滚动的命令列表，不裁分类栏/状态区，也不让菜单越过编辑器可视边界。
 */
export function resolveSlashMenuLayout(input: SlashMenuLayoutInput): SlashMenuLayout {
  const gap = input.gap ?? 8;
  const below = Math.max(0, input.viewportBottom - input.anchorBottom - gap);
  const above = Math.max(0, input.anchorTop - input.viewportTop - gap);
  let placement: SlashMenuLayout["placement"];
  if (below >= input.preferredMenuHeight) placement = "below";
  else if (above >= input.preferredMenuHeight) placement = "above";
  else placement = above > below ? "above" : "below";

  const available = placement === "below" ? below : above;
  const preferredGroupHeight = Math.max(0, input.preferredMenuHeight - input.fixedChromeHeight);
  const availableGroupHeight = Math.max(32, available - input.fixedChromeHeight);
  const groupMaxHeight = Math.max(0, Math.min(
    input.maxGroupHeight,
    preferredGroupHeight,
    availableGroupHeight,
  ));
  const menuHeight = input.fixedChromeHeight + groupMaxHeight;
  const unclampedTop = placement === "below"
    ? input.anchorBottom + gap
    : input.anchorTop - gap - menuHeight;
  const latestTop = Math.max(input.viewportTop, input.viewportBottom - menuHeight);
  const top = Math.max(input.viewportTop, Math.min(latestTop, unclampedTop));
  return { placement, top, groupMaxHeight };
}

export type RichLinkKind = "bookmark" | "audio" | "video" | "file";

export type NormalizedRichLink = {
  href: string;
  label: string;
  title: `omia:${RichLinkKind}`;
};

export type RichLinkInputResult =
  | { ok: true; value: NormalizedRichLink }
  | { ok: false; reason: "empty" | "unsafe" | "unsupported" };

const RICH_LINK_SCHEME_RE = /^([a-z][a-z0-9+.-]*):/i;
const WINDOWS_PATH_RE = /^[a-z]:[\\/]/i;

/**
 * 富链接块仍落盘为标准 Markdown link + title；只接受可导航/可播放地址。
 * 未知协议（尤其 javascript/vbscript）一律拒绝，普通文件相对路径与 Windows 路径保留。
 */
export function normalizeRichLinkInput(
  kind: RichLinkKind,
  rawUrl: string,
  rawLabel: string,
): RichLinkInputResult {
  let href = rawUrl.trim();
  if (!href) return { ok: false, reason: "empty" };
  if (/[\u0000-\u001f\u007f]/.test(href)) return { ok: false, reason: "unsafe" };

  if (kind === "bookmark" && !RICH_LINK_SCHEME_RE.test(href)) href = `https://${href}`;
  const scheme = WINDOWS_PATH_RE.test(href) ? "" : (href.match(RICH_LINK_SCHEME_RE)?.[1].toLowerCase() ?? "");
  if (["javascript", "vbscript"].includes(scheme)) return { ok: false, reason: "unsafe" };

  if (kind === "bookmark") {
    if (scheme !== "http" && scheme !== "https") return { ok: false, reason: "unsupported" };
    try {
      const parsed = new URL(href);
      if (!parsed.hostname) return { ok: false, reason: "unsupported" };
      href = parsed.href;
    } catch {
      return { ok: false, reason: "unsupported" };
    }
  } else if (scheme && !["http", "https", "file", "asset"].includes(scheme)) {
    return { ok: false, reason: "unsupported" };
  }

  const explicitLabel = rawLabel.trim();
  let fallback = kind === "bookmark" ? href : kind === "audio" ? "Audio" : kind === "video" ? "Video" : "File";
  try {
    const parsed = new URL(href);
    fallback = kind === "bookmark"
      ? parsed.hostname.replace(/^www\./i, "")
      : decodeURIComponent(parsed.pathname.split("/").filter(Boolean).pop() ?? fallback);
  } catch {
    fallback = href.split(/[\\/]/).filter(Boolean).pop() ?? fallback;
  }
  return {
    ok: true,
    value: { href, label: explicitLabel || fallback, title: `omia:${kind}` },
  };
}

export type BlockKeyboardAction = "duplicate" | "move-up" | "move-down" | null;

export type SelectAllStageInput = {
  key: string;
  commandModifier: boolean;
  shiftKey: boolean;
  altKey: boolean;
  isComposing: boolean;
  hasBlockSelection: boolean;
  isTextSelection: boolean;
  sameTextblock: boolean;
  textblockEmpty: boolean;
  selectionCoversTextblock: boolean;
};

/**
 * Notion 式两段全选：第一次只扩大到当前文字块，第二次再交回编辑器全选整篇。
 * 代码块、多块选择、输入法和已经覆盖整块的选区都不接管，避免吞掉原能力。
 */
export function shouldStageSelectAll(input: SelectAllStageInput): boolean {
  return input.key.toLocaleLowerCase() === "a"
    && input.commandModifier
    && !input.shiftKey
    && !input.altKey
    && !input.isComposing
    && !input.hasBlockSelection
    && input.isTextSelection
    && input.sameTextblock
    && !input.textblockEmpty
    && !input.selectionCoversTextblock;
}

/** Notion 式块快捷键只在明确的组合键上生效，输入法、Alt 组合和普通文字选择一律放行。 */
export function resolveBlockKeyboardAction(input: {
  key: string;
  commandModifier: boolean;
  shiftKey: boolean;
  altKey: boolean;
  isComposing: boolean;
  selectionCollapsed: boolean;
}): BlockKeyboardAction {
  if (
    !input.commandModifier
    || input.altKey
    || input.isComposing
    || !input.selectionCollapsed
  ) return null;
  const key = input.key.toLocaleLowerCase();
  if (key === "d" && !input.shiftKey) return "duplicate";
  if (input.shiftKey && input.key === "ArrowUp") return "move-up";
  if (input.shiftKey && input.key === "ArrowDown") return "move-down";
  return null;
}

const SLASH_COMMAND_ALIAS_SEPARATOR = "\u2063";

/** Crepe 只按 label 搜索；把别名放进同一字段，渲染层再拆成低对比度辅助词。 */
export function slashCommandLabel(primary: string, ...aliases: string[]): string {
  const cleanPrimary = primary.trim();
  const seen = new Set([cleanPrimary.toLocaleLowerCase()]);
  const cleanAliases = aliases.map((alias) => alias.trim()).filter((alias) => {
    const normalized = alias.toLocaleLowerCase();
    if (!normalized || seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
  return [cleanPrimary, ...cleanAliases].join(SLASH_COMMAND_ALIAS_SEPARATOR);
}

export function splitSlashCommandLabel(label: string): { primary: string; aliases: string[] } {
  const [primary = "", ...aliases] = label.split(SLASH_COMMAND_ALIAS_SEPARATOR);
  return { primary, aliases };
}

export type NewDocumentBoundaryAction = "none" | "keep-title" | "clear-page" | "enter-body" | "focus-title-end" | "focus-body-start";

type NewDocumentBoundaryInput = {
  key: string;
  selectionCollapsed: boolean;
  selectionCoversDocument: boolean;
  hasCommandModifier: boolean;
  hasBlockSelection: boolean;
  firstBlockIsPageTitle: boolean;
  firstBodyIsTextblock: boolean;
  topLevelIndex: number;
  offsetInTextblock: number;
  textblockSize: number;
};

/**
 * 新建页的首个 H1 是页面标题，不是可与正文任意拼接的普通 Markdown 块。
 * 这里只描述三个精确边界；列表、引用、普通文档和块级多选全部交还 ProseMirror 原行为。
 */
export function resolveNewDocumentBoundaryAction(input: NewDocumentBoundaryInput): NewDocumentBoundaryAction {
  if (
    input.hasCommandModifier
    || input.hasBlockSelection
    || !input.firstBlockIsPageTitle
  ) return "none";

  if (
    (input.key === "Backspace" || input.key === "Delete")
    && input.selectionCoversDocument
  ) return "clear-page";
  if (!input.selectionCollapsed) return "none";
  if (input.key === "Enter" && input.topLevelIndex === 0) return "enter-body";
  if (input.key === "Backspace" && input.topLevelIndex === 0 && input.offsetInTextblock === 0) {
    return "keep-title";
  }
  if (
    input.key === "Delete"
    && input.topLevelIndex === 0
    && input.offsetInTextblock === input.textblockSize
    && input.firstBodyIsTextblock
  ) return "focus-body-start";
  if (
    input.key === "Backspace"
    && input.topLevelIndex === 1
    && input.offsetInTextblock === 0
    && input.firstBodyIsTextblock
  ) return "focus-title-end";
  return "none";
}

export function initialEditorValue(value: string, newDocument = false): string {
  return newDocument && value.trim() === "" ? NEW_DOCUMENT_MARKDOWN : value;
}

/** 新文稿固定把第一个一级标题当页标题；首屏引导只看标题之外有没有正文。 */
export function inspectNewDocument(markdown: string): NewDocumentStructure {
  const normalized = markdown.replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  const titleMatch = lines[0]?.match(/^#(?:\s+(.*))?$/);
  if (!titleMatch) {
    return { titleEmpty: true, bodyEmpty: normalized.trim() === "" };
  }
  return {
    titleEmpty: !(titleMatch[1] ?? "").trim(),
    bodyEmpty: lines.slice(1).join("\n").trim() === "",
  };
}

/** 保存新稿时沿用页面标题，避免每次都从「未命名.md」重新改名。 */
export function suggestedMarkdownFilename(markdown: string, fallback: string): string {
  const firstLine = markdown.replace(/\r\n?/g, "\n").split("\n")[0] ?? "";
  const title = firstLine.match(/^#\s+(.+)$/)?.[1]
    ?.replace(/[\\/:*?"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "")
    .slice(0, 80);
  return title ? `${title}.md` : fallback;
}

/** 六点短按开菜单、拖拽只排序：小位移和短时长必须同时成立。 */
export function isBlockHandleTap(start: PointerSample, end: PointerSample): boolean {
  return Math.hypot(end.x - start.x, end.y - start.y) <= 4 && end.at - start.at <= 650;
}

export function canMoveTopLevelBlock(index: number, count: number, protectFirst: boolean, direction: "up" | "down"): boolean {
  if (index < 0 || index >= count) return false;
  return direction === "up" ? index > (protectFirst ? 1 : 0) : index < count - 1;
}

/**
 * 把命中的“原始块 + 前/后半区”换算成删除源块后的最终索引。
 * 块排序故意走 Pointer Events，不借 HTML5 drag：Tauri 的原生文件拖入在 Windows
 * 会占用 HTML5 drag，两套能力共用它就只能二选一。
 */
export function resolveBlockDropIndex(
  sourceIndex: number,
  targetIndex: number,
  dropAfter: boolean,
  count: number,
  protectFirst: boolean,
): number {
  return resolveBlockGroupDropIndex([sourceIndex], targetIndex, dropAfter, count, protectFirst);
}

/** 多个已选块删除后，计算它们作为一个连续组重新插入的索引。 */
export function resolveBlockGroupDropIndex(
  sourceIndices: number[],
  targetIndex: number,
  dropAfter: boolean,
  count: number,
  protectFirst: boolean,
): number {
  const uniqueSources = [...new Set(sourceIndices)].filter((index) => index >= 0 && index < count).sort((a, b) => a - b);
  const fallback = uniqueSources[0] ?? -1;
  if (count <= 0 || uniqueSources.length === 0 || targetIndex < 0 || targetIndex >= count) return fallback;
  const firstMovable = protectFirst ? 1 : 0;
  if (uniqueSources.some((index) => index < firstMovable)) return fallback;

  // boundary 是原文档两个块之间的槽位；被删除且位于槽位左侧的块各让它左移一格。
  let boundary = targetIndex + (dropAfter ? 1 : 0);
  boundary -= uniqueSources.filter((index) => index < boundary).length;
  return Math.max(firstMovable, Math.min(count - uniqueSources.length, boundary));
}

/** 多选区块作为一个组按菜单“上移/下移”一格；返回删除源块后的插入索引。 */
export function blockGroupStepDestination(
  sourceIndices: number[],
  count: number,
  protectFirst: boolean,
  direction: "up" | "down",
): number | null {
  const uniqueSources = [...new Set(sourceIndices)].filter((index) => index >= 0 && index < count).sort((a, b) => a - b);
  if (count <= 0 || uniqueSources.length === 0) return null;
  const firstMovable = protectFirst ? 1 : 0;
  if (uniqueSources.some((index) => index < firstMovable)) return null;
  const destination = uniqueSources[0] + (direction === "up" ? -1 : 1);
  if (destination < firstMovable || destination > count - uniqueSources.length) return null;
  return destination;
}

/** 拖到编辑器上下边缘时按接近程度加速；正文安全区内完全不滚。 */
export function blockDragAutoScrollVelocity(
  clientY: number,
  viewportTop: number,
  viewportBottom: number,
  edgeSize = 72,
  maxSpeed = 18,
): number {
  if (viewportBottom <= viewportTop || edgeSize <= 0 || maxSpeed <= 0) return 0;
  if (clientY < viewportTop + edgeSize) {
    const proximity = Math.min(1, Math.max(0, (viewportTop + edgeSize - clientY) / edgeSize));
    return -maxSpeed * proximity * proximity;
  }
  if (clientY > viewportBottom - edgeSize) {
    const proximity = Math.min(1, Math.max(0, (clientY - (viewportBottom - edgeSize)) / edgeSize));
    return maxSpeed * proximity * proximity;
  }
  return 0;
}

export type BlockDropViewport = { left: number; right: number; top: number; bottom: number };

/** 允许在编辑器边缘稍微探出去以触发滚动；真正拖远则视为取消，不误落到文首/文末。 */
export function isBlockDropPointUsable(
  clientX: number,
  clientY: number,
  viewport: BlockDropViewport,
  tolerance = 48,
): boolean {
  return clientX >= viewport.left - tolerance
    && clientX <= viewport.right + tolerance
    && clientY >= viewport.top - tolerance
    && clientY <= viewport.bottom + tolerance;
}

/** Crepe 图片块默认返回 blob: 临时地址，应用一关就失效；新文档尚无资源目录，先内嵌最稳。 */
export function imageFileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result ?? "")), { once: true });
    reader.addEventListener("error", () => reject(reader.error ?? new Error("image read failed")), { once: true });
    reader.readAsDataURL(file);
  });
}
