import type { EditorState, Transaction } from "@milkdown/kit/prose/state";
import { TextSelection } from "@milkdown/kit/prose/state";

export type InsertedLinkRange = {
  transaction: Transaction;
  from: number;
  to: number;
};

export type LinkDisplayTarget = {
  from: number;
  to: number;
  href: string;
  label: string;
};

export type LinkRange = {
  from: number;
  to: number;
  href: string;
  title: string | null;
  label: string;
};

function guardedLinkMark(state: EditorState, target: Omit<LinkDisplayTarget, "label">) {
  const link = state.schema.marks.link;
  if (!link || target.from < 0 || target.to <= target.from || target.to > state.doc.content.size) return null;
  let covered = false;
  let valid = true;
  state.doc.nodesBetween(target.from, target.to, (node, pos) => {
    if (!node.isText) return;
    const overlapFrom = Math.max(target.from, pos);
    const overlapTo = Math.min(target.to, pos + node.nodeSize);
    if (overlapTo <= overlapFrom) return;
    covered = true;
    const mark = link.isInSet(node.marks);
    if (!mark || mark.attrs.href !== target.href || mark.attrs.title) valid = false;
  });
  return covered && valid ? link.create({ href: target.href, title: null }) : null;
}

/** Builds the single ProseMirror transaction used by an owned URL paste. */
export function insertUrlPaste(state: EditorState, href: string): InsertedLinkRange | null {
  const link = state.schema.marks.link;
  const selection = state.selection;
  if (!link || !(selection instanceof TextSelection)) return null;

  const mark = link.create({ href, title: null });
  if (!selection.empty) {
    return {
      transaction: state.tr.addMark(selection.from, selection.to, mark),
      from: selection.from,
      to: selection.to,
    };
  }

  const from = selection.from;
  const transaction = state.tr.replaceWith(from, from, state.schema.text(href, [mark]));
  return { transaction, from, to: from + href.length };
}

/** Guarded against async results writing into a changed document or a different link. */
export function replaceLinkDisplay(state: EditorState, target: LinkDisplayTarget): Transaction | null {
  const mark = guardedLinkMark(state, target);
  const label = target.label.trim();
  if (!mark || !label || /[\u0000-\u001f\u007f]/.test(label)) return null;
  return state.tr.replaceWith(target.from, target.to, state.schema.text(label, [mark]));
}

/** Reuses the existing `omia:bookmark` Markdown-link marker; no schema is added. */
export function upgradeLinkToBookmark(state: EditorState, target: LinkDisplayTarget): Transaction | null {
  const ordinaryMark = guardedLinkMark(state, target);
  const label = target.label.trim();
  if (!ordinaryMark || !label || /[\u0000-\u001f\u007f]/.test(label)) return null;
  const $from = state.doc.resolve(target.from);
  const $to = state.doc.resolve(target.to);
  if (!$from.sameParent($to) || $from.parent.type.name !== "paragraph") return null;
  if (target.from !== $from.start() || target.to !== $from.end()) return null;
  const paragraphPos = $from.before();
  const paragraph = $from.parent.type.create(
    null,
    state.schema.text(label, [ordinaryMark.type.create({ href: target.href, title: "omia:bookmark" })]),
  );
  return state.tr.replaceWith(paragraphPos, paragraphPos + $from.parent.nodeSize, paragraph);
}

export function linkDomainFallback(href: string): string {
  try {
    return new URL(href).hostname.replace(/^www\./i, "") || href;
  } catch {
    return href;
  }
}

export function safeNavigableHref(raw: string): string | null {
  const href = raw.trim();
  if (!href || /[\u0000-\u001f\u007f]/.test(href)) return null;
  try {
    const parsed = new URL(href);
    if (!parsed.hostname || !["http:", "https:"].includes(parsed.protocol)) return null;
    if (parsed.username || parsed.password) return null;
    return parsed.href;
  } catch {
    return null;
  }
}

export function findLinkRangeAtPos(state: EditorState, pos: number): LinkRange | null {
  const link = state.schema.marks.link;
  if (!link || pos < 0 || pos > state.doc.content.size) return null;
  const $pos = state.doc.resolve(pos);
  if (!$pos.parent.isTextblock) return null;
  const children: Array<{ node: typeof $pos.parent; offset: number }> = [];
  $pos.parent.forEach((node, offset) => children.push({ node: node as typeof $pos.parent, offset }));
  let index = children.findIndex(({ node, offset }) => pos - $pos.start() >= offset && pos - $pos.start() < offset + node.nodeSize);
  if (index < 0 && pos > $pos.start()) {
    index = children.findIndex(({ node, offset }) => pos - $pos.start() === offset + node.nodeSize);
  }
  const hit = children[index];
  const mark = hit?.node.marks.find((candidate) => candidate.type === link);
  if (!hit || !mark || typeof mark.attrs.href !== "string") return null;
  const sameMark = (candidate: (typeof children)[number]) => {
    const current = candidate.node.marks.find((item) => item.type === link);
    return current?.attrs.href === mark.attrs.href && current?.attrs.title === mark.attrs.title;
  };
  let startIndex = index;
  let endIndex = index;
  while (startIndex > 0 && sameMark(children[startIndex - 1])) startIndex -= 1;
  while (endIndex + 1 < children.length && sameMark(children[endIndex + 1])) endIndex += 1;
  const from = $pos.start() + children[startIndex].offset;
  const to = $pos.start() + children[endIndex].offset + children[endIndex].node.nodeSize;
  return {
    from,
    to,
    href: mark.attrs.href,
    title: typeof mark.attrs.title === "string" ? mark.attrs.title : null,
    label: state.doc.textBetween(from, to, ""),
  };
}

export function editLinkHref(
  state: EditorState,
  target: Omit<LinkDisplayTarget, "label">,
  nextHref: string,
): Transaction | null {
  const existing = guardedLinkMark(state, target);
  const href = safeNavigableHref(nextHref);
  if (!existing || !href) return null;
  return state.tr.removeMark(target.from, target.to, existing.type).addMark(
    target.from,
    target.to,
    existing.type.create({ href, title: null }),
  );
}

export function removeLink(
  state: EditorState,
  target: Omit<LinkDisplayTarget, "label">,
): Transaction | null {
  const existing = guardedLinkMark(state, target);
  if (!existing) return null;
  return state.tr.removeMark(target.from, target.to, existing.type);
}

export async function resolveLinkTitle(
  href: string,
  loadTitle: (href: string) => Promise<string>,
): Promise<{ label: string; source: "title" | "fallback" }> {
  const fallback = linkDomainFallback(href);
  try {
    const title = (await loadTitle(href)).replace(/\s+/g, " ").trim().slice(0, 160);
    if (!title || /[\u0000-\u001f\u007f]/.test(title)) return { label: fallback, source: "fallback" };
    return { label: title, source: "title" };
  } catch {
    return { label: fallback, source: "fallback" };
  }
}
