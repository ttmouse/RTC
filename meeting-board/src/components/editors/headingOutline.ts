import type { Node as ProseNode } from "@milkdown/kit/prose/model";
import { Selection, type EditorState, type Transaction } from "@milkdown/kit/prose/state";

export type HeadingOutlineEntry = Readonly<{
  id: string;
  level: number;
  text: string;
  pos: number;
}>;

function headingLevel(node: ProseNode): number | null {
  if (node.type.name !== "heading") return null;
  const level = Number(node.attrs.level);
  return Number.isInteger(level) && level >= 1 && level <= 6 ? level : null;
}

/**
 * Derive the outline directly from the current ProseMirror document.
 * The returned data is disposable UI state: it never mutates the document and is never serialized.
 */
export function deriveHeadingOutline(
  document: ProseNode,
  lang: "zh" | "en" = "en",
  options: Readonly<{ excludePageTitle?: boolean }> = {},
): readonly HeadingOutlineEntry[] {
  const entries: HeadingOutlineEntry[] = [];
  let skippedPageTitle = false;
  document.descendants((node, pos) => {
    const level = headingLevel(node);
    if (level == null) return true;
    if (options.excludePageTitle && level === 1 && !skippedPageTitle && node.type.name === "heading") {
      skippedPageTitle = true;
      return false;
    }
    const text = node.textContent.trim() || (lang === "en" ? "Untitled heading" : "未命名标题");
    entries.push({ id: `heading:${pos}`, level, text, pos });
    return false;
  });
  return entries;
}

export function sameHeadingOutline(
  left: readonly HeadingOutlineEntry[],
  right: readonly HeadingOutlineEntry[],
): boolean {
  return left.length === right.length && left.every((entry, index) => {
    const candidate = right[index];
    return candidate != null
      && entry.id === candidate.id
      && entry.level === candidate.level
      && entry.text === candidate.text
      && entry.pos === candidate.pos;
  });
}

/** Move the editor caret for navigation while explicitly keeping the document and undo history untouched. */
export function createHeadingNavigationTransaction(
  state: EditorState,
  pos: number,
): Transaction | null {
  const node = state.doc.nodeAt(pos);
  if (!node || headingLevel(node) == null) return null;
  const inside = Math.max(0, Math.min(pos + 1, state.doc.content.size));
  return state.tr
    .setSelection(Selection.near(state.doc.resolve(inside)))
    .setMeta("addToHistory", false);
}
