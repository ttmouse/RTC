export const CONTROLLED_COLOR_TOKENS = {
  gray: { text: "#646a73", background: "#eff0f1" },
  red: { text: "#d83931", background: "#fde2e2" },
  orange: { text: "#d46b08", background: "#feead2" },
  yellow: { text: "#8f6b00", background: "#fff1b8" },
  green: { text: "#2b7a4b", background: "#d9f5e5" },
  blue: { text: "#245bdb", background: "#dbeafe" },
  purple: { text: "#7e45b8", background: "#eee2ff" },
  "soft-gray": { text: "#646a73", background: "#f5f6f7" },
  "medium-gray": { text: "#4e5969", background: "#dfe1e4" },
  pink: { text: "#c23a77", background: "#fbd6e8" },
  peach: { text: "#b75d0a", background: "#fde0c2" },
  lemon: { text: "#8f6b00", background: "#fff59d" },
  mint: { text: "#237b4b", background: "#ccebd7" },
  sky: { text: "#2b5fd9", background: "#cddcff" },
  lavender: { text: "#7547a8", background: "#ddccf5" },
} as const;

export type ControlledColorToken = keyof typeof CONTROLLED_COLOR_TOKENS;
export type ControlledInlineKind = "underline" | "text-color" | "background-color";

export type ControlledInlineOpenTag = {
  kind: ControlledInlineKind;
  tag: "u" | "span";
  token?: ControlledColorToken;
};

const TOKEN_SET = new Set<string>(Object.keys(CONTROLLED_COLOR_TOKENS));
const KIND_RANK: Record<ControlledInlineKind, number> = {
  underline: 0,
  "text-color": 1,
  "background-color": 2,
};

function normalizeCssValue(value: string): string {
  return value.toLowerCase().replace(/\s+/g, "");
}

function parseAttributes(source: string): Map<string, string> | null {
  const attrs = new Map<string, string>();
  let rest = source.trim();
  while (rest) {
    const match = rest.match(/^([A-Za-z_:][A-Za-z0-9_.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/);
    if (!match) return null;
    const name = match[1]!.toLowerCase();
    if (attrs.has(name)) return null;
    attrs.set(name, match[2] ?? match[3] ?? "");
    rest = rest.slice(match[0].length).trimStart();
  }
  return attrs;
}

function exactAttrs(attrs: Map<string, string>, expected: Record<string, string>): boolean {
  const entries = Object.entries(expected);
  return attrs.size === entries.length
    && entries.every(([name, value]) => attrs.get(name)?.toLowerCase() === value.toLowerCase());
}

export function isControlledColorToken(value: unknown): value is ControlledColorToken {
  return typeof value === "string" && TOKEN_SET.has(value);
}

/** Parse one opening tag. Any unknown attribute, token or CSS declaration fails closed. */
export function parseControlledInlineOpenTag(source: string): ControlledInlineOpenTag | null {
  const match = source.match(/^<\s*([A-Za-z][A-Za-z0-9-]*)\s*([^<>]*?)\s*>$/);
  if (!match || /\/\s*>$/.test(source)) return null;
  const tag = match[1]!.toLowerCase();
  const attrs = parseAttributes(match[2] ?? "");
  if (!attrs) return null;

  if (tag === "u" && exactAttrs(attrs, { "data-omia-format": "underline" })) {
    return { kind: "underline", tag: "u" };
  }
  if (tag !== "span") return null;

  const textToken = attrs.get("data-omia-text-color")?.toLowerCase();
  if (isControlledColorToken(textToken)) {
    const canonical = CONTROLLED_COLOR_TOKENS[textToken].text;
    if (attrs.size === 2
      && normalizeCssValue(attrs.get("style") ?? "") === `color:${canonical}`) {
      return { kind: "text-color", tag: "span", token: textToken };
    }
  }

  const backgroundToken = attrs.get("data-omia-background-color")?.toLowerCase();
  if (isControlledColorToken(backgroundToken)) {
    const canonical = CONTROLLED_COLOR_TOKENS[backgroundToken].background;
    if (attrs.size === 2
      && normalizeCssValue(attrs.get("style") ?? "") === `background-color:${canonical}`) {
      return { kind: "background-color", tag: "span", token: backgroundToken };
    }
  }
  return null;
}

export function parseControlledInlineCloseTag(source: string): "u" | "span" | null {
  const match = source.match(/^<\s*\/\s*(u|span)\s*>$/i);
  return match ? match[1]!.toLowerCase() as "u" | "span" : null;
}

export function controlledInlineOpeningTag(kind: ControlledInlineKind, token?: ControlledColorToken): string {
  if (kind === "underline") return '<u data-omia-format="underline">';
  if (!token) throw new Error(`${kind} requires a controlled color token`);
  const values = CONTROLLED_COLOR_TOKENS[token];
  return kind === "text-color"
    ? `<span data-omia-text-color="${token}" style="color:${values.text}">`
    : `<span data-omia-background-color="${token}" style="background-color:${values.background}">`;
}

export function controlledInlineClosingTag(kind: ControlledInlineKind): string {
  return kind === "underline" ? "</u>" : "</span>";
}

export type ControlledInlineHtmlSafety = {
  hasHtml: boolean;
  controlled: boolean;
};

/**
 * Classifies HTML outside fenced code after the caller removes the one existing
 * portable image-ratio comment. Controlled marks must be balanced, cannot span
 * paragraphs, and must use the frozen underline → text → background nesting.
 */
export function classifyControlledInlineHtml(source: string): ControlledInlineHtmlSafety {
  const tagPattern = /<!--[\s\S]*?-->|<\/?[A-Za-z][^<>]*>/g;
  const stack: ControlledInlineOpenTag[] = [];
  let hasHtml = false;
  let previousEnd = 0;
  let match: RegExpExecArray | null;
  while ((match = tagPattern.exec(source))) {
    hasHtml = true;
    if (stack.length > 0 && /\n\s*\n/.test(source.slice(previousEnd, match.index))) {
      return { hasHtml, controlled: false };
    }
    const raw = match[0];
    if (raw.startsWith("<!--")) return { hasHtml, controlled: false };
    const closing = parseControlledInlineCloseTag(raw);
    if (closing) {
      const top = stack[stack.length - 1];
      if (!top || top.tag !== closing) return { hasHtml, controlled: false };
      stack.pop();
      previousEnd = tagPattern.lastIndex;
      continue;
    }
    const opening = parseControlledInlineOpenTag(raw);
    if (!opening) return { hasHtml, controlled: false };
    const parent = stack[stack.length - 1];
    if (parent && KIND_RANK[opening.kind] <= KIND_RANK[parent.kind]) {
      return { hasHtml, controlled: false };
    }
    stack.push(opening);
    previousEnd = tagPattern.lastIndex;
  }
  return { hasHtml, controlled: stack.length === 0 };
}
