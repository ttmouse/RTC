import { $prose } from "@milkdown/kit/utils";
import { Fragment, Slice, type Node as ProseNode } from "@milkdown/kit/prose/model";
import { Plugin, TextSelection, type EditorState, type Transaction } from "@milkdown/kit/prose/state";
import { Decoration, DecorationSet } from "@milkdown/kit/prose/view";

export type PageTitleBinding = Readonly<{
  pos: number;
  index: number;
  nodeSize: number;
  text: string;
  empty: boolean;
}>;

/**
 * The first top-level H1 is the only page-title truth. This function derives a
 * live position from the ProseMirror document and never caches or persists a
 * second title string.
 */
export function bindVisualTitleToFirstH1(document: ProseNode): PageTitleBinding | null {
  let binding: PageTitleBinding | null = null;
  document.forEach((node, pos, index) => {
    if (binding || node.type.name !== "heading" || Number(node.attrs.level) !== 1) return;
    binding = {
      pos,
      index,
      nodeSize: node.nodeSize,
      text: node.textContent,
      empty: node.textContent.trim().length === 0,
    };
  });
  return binding;
}

export function pageTitleIndex(document: ProseNode): number | null {
  return bindVisualTitleToFirstH1(document)?.index ?? null;
}

export function isPageTitlePosition(document: ProseNode, pos: number): boolean {
  return bindVisualTitleToFirstH1(document)?.pos === pos;
}

/** User activation of the visible placeholder creates a real, visible H1. */
export function createPageTitleTransaction(state: EditorState, text = ""): Transaction | null {
  const existing = bindVisualTitleToFirstH1(state.doc);
  if (existing) {
    const node = state.doc.nodeAt(existing.pos);
    if (!node || node.textContent === text) return null;
    const from = existing.pos + 1;
    const to = existing.pos + node.nodeSize - 1;
    const transaction = state.tr.replaceWith(from, to, text ? state.schema.text(text) : []);
    return transaction
      .setSelection(TextSelection.near(transaction.doc.resolve(Math.min(from + text.length, transaction.doc.content.size))))
      .scrollIntoView();
  }
  const heading = state.schema.nodes.heading;
  if (!heading) return null;
  const title = heading.create({ level: 1 }, text ? state.schema.text(text) : undefined);
  const transaction = state.tr.insert(0, title);
  return transaction
    .setSelection(TextSelection.near(transaction.doc.resolve(Math.min(1 + text.length, transaction.doc.content.size))))
    .scrollIntoView();
}

/** D18: a multi-block paste in the page title keeps the first block inline and moves the rest into the body. */
export function createPageTitlePasteTransaction(state: EditorState, slice: Slice): Transaction | null {
  const binding = bindVisualTitleToFirstH1(state.doc);
  const title = binding ? state.doc.nodeAt(binding.pos) : null;
  if (!binding || !title) return null;
  const { $from, $to } = state.selection;
  if ($from.depth < 1 || $to.depth < 1
    || $from.before(1) !== binding.pos || $to.before(1) !== binding.pos) return null;

  const first = slice.content.firstChild;
  if (!first?.isTextblock) return null;
  const firstLine: ProseNode[] = [];
  const afterFirstLine: ProseNode[] = [];
  let sawHardBreak = false;
  first.forEach((node) => {
    if (!sawHardBreak && (node.type.name === "hardbreak" || node.type.name === "hard_break")) {
      sawHardBreak = true;
      return;
    }
    (sawHardBreak ? afterFirstLine : firstLine).push(node);
  });
  if (slice.content.childCount < 2 && !sawHardBreak) return null;
  if (!firstLine.some((node) => node.isText && Boolean(node.text))) return null;

  const remaining: ProseNode[] = [];
  if (sawHardBreak) {
    const paragraph = state.schema.nodes.paragraph;
    if (!paragraph) return null;
    remaining.push(paragraph.create(null, Fragment.fromArray(afterFirstLine)));
  }
  slice.content.forEach((node, _offset, index) => { if (index > 0) remaining.push(node); });
  if (remaining.length === 0) return null;

  try {
    let transaction = state.tr.replaceWith(
      state.selection.from,
      state.selection.to,
      Fragment.fromArray(firstLine),
    );
    const updatedTitle = transaction.doc.nodeAt(binding.pos);
    if (!updatedTitle) return null;
    const insertAt = binding.pos + updatedTitle.nodeSize;
    transaction = transaction.insert(insertAt, Fragment.fromArray(remaining));
    return transaction
      .setSelection(TextSelection.near(transaction.doc.resolve(Math.min(insertAt + 1, transaction.doc.content.size))))
      .scrollIntoView();
  } catch {
    return null;
  }
}

