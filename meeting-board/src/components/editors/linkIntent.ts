export type UrlPasteIntentInput = {
  plainText: string;
  htmlText: string;
  fileCount: number;
  hasFileItems: boolean;
  selectionEmpty: boolean;
};

export type UrlPasteIntent =
  | { kind: "pass-through" }
  | { kind: "blocked-url"; protocol: "javascript" | "vbscript" | "data" | "control" | "credentials" }
  | { kind: "safe-url"; href: string; selection: "caret" | "text" };

const EXECUTABLE_SCHEME_RE = /^\s*(javascript|vbscript|data)\s*:/i;
const CONTROL_CHARACTER_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

/**
 * URL paste is deliberately narrow: only an exact, plain-text HTTP(S) address is
 * owned by Omia. Everything structured stays with Milkdown's clipboard pipeline.
 */
export function classifyUrlPasteIntent(input: UrlPasteIntentInput): UrlPasteIntent {
  if (input.fileCount > 0 || input.hasFileItems || input.htmlText.trim()) return { kind: "pass-through" };

  const raw = input.plainText;
  const executable = raw.match(EXECUTABLE_SCHEME_RE)?.[1]?.toLocaleLowerCase();
  if (executable === "javascript" || executable === "vbscript" || executable === "data") {
    return { kind: "blocked-url", protocol: executable };
  }
  if (CONTROL_CHARACTER_RE.test(raw)) return { kind: "blocked-url", protocol: "control" };

  const href = raw.trim();
  if (!/^https?:\/\//i.test(href) || /\s/.test(href)) return { kind: "pass-through" };
  try {
    const parsed = new URL(href);
    if (!parsed.hostname || !["http:", "https:"].includes(parsed.protocol)) return { kind: "pass-through" };
    if (parsed.username || parsed.password) return { kind: "blocked-url", protocol: "credentials" };
    return {
      kind: "safe-url",
      href: parsed.href,
      selection: input.selectionEmpty ? "caret" : "text",
    };
  } catch {
    return { kind: "pass-through" };
  }
}
