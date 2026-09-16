import { Plugin } from "@milkdown/kit/prose/state";
import { $prose } from "@milkdown/kit/utils";
import {
  CONTROLLED_COLOR_TOKENS,
  isControlledColorToken,
  parseControlledInlineOpenTag,
} from "../../lib/controlledInlineFormat";
import {
  parseAdvancedTableHtml,
  parseControlledContainerBlockElement,
} from "./advancedTableModel";
import { parsePersistentLayoutHtml } from "./layoutModel";

const DANGEROUS_TAGS = new Set([
  "script", "style", "iframe", "object", "embed", "link", "meta", "base",
  "svg", "math", "canvas", "template", "noscript", "audio", "video", "source",
]);
const SAFE_SEMANTIC_TAGS = new Set([
  "p", "h1", "h2", "h3", "h4", "h5", "h6", "strong", "b", "em", "i", "s", "del",
  "u", "code", "pre", "blockquote", "ul", "ol", "li", "br", "hr", "table", "thead",
  "tbody", "tr", "th", "td",
]);

export type ClipboardHtmlSanitizeResult = Readonly<{
  html: string;
  degraded: boolean;
  canonicalizedColorCount: number;
}>;

function openingTag(element: HTMLElement): string {
  const attributes = Array.from(element.attributes)
    .map(({ name, value }) => `${name}="${value.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"`)
    .join(" ");
  return `<${element.tagName.toLowerCase()}${attributes ? ` ${attributes}` : ""}>`;
}

function browserColorForms(hex: string): Set<string> {
  const compact = hex.toLowerCase();
  const red = Number.parseInt(compact.slice(1, 3), 16);
  const green = Number.parseInt(compact.slice(3, 5), 16);
  const blue = Number.parseInt(compact.slice(5, 7), 16);
  return new Set([
    compact,
    `rgb(${red},${green},${blue})`,
    `rgba(${red},${green},${blue},1)`,
  ]);
}

function normalizeCssValue(value: string): string {
  return value.toLowerCase().replace(/\s+/g, "");
}

function tokenForExternalColor(
  value: string,
  kind: "text-color" | "background-color",
): keyof typeof CONTROLLED_COLOR_TOKENS | null {
  const normalized = normalizeCssValue(value);
  for (const [token, colors] of Object.entries(CONTROLLED_COLOR_TOKENS)) {
    const canonical = kind === "text-color" ? colors.text : colors.background;
    if (browserColorForms(canonical).has(normalized)) return token as keyof typeof CONTROLLED_COLOR_TOKENS;
  }
  return null;
}

function canonicalColorSpan(
  document: Document,
  kind: "text-color" | "background-color",
  token: keyof typeof CONTROLLED_COLOR_TOKENS,
): HTMLSpanElement {
  const span = document.createElement("span");
  if (kind === "text-color") {
    span.dataset.omiaTextColor = token;
    span.style.color = CONTROLLED_COLOR_TOKENS[token].text;
  } else {
    span.dataset.omiaBackgroundColor = token;
    span.style.backgroundColor = CONTROLLED_COLOR_TOKENS[token].background;
  }
  return span;
}

/** Clipboard DOM is serialized by the browser, which may normalize the exact
 * canonical hex color to rgb(). Accept only that equivalent representation;
 * the persisted Markdown parser remains hex-only and fail-closed. */
function isControlledInlineClipboardElement(element: HTMLElement): boolean {
  if (element.tagName === "U") return parseControlledInlineOpenTag(openingTag(element)) != null;
  if (element.tagName !== "SPAN" || element.attributes.length !== 2 || element.style.length !== 1) return false;

  const textToken = element.getAttribute("data-omia-text-color")?.toLowerCase();
  if (isControlledColorToken(textToken)
    && element.style.item(0) === "color"
    && element.style.getPropertyPriority("color") === ""
    && browserColorForms(CONTROLLED_COLOR_TOKENS[textToken].text).has(normalizeCssValue(element.style.color))) {
    return true;
  }

  const backgroundToken = element.getAttribute("data-omia-background-color")?.toLowerCase();
  return isControlledColorToken(backgroundToken)
    && element.style.item(0) === "background-color"
    && element.style.getPropertyPriority("background-color") === ""
    && browserColorForms(CONTROLLED_COLOR_TOKENS[backgroundToken].background)
      .has(normalizeCssValue(element.style.backgroundColor));
}

function hasExecutableSurface(root: ParentNode): boolean {
  if (root.querySelector([...DANGEROUS_TAGS].join(","))) return true;
  return Array.from(root.querySelectorAll("*")).some((element) => Array.from(element.attributes).some(({ name, value }) => (
    /^on/i.test(name)
    || name.toLowerCase() === "srcdoc"
    || /^(?:javascript|vbscript):/i.test(value.trim())
  )));
}

