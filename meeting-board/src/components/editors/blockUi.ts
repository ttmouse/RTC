import type { ListHierarchyAvailability } from "./listHierarchy";

export type BlockEntryType =
  | "text" | `h${1 | 2 | 3 | 4 | 5 | 6}` | "quote" | "callout" | "code"
  | "bullet" | "ordered" | "todo" | "image" | "table" | "math" | "divider"
  | "bookmark" | "audio" | "video" | "file" | "unknown";

export type BlockEntryDescriptor = {
  id: BlockEntryType;
  glyph: string;
  label: string;
};

export type BlockVisualState =
  | "selected-single" | "selected-multi" | "drag-source" | "drag-target" | "menu-target";

export type BlockMenuSection = "convert" | "structure" | "content" | "insert" | "danger";

export const BLOCK_MENU_SECTION_ORDER: readonly BlockMenuSection[] = [
  "convert",
  "structure",
  "content",
  "insert",
  "danger",
];

type BlockMenuArchitectureInput = {
  canConvert: boolean;
  currentType: BlockEntryType;
  selectionCount: number;
  lang: "zh" | "en";
  listHierarchyAvailability?: ListHierarchyAvailability;
};

export const CONVERTIBLE_BLOCK_TYPES = [
  "text", "h1", "h2", "h3", "h4", "h5", "h6", "quote", "callout", "code", "bullet", "ordered", "todo",
] as const;

export type ConvertibleBlockType = typeof CONVERTIBLE_BLOCK_TYPES[number];

export const BLOCK_MENU_CONVERSION_SHORTCUT_TYPES: readonly ConvertibleBlockType[] = [
  "text", "h1", "h2", "h3", "bullet", "ordered", "todo", "code",
];

export function buildBlockMenuInformationArchitecture(input: BlockMenuArchitectureInput) {
  const conversions = input.canConvert
    ? CONVERTIBLE_BLOCK_TYPES.map((id) => ({ id, current: id === input.currentType }))
    : [];
  const listContext = input.currentType === "bullet" || input.currentType === "ordered" || input.currentType === "todo";
  const hierarchyAvailability = input.listHierarchyAvailability ?? {
    lift: { enabled: true, reason: null },
    sink: { enabled: true, reason: null },
  };
  return {
    // Keep the five zones stable even when filtering or the current context leaves a zone empty.
    // Rendering decides whether an empty zone is visible without merging its items into a neighbour.
    sections: [...BLOCK_MENU_SECTION_ORDER],
    conversions,
    conversionShortcuts: conversions.filter((item) => BLOCK_MENU_CONVERSION_SHORTCUT_TYPES.includes(item.id)),
    listHierarchyActions: listContext
      ? (["lift", "sink"] as const).map((id) => ({
          id,
          enabled: hierarchyAvailability[id].enabled,
          ...(hierarchyAvailability[id].reason ? { reason: hierarchyAvailability[id].reason } : {}),
        }))
      : [],
    scope: input.selectionCount > 1
      ? (input.lang === "en"
        ? `Applies to ${input.selectionCount} selected blocks`
        : `将应用于 ${input.selectionCount} 个已选区块`)
      : (input.lang === "en" ? "Applies to 1 block" : "将应用于 1 个区块"),
    // R0 only exposes structure that survives Markdown serialization. Non-list blocks get
    // an explanation instead of fake alignment or colour controls.
    structureNote: listContext
      ? (input.lang === "en" ? "Portable Markdown list hierarchy" : "可移植的 Markdown 列表层级")
      : (input.lang === "en" ? "Alignment and color follow the document theme" : "对齐与颜色跟随文档主题"),
  };
}

export function blockMenuInsertCommands<T extends { id: string }>(registry: readonly T[]): T[] {
  return [...registry];
}

export type BlockMenuMoveKey = "ArrowDown" | "ArrowUp" | "ArrowLeft" | "ArrowRight" | "Home" | "End" | "Tab";

export function moveBlockMenuFocus(
  currentIndex: number,
  key: BlockMenuMoveKey,
  itemCount: number,
  shiftKey = false,
): number {
  if (itemCount <= 0) return -1;
  if (key === "Home") return 0;
  if (key === "End") return itemCount - 1;
  const backwards = key === "ArrowUp" || key === "ArrowLeft" || (key === "Tab" && shiftKey);
  if (currentIndex < 0) return backwards ? itemCount - 1 : 0;
  const next = currentIndex + (backwards ? -1 : 1);
  if (next < 0 || next >= itemCount) return key === "Tab" ? -1 : (next < 0 ? itemCount - 1 : 0);
  return next;
}