export type PageTitleBoundaryAction =
  | "none"
  | "clear-page"
  | "enter-body"
  | "keep-title"
  | "focus-title-end"
  | "focus-body-start";

export type PageTitleBoundaryInput = Readonly<{
  key: string;
  selectionCollapsed: boolean;
  selectionCoversDocument: boolean;
  hasCommandModifier: boolean;
  hasBlockSelection: boolean;
  titleIndex: number;
  bodyIndex: number;
  topLevelIndex: number;
  offsetInTextblock: number;
  textblockSize: number;
  bodyIsTextblock: boolean;
}>;

export function resolvePageTitleBoundaryAction(input: PageTitleBoundaryInput): PageTitleBoundaryAction {
  if (input.titleIndex < 0 || input.hasCommandModifier || input.hasBlockSelection) return "none";
  if ((input.key === "Backspace" || input.key === "Delete") && input.selectionCoversDocument) return "clear-page";
  if (!input.selectionCollapsed) return "none";
  if (input.key === "Enter" && input.topLevelIndex === input.titleIndex) return "enter-body";
  if (input.key === "Backspace" && input.topLevelIndex === input.titleIndex && input.offsetInTextblock === 0) return "keep-title";
  if (input.key === "Delete" && input.topLevelIndex === input.titleIndex
    && input.offsetInTextblock === input.textblockSize && input.bodyIsTextblock) return "focus-body-start";
  if (input.key === "Backspace" && input.topLevelIndex === input.bodyIndex
    && input.offsetInTextblock === 0 && input.bodyIsTextblock) return "focus-title-end";
  return "none";
}

export function pageTitleDecorations(state: EditorState): DecorationSet {
  const binding = bindVisualTitleToFirstH1(state.doc);
  if (binding) {
    return DecorationSet.create(state.doc, [Decoration.node(binding.pos, binding.pos + binding.nodeSize, {
      class: "omia-page-title",
      "data-omia-page-title": "1",
      "data-omia-page-title-empty": binding.empty ? "true" : "false",
      role: "heading",
      "aria-level": "1",
      "aria-label": binding.empty
        ? "页面标题：无标题 / Page title: Untitled"
        : `页面标题：${binding.text} / Page title: ${binding.text}`,
    })]);
  }
  return DecorationSet.create(state.doc, [Decoration.widget(0, (view) => {
    const button = view.dom.ownerDocument.createElement("button");
    button.type = "button";
    button.className = "omia-page-title-placeholder";
    button.dataset.omiaPageTitlePlaceholder = "1";
    const en = Boolean(view.dom.closest(".lang-en"));
    button.textContent = en ? "Untitled" : "无标题";
    button.setAttribute("aria-label", en ? "Create page title" : "创建页面标题");
    button.addEventListener("mousedown", (event) => event.preventDefault());
    button.addEventListener("click", () => {
      const transaction = createPageTitleTransaction(view.state);
      if (!transaction) return;
      view.dispatch(transaction);
      view.focus();
    });
    return button;
  }, { key: "omia-page-title-placeholder", side: -1 })]);
}

export function createPageTitlePlugin(): Plugin {
  return new Plugin({
    props: {
      decorations: pageTitleDecorations,
      handlePaste(view, event, slice) {
        if (view.composing || (event.clipboardData?.files.length ?? 0) > 0) return false;
        const transaction = createPageTitlePasteTransaction(view.state, slice);
        if (!transaction) return false;
        view.dispatch(transaction);
        return true;
      },
    },
  });
}

export const pageTitlePlugin = $prose(() => createPageTitlePlugin());
export const pageTitlePlugins = [pageTitlePlugin];