function strictControlledOwner(element: HTMLElement): boolean {
  const layout = element.closest<HTMLElement>('div[data-omia-layout="1"]');
  if (layout && parsePersistentLayoutHtml(layout.outerHTML).ok) return true;
  const table = element.closest<HTMLTableElement>('table[data-omia-table="1"]');
  if (table && parseAdvancedTableHtml(table.outerHTML).ok) return true;
  if ((element.tagName === "U" || element.tagName === "SPAN") && isControlledInlineClipboardElement(element)) return true;
  const block = element.closest<HTMLElement>("p,h2,h3,h4,h5,h6,ul,ol,blockquote,aside,pre,figure,a,div");
  return block != null && parseControlledContainerBlockElement(block) != null;
}

/** Same-Omia clipboard HTML may retain only strict file-model attributes. View
 * state (selection, drag handles, geometry) and future/invalid model versions
 * are never trusted merely because their attribute starts with data-omia. */
export function isTrustedOmiaClipboardHtml(html: string): boolean {
  const template = document.createElement("template");
  template.innerHTML = html;
  if (hasExecutableSurface(template.content)) return false;
  const all = Array.from(template.content.querySelectorAll<HTMLElement>("*"));
  const owned = all.filter((element) => Array.from(element.attributes).some(({ name }) => name.startsWith("data-omia-")));
  return owned.length > 0 && owned.every(strictControlledOwner);
}

function unwrap(element: Element): void {
  element.replaceWith(...Array.from(element.childNodes));
}

/** Converts arbitrary clipboard HTML to an inert semantic subset. It preserves
 * readable text but removes all attributes and every resource/executable node;
 * pasted image files continue through the separate, already-controlled path. */
export function sanitizeUnknownClipboardHtmlWithReport(html: string): ClipboardHtmlSanitizeResult {
  if (isTrustedOmiaClipboardHtml(html)) return { html, degraded: false, canonicalizedColorCount: 0 };
  const template = document.createElement("template");
  template.innerHTML = html;
  let degraded = false;
  let canonicalizedColorCount = 0;

  template.content.querySelectorAll([...DANGEROUS_TAGS].join(",")).forEach((element) => {
    degraded = true;
    element.remove();
  });
  template.content.querySelectorAll("img").forEach((image) => {
    const alt = image.getAttribute("alt")?.trim();
    degraded = true;
    image.replaceWith(document.createTextNode(alt ?? ""));
  });
  const elements = Array.from(template.content.querySelectorAll("*")).reverse();
  for (const element of elements) {
    const tag = element.tagName.toLowerCase();
    const htmlElement = element as HTMLElement;
    const supportsExternalColor = tag === "span" || tag === "font";
    const textValue = htmlElement.style.color
      || (tag === "font" ? element.getAttribute("color") ?? "" : "");
    const backgroundValue = htmlElement.style.backgroundColor;
    const textToken = supportsExternalColor && textValue
      ? tokenForExternalColor(textValue, "text-color")
      : null;
    const backgroundToken = supportsExternalColor && backgroundValue
      ? tokenForExternalColor(backgroundValue, "background-color")
      : null;
    const hadExternalStyle = element.hasAttribute("style") || (tag === "font" && element.hasAttribute("color"));

    if (textToken || backgroundToken) {
      const children = Array.from(element.childNodes);
      let root: HTMLSpanElement | null = null;
      let leaf: HTMLSpanElement | null = null;
      if (textToken) root = leaf = canonicalColorSpan(template.ownerDocument, "text-color", textToken);
      if (backgroundToken) {
        const background = canonicalColorSpan(template.ownerDocument, "background-color", backgroundToken);
        if (leaf) leaf.append(background);
        else root = background;
        leaf = background;
      }
      leaf?.append(...children);
      element.replaceWith(root!);
      canonicalizedColorCount += Number(Boolean(textToken)) + Number(Boolean(backgroundToken));
      const supportedProperties = new Set(["color", "background-color"]);
      const hasUnknownStyle = Array.from(htmlElement.style).some((property) => !supportedProperties.has(property))
        || Boolean(textValue && !textToken)
        || Boolean(backgroundValue && !backgroundToken)
        || Array.from(element.attributes).some(({ name }) => name !== "style" && !(tag === "font" && name === "color"));
      degraded ||= hasUnknownStyle;
      continue;
    }

    if (!SAFE_SEMANTIC_TAGS.has(tag)) {
      degraded = true;
      unwrap(element);
      continue;
    }
    if (hadExternalStyle || element.attributes.length > 0) degraded = true;
    Array.from(element.attributes).forEach((attribute) => element.removeAttribute(attribute.name));
  }
  return { html: template.innerHTML, degraded, canonicalizedColorCount };
}

export function sanitizeUnknownClipboardHtml(html: string): string {
  return sanitizeUnknownClipboardHtmlWithReport(html).html;
}

export function createSafeClipboardImportPlugin(): Plugin {
  return new Plugin({
    props: {
      transformPastedHTML(html) {
        return sanitizeUnknownClipboardHtml(html);
      },
    },
  });
}

export const safeClipboardImportPlugin = $prose(() => createSafeClipboardImportPlugin());
