import type { EditorState, Transaction } from "@milkdown/kit/prose/state";
import { CONTROLLED_ALIGNED_PARAGRAPH_NAME } from "./controlledBlockPlugin";
import type { SelectionAlignment, SelectionAlignmentAction, SelectionAlignmentState } from "./selectionToolbarShell";

type SelectedBlock = { pos: number; name: string; align: SelectionAlignment };

function selectedBlocks(state: EditorState): SelectedBlock[] {
  const { from, to } = state.selection;
  const blocks: SelectedBlock[] = [];
  state.doc.forEach((node, pos) => {
    const contentFrom = pos + 1;
    const contentTo = pos + node.nodeSize - 1;
    if (to < contentFrom || from > contentTo) return;
    if (node.type.name === "paragraph") blocks.push({ pos, name: "paragraph", align: "left" });
    else if (node.type.name === CONTROLLED_ALIGNED_PARAGRAPH_NAME) {
      blocks.push({ pos, name: node.type.name, align: node.attrs.align === "right" ? "right" : "center" });
    } else blocks.push({ pos, name: node.type.name, align: "left" });
  });
  return blocks;
}

export function controlledBlockAlignmentState(state: EditorState): SelectionAlignmentState {
  if (state.selection.empty) return { current: "left", enabled: false, canIndent: false, canOutdent: false };
  const blocks = selectedBlocks(state);
  const enabled = blocks.length > 0 && blocks.every(({ name }) => name === "paragraph" || name === CONTROLLED_ALIGNED_PARAGRAPH_NAME);
  const alignments = new Set(blocks.map(({ align }) => align));
  return {
    current: alignments.size === 1 ? [...alignments][0]! : "mixed",
    enabled,
    canIndent: false,
    canOutdent: false,
  };
}

export function createControlledBlockAlignmentTransaction(
  state: EditorState,
  action: SelectionAlignmentAction,
  options: { composing?: boolean } = {},
): Transaction | null {
  if (options.composing || state.selection.empty || action === "increase-indent" || action === "decrease-indent") return null;
  const blocks = selectedBlocks(state);
  if (blocks.length === 0 || blocks.some(({ name }) => name !== "paragraph" && name !== CONTROLLED_ALIGNED_PARAGRAPH_NAME)) return null;
  const paragraph = state.schema.nodes.paragraph;
  const aligned = state.schema.nodes[CONTROLLED_ALIGNED_PARAGRAPH_NAME];
  if (!paragraph || !aligned) return null;
  const transaction = state.tr;
  for (const block of blocks) {
    if (block.align === action) continue;
    if (action === "left") transaction.setNodeMarkup(block.pos, paragraph);
    else transaction.setNodeMarkup(block.pos, aligned, { align: action });
  }
  return transaction.docChanged ? transaction.scrollIntoView() : null;
}