export function shouldRunBlockMenuEnter(input: { key: string; imeEnter: boolean; hasTarget: boolean }): boolean {
  return input.key === "Enter" && !input.imeEnter && input.hasTarget;
}

export const BROWSE_ADD_COMPAT_CLICK_WINDOW_MS = 800;

export function isDuplicateBrowseAddCompatibilityClick(
  lastOpenedAt: number,
  eventAt: number,
  windowMs = BROWSE_ADD_COMPAT_CLICK_WINDOW_MS,
): boolean {
  const elapsed = eventAt - lastOpenedAt;
  return Number.isFinite(lastOpenedAt) && elapsed >= 0 && elapsed <= windowMs;
}

const blockVisualClass: Record<BlockVisualState, string> = {
  "selected-single": "block-selected-single",
  "selected-multi": "block-selected-multi",
  "drag-source": "block-drag-source",
  "drag-target": "block-drag-target",
  "menu-target": "block-menu-target",
};

function blockStateAnnouncement(state: BlockVisualState, lang: "zh" | "en", count: number): string {
  if (state === "selected-single") return lang === "en" ? "Block selected" : "已选择区块";
  if (state === "selected-multi") return lang === "en" ? `${count} blocks selected` : `已选择 ${count} 个区块`;
  if (state === "drag-source") return lang === "en" ? (count > 1 ? `Moving ${count} blocks` : "Moving block") : (count > 1 ? `正在移动 ${count} 个区块` : "正在移动区块");
  if (state === "drag-target") return lang === "en" ? "Block drop target" : "区块放置目标";
  return lang === "en" ? "Block actions open" : "区块操作已打开";
}

export function applyBlockVisualState(
  target: HTMLElement,
  state: BlockVisualState,
  status: HTMLElement,
  lang: "zh" | "en",
  count = 1,
): void {
  target.classList.add(blockVisualClass[state]);
  const describedBy = new Set((target.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean));
  if (status.id) describedBy.add(status.id);
  if (describedBy.size > 0) target.setAttribute("aria-describedby", [...describedBy].join(" "));
  status.textContent = blockStateAnnouncement(state, lang, count);
}

export function clearBlockVisualState(target: HTMLElement, state: BlockVisualState, status: string | HTMLElement): void {
  target.classList.remove(blockVisualClass[state]);
  const hasAnotherState = Object.values(blockVisualClass).some((className) => target.classList.contains(className));
  const statusId = typeof status === "string" ? status : status.id;
  // The live region describes the transition that just ended. It must not keep announcing
  // a closed menu or completed drag merely because the block remains visually selected.
  if (typeof status !== "string") status.textContent = "";
  if (hasAnotherState || !statusId) return;
  const describedBy = (target.getAttribute("aria-describedby") ?? "").split(/\s+/).filter((id) => id && id !== statusId);
  if (describedBy.length > 0) target.setAttribute("aria-describedby", describedBy.join(" "));
  else target.removeAttribute("aria-describedby");
}

export function applyBlockSelectionOverlayState(
  overlay: HTMLElement,
  count: number,
  lang: "zh" | "en",
): void {
  overlay.classList.remove("block-selected-single", "block-selected-multi", "is-single", "is-multi");
  const multi = count > 1;
  overlay.classList.add(multi ? "block-selected-multi" : "block-selected-single", multi ? "is-multi" : "is-single");
  overlay.setAttribute("role", "status");
  overlay.setAttribute("aria-label", blockStateAnnouncement(multi ? "selected-multi" : "selected-single", lang, count));
  overlay.removeAttribute("aria-hidden");
}

type BlockEntryInput = {
  nodeName: string;
  headingLevel?: number;
  textContent?: string;
  className?: string;
};

