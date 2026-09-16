import { Fragment, type Node as ProseNode } from "@milkdown/kit/prose/model";
import type { EditorState, Transaction } from "@milkdown/kit/prose/state";
import {
  CONTROLLED_COLOR_TOKENS,
  controlledInlineClosingTag,
  controlledInlineOpeningTag,
  isControlledColorToken,
  parseControlledInlineOpenTag,
  type ControlledColorToken,
} from "../../lib/controlledInlineFormat";

export const ADVANCED_TABLE_NODE_NAME = "omiaAdvancedTable";
export const ADVANCED_TABLE_VERSION = 1 as const;
export const ADVANCED_TABLE_MAX_DEPTH = 8;

export type AdvancedTableBlockKind =
  | "paragraph"
  | `heading-${2 | 3 | 4 | 5 | 6}`
  | "bullet-list"
  | "ordered-list"
  | "task-list"
  | "quote"
  | "callout"
  | "code"
  | "image"
  | "rich-link"
  | "math-block";

export type AdvancedTableBlock = {
  kind: AdvancedTableBlockKind;
  /** Strictly validated canonical HTML, never arbitrary source HTML. */
  html: string;
};

export type AdvancedTableCell = {
  colspan: number;
  rowspan: number;
  background?: ControlledColorToken;
  blocks: AdvancedTableBlock[];
};

export type AdvancedTableRow = { cells: AdvancedTableCell[] };

export type AdvancedTableModel = {
  version: typeof ADVANCED_TABLE_VERSION;
  widths: number[];
  head: AdvancedTableRow[];
  body: AdvancedTableRow[];
};

export type AdvancedTableParseResult =
  | { ok: true; model: AdvancedTableModel }
  | { ok: false; error: string; source: string };

export type AdvancedTableTarget = { pos: number; nodeSize: number };

export type AdvancedTableUpgradeAnalysis =
  | { ok: true; model: AdvancedTableModel; target: AdvancedTableTarget }
  | { ok: false; reason: "stale-target" | "not-gfm-table" | "invalid-grid" | "unsupported-content" };

export type AdvancedTableDowngradeLoss =
  | "column-widths"
  | "merged-cells"
  | "cell-backgrounds"
  | "complex-blocks"
  | "inline-formatting";

export type AdvancedTableDowngradeAnalysis = {
  lossless: boolean;
  losses: AdvancedTableDowngradeLoss[];
};

type CanonicalBlock = AdvancedTableBlock | { error: string };

