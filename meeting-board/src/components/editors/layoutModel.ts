import type { AdvancedTableBlockKind } from "./advancedTableModel";
import {
  parseAdvancedTableHtml,
  parseControlledContainerBlockElement,
  serializeAdvancedTableHtml,
} from "./advancedTableModel";

export const PERSISTENT_LAYOUT_NODE_NAME = "omiaPersistentLayout";
export const PERSISTENT_LAYOUT_VERSION = 1 as const;
export const PERSISTENT_LAYOUT_MIN_COLUMNS = 2;
export const PERSISTENT_LAYOUT_MAX_COLUMNS = 3;
export const PERSISTENT_LAYOUT_MAX_BLOCKS = 1000;

export type PersistentLayoutBlockKind = AdvancedTableBlockKind | "divider" | "advanced-table";

export type PersistentLayoutBlock = Readonly<{
  kind: PersistentLayoutBlockKind;
  /** Strict canonical HTML; never arbitrary source HTML. */
  html: string;
}>;

export type PersistentLayoutColumn = Readonly<{
  index: number;
  blocks: readonly PersistentLayoutBlock[];
}>;

export type PersistentLayoutModel = Readonly<{
  version: typeof PERSISTENT_LAYOUT_VERSION;
  widths: readonly number[];
  columns: readonly PersistentLayoutColumn[];
}>;

export const PERSISTENT_LAYOUT_EMPTY_BLOCK: PersistentLayoutBlock = Object.freeze({
  kind: "paragraph",
  html: "<p></p>",
});

export type PersistentLayoutParseResult =
  | { ok: true; model: PersistentLayoutModel }
  | { ok: false; error: string; source: string };

const POSITIVE_INTEGER = /^[1-9]\d*$/;

function escapeText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function exactAttributes(element: Element, allowed: readonly string[]): boolean {
  const names = Array.from(element.attributes, ({ name }) => name.toLowerCase());
  return names.length === new Set(names).size
    && names.every((name) => allowed.includes(name))
    && allowed.filter((name) => element.hasAttribute(name)).length === names.length;
}

