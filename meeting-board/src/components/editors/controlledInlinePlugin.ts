import type { Processor } from "unified";
import { $markSchema, $remark } from "@milkdown/kit/utils";
import type { Root } from "mdast";
import {
  CONTROLLED_COLOR_TOKENS,
  controlledInlineClosingTag,
  controlledInlineOpeningTag,
  isControlledColorToken,
  parseControlledInlineCloseTag,
  parseControlledInlineOpenTag,
  type ControlledColorToken,
  type ControlledInlineKind,
  type ControlledInlineOpenTag,
} from "../../lib/controlledInlineFormat";

export const CONTROLLED_INLINE_MARK_NAMES = {
  underline: "omiaUnderline",
  textColor: "omiaTextColor",
  backgroundColor: "omiaBackgroundColor",
} as const;

type MdNode = {
  type: string;
  value?: string;
  children?: MdNode[];
  token?: ControlledColorToken;
  [key: string]: unknown;
};

type ControlledMdNode = MdNode & {
  children: MdNode[];
  token?: ControlledColorToken;
};

type MarkdownState = {
  enter: (name: string) => () => void;
  containerPhrasing: (node: ControlledMdNode, info: Record<string, unknown>) => string;
};

function astType(opening: ControlledInlineOpenTag): string {
  if (opening.kind === "underline") return CONTROLLED_INLINE_MARK_NAMES.underline;
  return opening.kind === "text-color"
    ? CONTROLLED_INLINE_MARK_NAMES.textColor
    : CONTROLLED_INLINE_MARK_NAMES.backgroundColor;
}

function foldControlledChildren(children: MdNode[]): MdNode[] {
  const original = children.map((child) => ({ ...child, children: child.children ? foldControlledChildren(child.children) : undefined }));
  const output: MdNode[] = [];
  const stack: Array<{ opening: ControlledInlineOpenTag; children: MdNode[] }> = [];
  const target = () => stack[stack.length - 1]?.children ?? output;

  for (const child of original) {
    if (child.type !== "html" || typeof child.value !== "string") {
      target().push(child);
      continue;
    }
    const closing = parseControlledInlineCloseTag(child.value);
    if (closing) {
      const frame = stack[stack.length - 1];
      if (!frame || frame.opening.tag !== closing) return original;
      stack.pop();
      target().push({
        type: astType(frame.opening),
        children: frame.children,
        ...(frame.opening.token ? { token: frame.opening.token } : {}),
      });
      continue;
    }
    const opening = parseControlledInlineOpenTag(child.value);
    if (!opening) {
      target().push(child);
      continue;
    }
    stack.push({ opening, children: [] });
  }
  return stack.length === 0 ? output : original;
}

export function transformControlledInlineAst(tree: MdNode): MdNode {
  if (tree.children) tree.children = foldControlledChildren(tree.children);
  return tree;
}

function controlledHandler(kind: ControlledInlineKind) {
  return (node: ControlledMdNode, _parent: unknown, state: MarkdownState, info: Record<string, unknown>): string => {
    const token = isControlledColorToken(node.token) ? node.token : undefined;
    const opening = controlledInlineOpeningTag(kind, token);
    const closing = controlledInlineClosingTag(kind);
    const exit = state.enter(kind);
    const value = opening + state.containerPhrasing(node, { ...info, before: opening, after: closing }) + closing;
    exit();
    return value;
  };
}

const controlledInlineRemark = $remark("omiaControlledInlineRemark", () => function controlledInlineRemark(this: Processor) {
  const data = this.data() as Record<string, unknown>;
  const extensions = (data.toMarkdownExtensions as unknown[] | undefined) ?? [];
  data.toMarkdownExtensions = [
    ...extensions,
    {
      handlers: {
        [CONTROLLED_INLINE_MARK_NAMES.underline]: controlledHandler("underline"),
        [CONTROLLED_INLINE_MARK_NAMES.textColor]: controlledHandler("text-color"),
        [CONTROLLED_INLINE_MARK_NAMES.backgroundColor]: controlledHandler("background-color"),
      },
    },
  ];
  return (tree: Root) => transformControlledInlineAst(tree as MdNode) as Root;
});

function openingFromElement(element: HTMLElement): string {
  const attrs = Array.from(element.attributes)
    .map(({ name, value }) => `${name}="${value.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"`)
    .join(" ");
  return `<${element.tagName.toLowerCase()}${attrs ? ` ${attrs}` : ""}>`;
}

function hexToBrowserRgb(hex: string): string {
  const value = hex.slice(1);
  return `rgb(${Number.parseInt(value.slice(0, 2), 16)}, ${Number.parseInt(value.slice(2, 4), 16)}, ${Number.parseInt(value.slice(4, 6), 16)})`;
}

/** Browser clipboard HTML normalizes approved hex colors to rgb(). Keep the
 * source parser exact, but accept that one deterministic DOM representation. */