const CALLOUT_TOKENS = new Set(["info", "tip", "warning", "error", "success"]);
const RICH_LINK_KINDS = new Set(["bookmark", "audio", "video", "file"]);
const INTEGER = /^[1-9]\d*$/;
const SAFE_LANGUAGE = /^[A-Za-z0-9_+#.-]{1,64}$/;

function escapeText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(value: string): string {
  return escapeText(value).replace(/"/g, "&quot;");
}

function elementChildrenOnly(element: Element): Element[] | null {
  if (Array.from(element.childNodes).some((node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim())) return null;
  if (Array.from(element.childNodes).some((node) => node.nodeType !== Node.TEXT_NODE && node.nodeType !== Node.ELEMENT_NODE)) return null;
  return Array.from(element.children);
}

function exactAttributes(element: Element, allowed: readonly string[]): boolean {
  const names = Array.from(element.attributes, ({ name }) => name.toLowerCase());
  return names.length === new Set(names).size
    && names.every((name) => allowed.includes(name))
    && allowed.filter((name) => element.hasAttribute(name)).length === names.length;
}

function openingTag(element: Element): string {
  const attrs = Array.from(element.attributes)
    .map(({ name, value }) => `${name}="${escapeAttr(value)}"`)
    .join(" ");
  return `<${element.tagName.toLowerCase()}${attrs ? ` ${attrs}` : ""}>`;
}

function safeUrl(value: string, image = false): boolean {
  const trimmed = value.trim();
  if (!trimmed || /[\u0000-\u001f\u007f]/.test(trimmed)) return false;
  if (/^(?:https?:|mailto:|file:|asset:|blob:)/i.test(trimmed)) return true;
  if (image && /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+=*$/i.test(trimmed)) return true;
  return /^(?:[./#]|[^:?#]+(?:[?#]|$))/.test(trimmed) && !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(trimmed);
}

function canonicalInline(nodes: NodeListOf<ChildNode> | ChildNode[], depth = 0): string | null {
  if (depth > ADVANCED_TABLE_MAX_DEPTH + 8) return null;
  let output = "";
  for (const node of Array.from(nodes)) {
    if (node.nodeType === Node.TEXT_NODE) {
      output += escapeText(node.textContent ?? "");
      continue;
    }
    if (!(node instanceof Element)) return null;
    const tag = node.tagName.toLowerCase();
    if (tag === "br") {
      if (!exactAttributes(node, [])) return null;
      output += "<br>";
      continue;
    }
    if (["strong", "b", "em", "i", "s", "del", "code"].includes(tag)) {
      if (!exactAttributes(node, [])) return null;
      const inside = canonicalInline(node.childNodes, depth + 1);
      if (inside == null) return null;
      const canonicalTag = tag === "b" ? "strong" : tag === "i" ? "em" : tag === "del" ? "s" : tag;
      output += `<${canonicalTag}>${inside}</${canonicalTag}>`;
      continue;
    }
    if (tag === "a") {
      if (!exactAttributes(node, ["href", "title"]) || !node.hasAttribute("href")) return null;
      const href = node.getAttribute("href") ?? "";
      if (!safeUrl(href)) return null;
      const inside = canonicalInline(node.childNodes, depth + 1);
      if (inside == null) return null;
      const title = node.hasAttribute("title") ? ` title="${escapeAttr(node.getAttribute("title") ?? "")}"` : "";
      output += `<a href="${escapeAttr(href)}"${title}>${inside}</a>`;
      continue;
    }
    if (tag === "u" || tag === "span") {
      if (tag === "span" && node.getAttribute("data-omia-math") === "inline") {
        if (!exactAttributes(node, ["data-omia-math"])) return null;
        output += `<span data-omia-math="inline">${escapeText(node.textContent ?? "")}</span>`;
        continue;
      }
      const parsed = parseControlledInlineOpenTag(openingTag(node));
      if (!parsed) return null;
      const inside = canonicalInline(node.childNodes, depth + 1);
      if (inside == null) return null;
      output += controlledInlineOpeningTag(parsed.kind, parsed.token)
        + inside
        + controlledInlineClosingTag(parsed.kind);
      continue;
    }
    return null;
  }
  return output;
}

function canonicalBlockChildren(element: Element, depth: number): string | null {
  const children = elementChildrenOnly(element);
  if (!children || children.length === 0) return null;
  let html = "";
  for (const child of children) {
    const block = canonicalBlock(child, depth);
    if ("error" in block) return null;
    html += block.html;
  }
  return html;
}

function canonicalList(element: Element, depth: number, ordered: boolean): CanonicalBlock {
  if (depth > ADVANCED_TABLE_MAX_DEPTH) return { error: "block depth exceeds 8" };
  const isTask = !ordered && element.hasAttribute("data-omia-task-list");
  if (!exactAttributes(element, isTask ? ["data-omia-task-list"] : [])
    || (isTask && element.getAttribute("data-omia-task-list") !== "1")) return { error: "invalid list attributes" };
  const items = elementChildrenOnly(element);
  if (!items?.length || items.some((item) => item.tagName.toLowerCase() !== "li")) return { error: "invalid list items" };
  let content = "";
  for (const item of items) {
    if (!exactAttributes(item, isTask ? ["data-checked"] : [])) return { error: "invalid list item attributes" };
    if (isTask && !["true", "false"].includes(item.getAttribute("data-checked") ?? "")) return { error: "invalid task state" };
    const children = elementChildrenOnly(item);
    if (!children?.length) return { error: "empty list item" };
    let childHtml = "";
    for (const child of children) {
      const block = canonicalBlock(child, depth + 1);
      if ("error" in block) return block;
      childHtml += block.html;
    }
    const checked = isTask ? ` data-checked="${item.getAttribute("data-checked")}"` : "";
    content += `<li${checked}>${childHtml}</li>`;
  }
  const tag = ordered ? "ol" : "ul";
  const marker = isTask ? ' data-omia-task-list="1"' : "";
  return { kind: isTask ? "task-list" : ordered ? "ordered-list" : "bullet-list", html: `<${tag}${marker}>${content}</${tag}>` };
}

function canonicalBlock(element: Element, depth = 1): CanonicalBlock {
  const tag = element.tagName.toLowerCase();
  if (tag === "p" || /^h[2-6]$/.test(tag)) {
    if (!exactAttributes(element, [])) return { error: "invalid text block attributes" };
    const html = canonicalInline(element.childNodes);
    if (html == null) return { error: "invalid inline content" };
    return {
      kind: tag === "p" ? "paragraph" : `heading-${tag.slice(1)}` as AdvancedTableBlockKind,
      html: `<${tag}>${html}</${tag}>`,
    };
  }
  if (tag === "ul" || tag === "ol") return canonicalList(element, depth, tag === "ol");
  if (tag === "blockquote") {
    if (depth > ADVANCED_TABLE_MAX_DEPTH) return { error: "block depth exceeds 8" };
    if (!exactAttributes(element, [])) return { error: "invalid quote attributes" };
    const html = canonicalBlockChildren(element, depth + 1);
    return html == null ? { error: "invalid quote content" } : { kind: "quote", html: `<blockquote>${html}</blockquote>` };
  }
  if (tag === "aside") {
    if (depth > ADVANCED_TABLE_MAX_DEPTH) return { error: "block depth exceeds 8" };
    if (!exactAttributes(element, ["data-omia-callout"])) return { error: "invalid callout attributes" };
    const token = element.getAttribute("data-omia-callout") ?? "";
    if (!CALLOUT_TOKENS.has(token)) return { error: "invalid callout token" };
    const html = canonicalBlockChildren(element, depth + 1);
    return html == null ? { error: "invalid callout content" } : { kind: "callout", html: `<aside data-omia-callout="${token}">${html}</aside>` };
  }
  if (tag === "pre") {
    if (!exactAttributes(element, [])) return { error: "invalid code attributes" };
    const children = elementChildrenOnly(element);
    if (!children || children.length !== 1 || children[0].tagName.toLowerCase() !== "code") return { error: "invalid code content" };
    const code = children[0];
    if (!exactAttributes(code, ["data-language"])) return { error: "invalid code metadata" };
    const language = code.getAttribute("data-language");
    if (language && !SAFE_LANGUAGE.test(language)) return { error: "invalid code language" };
    const attr = language ? ` data-language="${escapeAttr(language)}"` : "";
    return { kind: "code", html: `<pre><code${attr}>${escapeText(code.textContent ?? "")}</code></pre>` };
  }
  if (tag === "figure") {
    if (!exactAttributes(element, ["data-omia-image", "data-omia-ratio"]) || element.getAttribute("data-omia-image") !== "1") return { error: "invalid image block" };
    const ratioRaw = element.getAttribute("data-omia-ratio");
    const ratio = ratioRaw == null ? null : Number(ratioRaw);
    if (ratioRaw != null && (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(ratioRaw)
      || !Number.isFinite(ratio) || ratio! <= 0 || ratio! > 100 || String(ratio) !== ratioRaw)) return { error: "invalid image ratio" };
    const children = elementChildrenOnly(element);
    if (!children || children.length !== 1 || children[0].tagName.toLowerCase() !== "img") return { error: "invalid image content" };
    const image = children[0];
    if (!exactAttributes(image, ["src", "alt", "title"]) || !image.hasAttribute("src")) return { error: "invalid image attributes" };
    const src = image.getAttribute("src") ?? "";
    if (!safeUrl(src, true)) return { error: "unsafe image source" };
    const alt = image.hasAttribute("alt") ? ` alt="${escapeAttr(image.getAttribute("alt") ?? "")}"` : "";
    const title = image.hasAttribute("title") ? ` title="${escapeAttr(image.getAttribute("title") ?? "")}"` : "";
    const ratioAttr = ratioRaw == null ? "" : ` data-omia-ratio="${ratioRaw}"`;
    return { kind: "image", html: `<figure data-omia-image="1"${ratioAttr}><img src="${escapeAttr(src)}"${alt}${title}></figure>` };
  }
  if (tag === "a" && element.hasAttribute("data-omia-rich-link")) {
    if (!exactAttributes(element, ["data-omia-rich-link", "href", "title"]) || !element.hasAttribute("href")) return { error: "invalid rich link attributes" };
    const kind = element.getAttribute("data-omia-rich-link") ?? "";
    const href = element.getAttribute("href") ?? "";
    if (!RICH_LINK_KINDS.has(kind) || !safeUrl(href)) return { error: "invalid rich link" };
    const inside = canonicalInline(element.childNodes);
    if (inside == null) return { error: "invalid rich link label" };
    const title = element.hasAttribute("title") ? ` title="${escapeAttr(element.getAttribute("title") ?? "")}"` : "";
    return { kind: "rich-link", html: `<a data-omia-rich-link="${kind}" href="${escapeAttr(href)}"${title}>${inside}</a>` };
  }
  if (tag === "div" && element.getAttribute("data-omia-math") === "block") {
    if (!exactAttributes(element, ["data-omia-math"]) || element.children.length > 0) return { error: "invalid math block" };
    return { kind: "math-block", html: `<div data-omia-math="block">${escapeText(element.textContent ?? "")}</div>` };
  }
  return { error: `unsupported block ${tag}` };
}

/** Shared strict block allowlist for other controlled containers. It returns
 * canonical HTML and never accepts arbitrary attributes, CSS or executable
 * elements. H1/layout/table remain intentionally outside this helper. */
export function parseControlledContainerBlockElement(element: Element): AdvancedTableBlock | null {
  const block = canonicalBlock(element);
  return "error" in block ? null : block;
}

function parsePositiveInteger(element: Element, name: string, fallback = 1): number | null {
  if (!element.hasAttribute(name)) return fallback;
  const raw = element.getAttribute(name) ?? "";
  return INTEGER.test(raw) ? Number(raw) : null;
}

function parseCell(element: Element): AdvancedTableCell | null {
  if (!exactAttributes(element, ["colspan", "rowspan", "data-omia-cell-bg"])) return null;
  const colspan = parsePositiveInteger(element, "colspan");
  const rowspan = parsePositiveInteger(element, "rowspan");
  if (!colspan || !rowspan || colspan > 100 || rowspan > 100) return null;
  const background = element.getAttribute("data-omia-cell-bg") ?? undefined;
  if (background !== undefined && !isControlledColorToken(background)) return null;
  const children = elementChildrenOnly(element);
  if (!children?.length) return null;
  const blocks: AdvancedTableBlock[] = [];
  for (const child of children) {
    const block = canonicalBlock(child);
    if ("error" in block) return null;
    blocks.push(block);
  }
  return { colspan, rowspan, ...(background ? { background } : {}), blocks };
}

function parseRows(section: Element, expectedCellTag: "th" | "td"): AdvancedTableRow[] | null {
  if (!exactAttributes(section, [])) return null;
  const rows = elementChildrenOnly(section);
  if (!rows?.length || rows.some((row) => row.tagName.toLowerCase() !== "tr" || !exactAttributes(row, []))) return null;
  const parsed: AdvancedTableRow[] = [];
  for (const row of rows) {
    const cells = elementChildrenOnly(row);
    if (!cells?.length || cells.some((cell) => cell.tagName.toLowerCase() !== expectedCellTag)) return null;
    const parsedCells = cells.map(parseCell);
    if (parsedCells.some((cell) => !cell)) return null;
    parsed.push({ cells: parsedCells as AdvancedTableCell[] });
  }
  return parsed;
}

function sectionIsRectangular(rows: readonly AdvancedTableRow[], width: number): boolean {
  const occupied = Array.from({ length: rows.length }, () => Array<boolean>(width).fill(false));
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    let column = 0;
    for (const cell of rows[rowIndex].cells) {
      while (column < width && occupied[rowIndex][column]) column++;
      if (column >= width || column + cell.colspan > width || rowIndex + cell.rowspan > rows.length) return false;
      for (let y = rowIndex; y < rowIndex + cell.rowspan; y++) {
        for (let x = column; x < column + cell.colspan; x++) {
          if (occupied[y][x]) return false;
          occupied[y][x] = true;
        }
      }
      column += cell.colspan;
    }
  }
  return occupied.every((row) => row.every(Boolean));
}

function parseModelFromTable(table: HTMLTableElement): AdvancedTableModel | null {
  if (!exactAttributes(table, ["data-omia-table"]) || table.getAttribute("data-omia-table") !== "1") return null;
  const children = elementChildrenOnly(table);
  if (!children || children.length !== 3 || children.map((child) => child.tagName.toLowerCase()).join(",") !== "colgroup,thead,tbody") return null;
  const [colgroup, thead, tbody] = children;
  if (!exactAttributes(colgroup, [])) return null;
  const cols = elementChildrenOnly(colgroup);
  if (!cols?.length || cols.length > 100 || cols.some((col) => col.tagName.toLowerCase() !== "col" || !exactAttributes(col, ["data-omia-width"]))) return null;
  const widths = cols.map((col) => {
    const raw = col.getAttribute("data-omia-width") ?? "";
    return INTEGER.test(raw) ? Number(raw) : 0;
  });
  if (widths.some((width) => width <= 0 || width > 10000) || widths.reduce((sum, width) => sum + width, 0) !== 10000) return null;
  const head = parseRows(thead, "th");
  const body = parseRows(tbody, "td");
  if (!head || !body || !sectionIsRectangular(head, widths.length) || !sectionIsRectangular(body, widths.length)) return null;
  return { version: ADVANCED_TABLE_VERSION, widths, head, body };
}

function wellFormedAdvancedTableSource(source: string): boolean {
  const allowed = new Set([
    "table", "colgroup", "col", "thead", "tbody", "tr", "th", "td",
    "p", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "blockquote", "aside",
    "pre", "code", "figure", "img", "a", "div", "strong", "b", "em", "i", "s", "del", "br", "u", "span",
  ]);
  const voidTags = new Set(["col", "img", "br"]);
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
    } else if (selfClosing && name === "col") {
      // Canonical output uses HTML void syntax; accept browser clipboard's `<col/>` too.
    }
    previous = tagPattern.lastIndex;
  }
  return stack.length === 0
    && !/[<>]/.test(source.slice(previous))
    && /^\s*<table\b/i.test(source)
    && /<\/table>\s*$/i.test(source);
}

export function parseAdvancedTableHtml(source: string): AdvancedTableParseResult {
  try {
    if (!wellFormedAdvancedTableSource(source)) return { ok: false, error: "malformed advanced table source", source };
    const template = document.createElement("template");
    template.innerHTML = source.trim();
    const children = Array.from(template.content.childNodes).filter((node) => node.nodeType !== Node.TEXT_NODE || node.textContent?.trim());
    if (children.length !== 1 || !(children[0] instanceof HTMLTableElement)) return { ok: false, error: "expected one table", source };
    const model = parseModelFromTable(children[0]);
    return model ? { ok: true, model } : { ok: false, error: "invalid advanced table", source };
  } catch {
    return { ok: false, error: "advanced table parse failed", source };
  }
}

function serializeCell(cell: AdvancedTableCell, tag: "th" | "td"): string {
  const colspan = cell.colspan === 1 ? "" : ` colspan="${cell.colspan}"`;
  const rowspan = cell.rowspan === 1 ? "" : ` rowspan="${cell.rowspan}"`;
  const background = cell.background ? ` data-omia-cell-bg="${cell.background}"` : "";
  return `<${tag}${colspan}${rowspan}${background}>${cell.blocks.map((block) => block.html).join("")}</${tag}>`;
}

export function serializeAdvancedTableHtml(model: AdvancedTableModel): string {
  if (!validateAdvancedTableModel(model)) throw new Error("Cannot serialize invalid advanced table model");
  const cols = model.widths.map((width) => `    <col data-omia-width="${width}">`).join("\n");
  const head = model.head.map((row) => `    <tr>${row.cells.map((cell) => serializeCell(cell, "th")).join("")}</tr>`).join("\n");
  const body = model.body.map((row) => `    <tr>${row.cells.map((cell) => serializeCell(cell, "td")).join("")}</tr>`).join("\n");
  return `<table data-omia-table="1">\n  <colgroup>\n${cols}\n  </colgroup>\n  <thead>\n${head}\n  </thead>\n  <tbody>\n${body}\n  </tbody>\n</table>`;
}

export function validateAdvancedTableModel(value: unknown): value is AdvancedTableModel {
  if (!value || typeof value !== "object") return false;
  const model = value as AdvancedTableModel;
  if (model.version !== ADVANCED_TABLE_VERSION || !Array.isArray(model.widths) || !Array.isArray(model.head) || !Array.isArray(model.body)) return false;
  if (!model.widths.length || model.widths.length > 100 || model.widths.some((width) => !Number.isInteger(width) || width <= 0)
    || model.widths.reduce((sum, width) => sum + width, 0) !== 10000) return false;
  const validRows = (rows: AdvancedTableRow[]) => rows.length > 0 && rows.every((row) => row && Array.isArray(row.cells) && row.cells.length > 0 && row.cells.every((cell) => {
    if (!cell || !Number.isInteger(cell.colspan) || !Number.isInteger(cell.rowspan) || cell.colspan < 1 || cell.rowspan < 1) return false;
    if (cell.background !== undefined && !isControlledColorToken(cell.background)) return false;
    if (!Array.isArray(cell.blocks) || cell.blocks.length === 0) return false;
    return cell.blocks.every((block) => {
      if (!block || typeof block.html !== "string") return false;
      const template = document.createElement("template");
      template.innerHTML = block.html;
      const children = Array.from(template.content.children);
      if (children.length !== 1) return false;
      const canonical = canonicalBlock(children[0]);
      return !("error" in canonical) && canonical.kind === block.kind && canonical.html === block.html;
    });
  }));
  return validRows(model.head) && validRows(model.body)
    && sectionIsRectangular(model.head, model.widths.length)
    && sectionIsRectangular(model.body, model.widths.length);
}

type TableRange = { from: number; to: number; source: string };

function advancedTableRanges(source: string): { ok: true; ranges: TableRange[] } | { ok: false } {
  const ranges: TableRange[] = [];
  const opening = /<table\b[^>]*\bdata-omia-table\s*=\s*(?:"[^"]*"|'[^']*')[^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = opening.exec(source))) {
    if (ranges.some((range) => match!.index < range.to)) continue;
    const tag = /<\/?table\b[^>]*>/gi;
    tag.lastIndex = match.index;
    let depth = 0;
    let close = -1;
    let tableTag: RegExpExecArray | null;
    while ((tableTag = tag.exec(source))) {
      depth += /^<\s*\/table/i.test(tableTag[0]) ? -1 : 1;
      if (depth === 0) { close = tag.lastIndex; break; }
    }
    if (close < 0) return { ok: false };
    ranges.push({ from: match.index, to: close, source: source.slice(match.index, close) });
    opening.lastIndex = close;
  }
  return { ok: true, ranges };
}

export function stripValidAdvancedTablesForSafety(source: string):
  | { ok: true; source: string; count: number }
  | { ok: false; source: string } {
  const found = advancedTableRanges(source);
  if (!found.ok) return { ok: false, source };
  for (const range of found.ranges) if (!parseAdvancedTableHtml(range.source).ok) return { ok: false, source };
  let stripped = source;
  for (const range of [...found.ranges].reverse()) stripped = stripped.slice(0, range.from) + stripped.slice(range.to);
  return { ok: true, source: stripped, count: found.ranges.length };
}

function children(node: ProseNode): ProseNode[] {
  const result: ProseNode[] = [];
  node.forEach((child) => result.push(child));
  return result;
}

function equalWidths(count: number): number[] {
  const base = Math.floor(10000 / count);
  return Array.from({ length: count }, (_unused, index) => base + (index < 10000 - base * count ? 1 : 0));
}

function serializeProseInline(node: ProseNode): string | null {
  let output = "";
  node.forEach((child) => {
    if (child.isText) {
      let text = escapeText(child.text ?? "");
      for (const mark of [...child.marks].reverse()) {
        const name = mark.type.name;
        if (name === "strong") text = `<strong>${text}</strong>`;
        else if (name === "emphasis" || name === "em") text = `<em>${text}</em>`;
        else if (name === "strike_through" || name === "strike") text = `<s>${text}</s>`;
        else if (name === "inlineCode" || name === "code_inline") text = `<code>${text}</code>`;
        else if (name === "link" && safeUrl(String(mark.attrs.href ?? ""))) {
          const title = mark.attrs.title ? ` title="${escapeAttr(String(mark.attrs.title))}"` : "";
          text = `<a href="${escapeAttr(String(mark.attrs.href))}"${title}>${text}</a>`;
        } else if (name === "omiaUnderline") text = `<u data-omia-format="underline">${text}</u>`;
        else if ((name === "omiaTextColor" || name === "omiaBackgroundColor") && isControlledColorToken(mark.attrs.token)) {
          const kind = name === "omiaTextColor" ? "text-color" : "background-color";
          text = `${controlledInlineOpeningTag(kind, mark.attrs.token)}${text}${controlledInlineClosingTag(kind)}`;
        } else {
          output = "";
          return;
        }
      }
      output += text;
    } else if (child.type.name === "hardbreak") output += "<br>";
    else output = "";
  });
  return output;
}

function gfmCellToAdvanced(cell: ProseNode): AdvancedTableCell | null {
  if (cell.childCount !== 1 || cell.firstChild?.type.name !== "paragraph") return null;
  const inline = serializeProseInline(cell.firstChild);
  return inline == null ? null : { colspan: 1, rowspan: 1, blocks: [{ kind: "paragraph", html: `<p>${inline}</p>` }] };
}

export function analyzeAdvancedTableUpgrade(state: EditorState, target: AdvancedTableTarget): AdvancedTableUpgradeAnalysis {
  const table = state.doc.nodeAt(target.pos);
  if (!table || table.nodeSize !== target.nodeSize) return { ok: false, reason: "stale-target" };
  if (table.type.name !== "table" || table.childCount < 2) return { ok: false, reason: "not-gfm-table" };
  const rows = children(table);
  const width = rows[0]?.childCount ?? 0;
  if (!width || width > 100 || rows.some((row) => row.childCount !== width)) return { ok: false, reason: "invalid-grid" };
  const converted = rows.map((row) => row.content.content.map(gfmCellToAdvanced));
  if (converted.some((row) => row.some((cell) => !cell))) return { ok: false, reason: "unsupported-content" };
  const model: AdvancedTableModel = {
    version: ADVANCED_TABLE_VERSION,
    widths: equalWidths(width),
    head: [{ cells: converted[0] as AdvancedTableCell[] }],
    body: converted.slice(1).map((cells) => ({ cells: cells as AdvancedTableCell[] })),
  };
  return validateAdvancedTableModel(model) ? { ok: true, model, target } : { ok: false, reason: "invalid-grid" };
}

export function createAdvancedTableUpgradeTransaction(
  state: EditorState,
  target: AdvancedTableTarget,
  confirmed: boolean,
): Transaction | null {
  if (!confirmed) return null;
  const analysis = analyzeAdvancedTableUpgrade(state, target);
  const type = state.schema.nodes[ADVANCED_TABLE_NODE_NAME];
  if (!analysis.ok || !type) return null;
  return state.tr.replaceWith(target.pos, target.pos + target.nodeSize, type.create({ model: analysis.model }));
}

function hasInlineFormatting(html: string): boolean {
  return html.replace(/^<p>|<\/p>$/g, "").replace(/<br>/g, "").includes("<");
}

export function analyzeAdvancedTableDowngrade(model: AdvancedTableModel): AdvancedTableDowngradeAnalysis {
  if (!validateAdvancedTableModel(model)) return { lossless: false, losses: ["complex-blocks"] };
  const losses: AdvancedTableDowngradeLoss[] = [];
  if (new Set(model.widths).size > 1) losses.push("column-widths");
  const cells = [...model.head, ...model.body].flatMap((row) => row.cells);
  if (cells.some((cell) => cell.colspan !== 1 || cell.rowspan !== 1)) losses.push("merged-cells");
  if (cells.some((cell) => cell.background)) losses.push("cell-backgrounds");
  if (model.head.length !== 1 || cells.some((cell) => cell.blocks.length !== 1 || cell.blocks[0].kind !== "paragraph")) losses.push("complex-blocks");
  if (cells.some((cell) => cell.blocks.some((block) => hasInlineFormatting(block.html)))) losses.push("inline-formatting");
  return { lossless: losses.length === 0, losses };
}

function blockPlainText(block: AdvancedTableBlock): string {
  const template = document.createElement("template");
  template.innerHTML = block.html;
  return template.content.textContent ?? "";
}

function advancedCellPlainText(cell: AdvancedTableCell): string {
  return cell.blocks.map(blockPlainText).join("\n");
}

function createGfmCell(state: EditorState, typeName: "table_header" | "table_cell", cell: AdvancedTableCell): ProseNode | null {
  const cellType = state.schema.nodes[typeName];
  const paragraphType = state.schema.nodes.paragraph;
  if (!cellType || !paragraphType) return null;
  const value = advancedCellPlainText(cell);
  const paragraph = paragraphType.create(null, value ? state.schema.text(value) : undefined);
  return cellType.createAndFill({ alignment: null }, paragraph) ?? null;
}

export function createAdvancedTableDowngradeTransaction(
  state: EditorState,
  target: AdvancedTableTarget,
  confirmed: boolean,
): Transaction | null {
  if (!confirmed) return null;
  const node = state.doc.nodeAt(target.pos);
  const tableType = state.schema.nodes.table;
  const headerRowType = state.schema.nodes.table_header_row;
  const rowType = state.schema.nodes.table_row;
  if (!node || node.nodeSize !== target.nodeSize || node.type.name !== ADVANCED_TABLE_NODE_NAME
    || !tableType || !headerRowType || !rowType || !validateAdvancedTableModel(node.attrs.model)) return null;
  const model = node.attrs.model as AdvancedTableModel;
  const hasMergedCells = [...model.head, ...model.body].some((row) => row.cells.some((cell) => cell.colspan !== 1 || cell.rowspan !== 1));
  if (model.head.length !== 1 || hasMergedCells) {
    const paragraphType = state.schema.nodes.paragraph;
    if (!paragraphType) return null;
    const paragraphs = [...model.head, ...model.body].flatMap((row) => row.cells.flatMap((cell) => cell.blocks.map((block) => {
      const value = blockPlainText(block);
      return paragraphType.create(null, value ? state.schema.text(value) : undefined);
    })));
    if (!paragraphs.length) return null;
    return state.tr.replaceWith(target.pos, target.pos + target.nodeSize, Fragment.fromArray(paragraphs));
  }
  const headerCells = model.head[0].cells.map((cell) => createGfmCell(state, "table_header", cell));
  const bodyRows = model.body.map((row) => row.cells.map((cell) => createGfmCell(state, "table_cell", cell)));
  if (headerCells.some((cell) => !cell) || bodyRows.some((row) => row.some((cell) => !cell))) return null;
  const replacement = tableType.create(null, [
    headerRowType.create(null, headerCells as ProseNode[]),
    ...bodyRows.map((cells) => rowType.create(null, cells as ProseNode[])),
  ]);
  return state.tr.replaceWith(target.pos, target.pos + target.nodeSize, replacement);
}

export function advancedTableCellBackgroundCss(token: ControlledColorToken | undefined): string | undefined {
  return token ? CONTROLLED_COLOR_TOKENS[token].background : undefined;
}