const labels: Record<BlockEntryType, { zh: string; en: string; glyph: string }> = {
  text: { zh: "正文", en: "Text", glyph: "T" },
  h1: { zh: "一级标题", en: "Heading 1", glyph: "H1" },
  h2: { zh: "二级标题", en: "Heading 2", glyph: "H2" },
  h3: { zh: "三级标题", en: "Heading 3", glyph: "H3" },
  h4: { zh: "四级标题", en: "Heading 4", glyph: "H4" },
  h5: { zh: "五级标题", en: "Heading 5", glyph: "H5" },
  h6: { zh: "六级标题", en: "Heading 6", glyph: "H6" },
  quote: { zh: "引用", en: "Quote", glyph: "❞" },
  callout: { zh: "高亮块", en: "Callout", glyph: "!" },
  code: { zh: "代码块", en: "Code", glyph: "<>" },
  bullet: { zh: "无序列表", en: "Bullet list", glyph: "•" },
  ordered: { zh: "有序列表", en: "Numbered list", glyph: "1." },
  todo: { zh: "待办清单", en: "To-do list", glyph: "✓" },
  image: { zh: "图片", en: "Image", glyph: "▧" },
  table: { zh: "表格", en: "Table", glyph: "▦" },
  math: { zh: "公式", en: "Equation", glyph: "∑" },
  divider: { zh: "分割线", en: "Divider", glyph: "—" },
  bookmark: { zh: "网页书签", en: "Web bookmark", glyph: "↗" },
  audio: { zh: "音频", en: "Audio", glyph: "♫" },
  video: { zh: "视频", en: "Video", glyph: "▶" },
  file: { zh: "文件", en: "File", glyph: "▤" },
  unknown: { zh: "区块", en: "Block", glyph: "◆" },
};

function richLinkType(className: string): BlockEntryType | null {
  for (const type of ["bookmark", "audio", "video", "file"] as const) {
    if (className.includes(`is-${type}`) || className.includes(`omia-${type}`)) return type;
  }
  return null;
}

export function resolveBlockEntryDescriptor(input: BlockEntryInput, lang: "zh" | "en"): BlockEntryDescriptor {
  const nodeName = input.nodeName.toLocaleLowerCase();
  const className = input.className?.toLocaleLowerCase() ?? "";
  const richType = richLinkType(className);
  let id: BlockEntryType = "unknown";
  if (richType) id = richType;
  else if (nodeName === "paragraph") id = "text";
  else if (nodeName === "heading") {
    const level = Math.max(1, Math.min(6, Math.trunc(input.headingLevel ?? 1))) as 1 | 2 | 3 | 4 | 5 | 6;
    id = `h${level}`;
  } else if (nodeName.includes("blockquote")) {
    id = /^\s*\[!(?:note|tip|important|warning|caution)\]/i.test(input.textContent ?? "") ? "callout" : "quote";
  } else if (nodeName.includes("code")) id = "code";
  else if (nodeName.includes("bullet")) id = "bullet";
  else if (nodeName.includes("ordered")) id = "ordered";
  else if (nodeName.includes("task") || nodeName.includes("todo")) id = "todo";
  else if (nodeName.includes("image")) id = "image";
  else if (nodeName.includes("table")) id = "table";
  else if (nodeName.includes("math")) id = "math";
  else if (nodeName.includes("horizontal") || nodeName.includes("divider")) id = "divider";
  const copy = labels[id];
  return { id, glyph: copy.glyph, label: copy[lang] };
}

type BlockHandleLabels = {
  addLabel: string;
  actionLabel: string;
  hint: string;
};

export function decorateBlockHandleEntry(
  handle: HTMLElement,
  descriptor: BlockEntryDescriptor,
  copy: BlockHandleLabels,
): void {
  const operations = Array.from(handle.children)
    .filter((child): child is HTMLElement => child instanceof HTMLElement && child.classList.contains("operation-item"));
  const add = operations[0];
  const drag = operations[1];
  handle.draggable = false;
  handle.dataset.pointerReorder = "true";
  if (!add || !drag) return;

  add.setAttribute("role", "button");
  add.setAttribute("tabindex", add.hidden ? "-1" : "0");
  add.setAttribute("aria-label", copy.addLabel);
  add.setAttribute("title", copy.addLabel);

  drag.classList.add("omia-block-entry");
  drag.dataset.blockType = descriptor.id;
  drag.setAttribute("role", "button");
  drag.setAttribute("tabindex", "0");
  drag.setAttribute("aria-haspopup", "menu");
  drag.setAttribute("aria-keyshortcuts", "Enter Space");
  drag.setAttribute("aria-label", `${descriptor.label} · ${copy.actionLabel}`);
  drag.setAttribute("aria-description", copy.hint);
  drag.setAttribute("title", `${descriptor.label} · ${copy.hint}`);

  let marker = drag.querySelector<HTMLElement>(":scope > .omia-block-entry__type");
  if (!marker) {
    marker = document.createElement("span");
    marker.className = "omia-block-entry__type";
    marker.setAttribute("aria-hidden", "true");
    drag.prepend(marker);
  }
  marker.textContent = descriptor.glyph;
  drag.querySelectorAll<SVGElement>("svg").forEach((svg) => svg.classList.add("omia-block-entry__grip"));
}