function elementChildrenOnly(element: Element): Element[] | null {
  if (Array.from(element.childNodes).some((node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim())) return null;
  if (Array.from(element.childNodes).some((node) => node.nodeType !== Node.TEXT_NODE && node.nodeType !== Node.ELEMENT_NODE)) return null;
  return Array.from(element.children);
}

function oneElement(source: string): Element | null {
  const template = document.createElement("template");
  template.innerHTML = source.trim();
  const children = Array.from(template.content.childNodes)
    .filter((node) => node.nodeType !== Node.TEXT_NODE || node.textContent?.trim());
  return children.length === 1 && children[0] instanceof Element ? children[0] : null;
}

function canonicalLayoutBlock(element: Element): PersistentLayoutBlock | null {
  const tag = element.tagName.toLowerCase();
  if (tag === "hr") {
    return exactAttributes(element, []) ? { kind: "divider", html: "<hr>" } : null;
  }
  if (tag === "table") {
    const parsed = parseAdvancedTableHtml(element.outerHTML);
    return parsed.ok
      ? { kind: "advanced-table", html: serializeAdvancedTableHtml(parsed.model) }
      : null;
  }
  const controlled = parseControlledContainerBlockElement(element);
  return controlled ? { kind: controlled.kind, html: controlled.html } : null;
}

export function canonicalizePersistentLayoutBlock(source: string): PersistentLayoutBlock | null {
  try {
    const element = oneElement(source);
    return element ? canonicalLayoutBlock(element) : null;
  } catch {
    return null;
  }
}

function equalWidths(count: number): number[] {
  const base = Math.floor(10000 / count);
  return Array.from({ length: count }, (_unused, index) => base + (index < 10000 - base * count ? 1 : 0));
}

function validWidths(widths: readonly number[], count: number): boolean {
  return widths.length === count
    && widths.every((width) => Number.isInteger(width) && width > 0 && width <= 10000)
    && widths.reduce((sum, width) => sum + width, 0) === 10000;
}

function validBlock(block: PersistentLayoutBlock): boolean {
  if (!block || typeof block !== "object") return false;
  const keys = Object.keys(block).sort();
  if (keys.join(",") !== "html,kind" || typeof block.html !== "string") return false;
  const canonical = canonicalizePersistentLayoutBlock(block.html);
  return canonical?.kind === block.kind && canonical.html === block.html;
}

export function validatePersistentLayoutModel(value: unknown): value is PersistentLayoutModel {
  if (!value || typeof value !== "object") return false;
  const model = value as Partial<PersistentLayoutModel>;
  if (Object.keys(value as object).sort().join(",") !== "columns,version,widths"
    || model.version !== PERSISTENT_LAYOUT_VERSION
    || !Array.isArray(model.widths)
    || !Array.isArray(model.columns)
    || model.columns.length < PERSISTENT_LAYOUT_MIN_COLUMNS
    || model.columns.length > PERSISTENT_LAYOUT_MAX_COLUMNS
    || !validWidths(model.widths, model.columns.length)) return false;
  let totalBlocks = 0;
  for (let index = 0; index < model.columns.length; index++) {
    const column = model.columns[index];
    if (!column || typeof column !== "object"
      || Object.keys(column).sort().join(",") !== "blocks,index"
      || column.index !== index
      || !Array.isArray(column.blocks)
      || column.blocks.length === 0) return false;
    totalBlocks += column.blocks.length;
    if (totalBlocks > PERSISTENT_LAYOUT_MAX_BLOCKS || !column.blocks.every(validBlock)) return false;
  }
  return true;
}

/** Creates an immutable, validated file model. Callers must pass canonical
 * controlled blocks; invalid or recursive content fails closed. */
export function createPersistentLayoutModel(
  columns: readonly (readonly PersistentLayoutBlock[])[],
  widths: readonly number[] = equalWidths(columns.length),
): PersistentLayoutModel | null {
  const model: PersistentLayoutModel = {
    version: PERSISTENT_LAYOUT_VERSION,
    widths: Object.freeze([...widths]),
    columns: Object.freeze(columns.map((blocks, index) => Object.freeze({
      index,
      blocks: Object.freeze(blocks.map((block) => Object.freeze({ ...block }))),
    }))),
  };
  return validatePersistentLayoutModel(model) ? model : null;
}

/** Deterministic downgrade order: left-to-right columns, then document order
 * within each column. No DOM geometry or viewport state participates. */
export function linearizePersistentLayout(model: PersistentLayoutModel): readonly PersistentLayoutBlock[] | null {
  if (!validatePersistentLayoutModel(model)) return null;
  return model.columns.flatMap((column) => column.blocks.map((block) => ({ ...block })));
}

function indent(source: string, spaces: number): string {
  const prefix = " ".repeat(spaces);
  return source.split("\n").map((line) => `${prefix}${line}`).join("\n");
}

export function serializePersistentLayoutHtml(model: PersistentLayoutModel): string {
  if (!validatePersistentLayoutModel(model)) throw new Error("Cannot serialize invalid persistent layout model");
  const columns = model.columns.map((column) => {
    const blocks = column.blocks.map((block) => indent(block.html, 4)).join("\n");
    return `  <section data-omia-column="${column.index}">\n${blocks}\n  </section>`;
  }).join("\n");
  return `<div data-omia-layout="${model.version}" data-omia-columns="${model.columns.length}" data-omia-widths="${model.widths.join(",")}">\n${columns}\n</div>`;
}

function wellFormedPersistentLayoutSource(source: string): boolean {
  const allowed = new Set([
    "div", "section", "p", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li",
    "blockquote", "aside", "pre", "code", "figure", "img", "a", "strong", "b", "em",
    "i", "s", "del", "br", "u", "span", "hr", "table", "colgroup", "col", "thead",
    "tbody", "tr", "th", "td",
  ]);
  const voidTags = new Set(["img", "br", "hr", "col"]);
  const stack: string[] = [];
  const tagPattern = /<\/?([A-Za-z][A-Za-z0-9-]*)\b[^<>]*>/g;
  let previous = 0;
  let match: RegExpExecArray | null;
  while ((match = tagPattern.exec(source))) {
    if (/[<>]/.test(source.slice(previous, match.index))) return false;
    const raw = match[0];
    const name = match[1].toLowerCase();
    if (!allowed.has(name)) return false;
    const closing = /^<\s*\//.test(raw);
    const selfClosing = /\/\s*>$/.test(raw);
    if (closing) {
      if (voidTags.has(name) || stack.pop() !== name) return false;
    } else if (!voidTags.has(name)) {
      if (selfClosing) return false;
      stack.push(name);
    }
    previous = tagPattern.lastIndex;
  }
  return stack.length === 0
    && !/[<>]/.test(source.slice(previous))
    && /^\s*<div\b/i.test(source)
    && /<\/div>\s*$/i.test(source);
}

export function parsePersistentLayoutHtml(source: string): PersistentLayoutParseResult {
  try {
    if (!wellFormedPersistentLayoutSource(source)) return { ok: false, error: "malformed persistent layout source", source };
    const root = oneElement(source);
    if (!(root instanceof HTMLDivElement)
      || !exactAttributes(root, ["data-omia-layout", "data-omia-columns", "data-omia-widths"])
      || root.getAttribute("data-omia-layout") !== String(PERSISTENT_LAYOUT_VERSION)) {
      return { ok: false, error: "invalid persistent layout container", source };
    }
    const columnCountRaw = root.getAttribute("data-omia-columns") ?? "";
    const columnCount = POSITIVE_INTEGER.test(columnCountRaw) ? Number(columnCountRaw) : 0;
    if (columnCount < PERSISTENT_LAYOUT_MIN_COLUMNS || columnCount > PERSISTENT_LAYOUT_MAX_COLUMNS) {
      return { ok: false, error: "invalid persistent layout column count", source };
    }
    const widthsRaw = root.getAttribute("data-omia-widths") ?? "";
    const widths = widthsRaw.split(",").map((part) => POSITIVE_INTEGER.test(part) ? Number(part) : 0);
    const sections = elementChildrenOnly(root);
    if (!sections || sections.length !== columnCount || !validWidths(widths, columnCount)) {
      return { ok: false, error: "invalid persistent layout geometry", source };
    }
    const columns: PersistentLayoutColumn[] = [];
    for (let index = 0; index < sections.length; index++) {
      const section = sections[index];
      if (section.tagName.toLowerCase() !== "section"
        || !exactAttributes(section, ["data-omia-column"])
        || section.getAttribute("data-omia-column") !== String(index)) {
        return { ok: false, error: "invalid persistent layout column", source };
      }
      const elements = elementChildrenOnly(section);
      if (!elements?.length) return { ok: false, error: "empty persistent layout column", source };
      const blocks = elements.map(canonicalLayoutBlock);
      if (blocks.some((block) => !block)) return { ok: false, error: "unsupported persistent layout block", source };
      columns.push({ index, blocks: blocks as PersistentLayoutBlock[] });
    }
    const model = createPersistentLayoutModel(columns.map((column) => column.blocks), widths);
    return model ? { ok: true, model } : { ok: false, error: "invalid persistent layout model", source };
  } catch {
    return { ok: false, error: "persistent layout parse failed", source };
  }
}

type LayoutRange = { from: number; to: number; source: string };

function persistentLayoutRanges(source: string): { ok: true; ranges: LayoutRange[] } | { ok: false } {
  const ranges: LayoutRange[] = [];
  const opening = /<div\b[^>]*\bdata-omia-layout\s*=\s*(?:"[^"]*"|'[^']*')[^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = opening.exec(source))) {
    if (ranges.some((range) => match!.index < range.to)) continue;
    const tag = /<\/?div\b[^>]*>/gi;
    tag.lastIndex = match.index;
    let depth = 0;
    let close = -1;
    let divTag: RegExpExecArray | null;
    while ((divTag = tag.exec(source))) {
      depth += /^<\s*\/div/i.test(divTag[0]) ? -1 : 1;
      if (depth === 0) { close = tag.lastIndex; break; }
    }
    if (close < 0) return { ok: false };
    ranges.push({ from: match.index, to: close, source: source.slice(match.index, close) });
    opening.lastIndex = close;
  }
  return { ok: true, ranges };
}

/** Removes only complete, valid controlled layout containers before the raw-HTML
 * safety classifier runs. Invalid/future containers stay visible to the guard. */
export function stripValidPersistentLayoutsForSafety(source: string):
  | { ok: true; source: string; count: number }
  | { ok: false; source: string } {
  const found = persistentLayoutRanges(source);
  if (!found.ok) return { ok: false, source };
  for (const range of found.ranges) if (!parsePersistentLayoutHtml(range.source).ok) return { ok: false, source };
  let stripped = source;
  for (const range of [...found.ranges].reverse()) stripped = stripped.slice(0, range.from) + stripped.slice(range.to);
  return { ok: true, source: stripped, count: found.ranges.length };
}

/** Safe text-only fallback for viewers that cannot render the controlled HTML. */
export function persistentLayoutPlainText(model: PersistentLayoutModel): string | null {
  const blocks = linearizePersistentLayout(model);
  if (!blocks) return null;
  return blocks.map((block) => {
    const element = oneElement(block.html);
    return element?.textContent ?? escapeText(block.html);
  }).join("\n");
}