function controlledColorAttrsFromElement(
  element: HTMLElement,
  kind: "text-color" | "background-color",
): { token: ControlledColorToken } | false {
  const strict = parseControlledInlineOpenTag(openingFromElement(element));
  if (strict?.kind === kind && strict.token) return { token: strict.token };
  const marker = kind === "text-color" ? "data-omia-text-color" : "data-omia-background-color";
  const property = kind === "text-color" ? "color" : "background-color";
  if (element.attributes.length !== 2 || !element.hasAttribute(marker) || !element.hasAttribute("style")) return false;
  const token = element.getAttribute(marker)?.toLowerCase();
  if (!isControlledColorToken(token) || element.style.length !== 1 || element.style.item(0) !== property
    || element.style.getPropertyPriority(property)) return false;
  const expected = kind === "text-color"
    ? CONTROLLED_COLOR_TOKENS[token].text
    : CONTROLLED_COLOR_TOKENS[token].background;
  const actual = element.style.getPropertyValue(property).trim().toLowerCase();
  return actual === expected || actual === hexToBrowserRgb(expected) ? { token } : false;
}

export const controlledUnderlineSchema = $markSchema(CONTROLLED_INLINE_MARK_NAMES.underline, () => ({
  priority: 10,
  parseDOM: [{
    tag: "u[data-omia-format]",
    getAttrs: (element) => element instanceof HTMLElement
      && parseControlledInlineOpenTag(openingFromElement(element))?.kind === "underline" ? null : false,
  }],
  toDOM: () => ["u", { "data-omia-format": "underline" }, 0],
  parseMarkdown: {
    match: (node) => node.type === CONTROLLED_INLINE_MARK_NAMES.underline,
    runner: (state, node, markType) => {
      state.openMark(markType);
      state.next(node.children);
      state.closeMark(markType);
    },
  },
  toMarkdown: {
    match: (mark) => mark.type.name === CONTROLLED_INLINE_MARK_NAMES.underline,
    runner: (state, mark) => { state.withMark(mark, CONTROLLED_INLINE_MARK_NAMES.underline); },
  },
}));

export const controlledTextColorSchema = $markSchema(CONTROLLED_INLINE_MARK_NAMES.textColor, () => ({
  priority: 20,
  attrs: { token: { validate: (value: unknown) => isControlledColorToken(value) } },
  parseDOM: [{
    tag: "span[data-omia-text-color]",
    getAttrs: (element) => {
      if (!(element instanceof HTMLElement)) return false;
      return controlledColorAttrsFromElement(element, "text-color");
    },
  }],
  toDOM: (mark) => {
    const token = mark.attrs.token as ControlledColorToken;
    return ["span", {
      "data-omia-text-color": token,
      style: `color:${CONTROLLED_COLOR_TOKENS[token].text}`,
    }, 0];
  },
  parseMarkdown: {
    match: (node) => node.type === CONTROLLED_INLINE_MARK_NAMES.textColor && isControlledColorToken(node.token),
    runner: (state, node, markType) => {
      state.openMark(markType, { token: node.token });
      state.next(node.children);
      state.closeMark(markType);
    },
  },
  toMarkdown: {
    match: (mark) => mark.type.name === CONTROLLED_INLINE_MARK_NAMES.textColor,
    runner: (state, mark) => {
      state.withMark(mark, CONTROLLED_INLINE_MARK_NAMES.textColor, undefined, { token: mark.attrs.token });
    },
  },
}));

export const controlledBackgroundColorSchema = $markSchema(CONTROLLED_INLINE_MARK_NAMES.backgroundColor, () => ({
  priority: 30,
  attrs: { token: { validate: (value: unknown) => isControlledColorToken(value) } },
  parseDOM: [{
    tag: "span[data-omia-background-color]",
    getAttrs: (element) => {
      if (!(element instanceof HTMLElement)) return false;
      return controlledColorAttrsFromElement(element, "background-color");
    },
  }],
  toDOM: (mark) => {
    const token = mark.attrs.token as ControlledColorToken;
    return ["span", {
      "data-omia-background-color": token,
      style: `background-color:${CONTROLLED_COLOR_TOKENS[token].background}`,
    }, 0];
  },
  parseMarkdown: {
    match: (node) => node.type === CONTROLLED_INLINE_MARK_NAMES.backgroundColor && isControlledColorToken(node.token),
    runner: (state, node, markType) => {
      state.openMark(markType, { token: node.token });
      state.next(node.children);
      state.closeMark(markType);
    },
  },
  toMarkdown: {
    match: (mark) => mark.type.name === CONTROLLED_INLINE_MARK_NAMES.backgroundColor,
    runner: (state, mark) => {
      state.withMark(mark, CONTROLLED_INLINE_MARK_NAMES.backgroundColor, undefined, { token: mark.attrs.token });
    },
  },
}));

export const controlledInlinePlugins = [
  ...controlledInlineRemark,
  ...controlledUnderlineSchema,
  ...controlledTextColorSchema,
  ...controlledBackgroundColorSchema,
];
