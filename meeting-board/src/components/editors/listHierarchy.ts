import type { ListDragTreeSnapshot } from "./listDragTransaction";
import type { EditorState, Transaction } from "@milkdown/kit/prose/state";
import { Selection, TextSelection } from "@milkdown/kit/prose/state";
import { liftListItem, sinkListItem } from "@milkdown/kit/prose/schema-list";
import { inspectListDragTree } from "./listDragTransaction";

export type ListHierarchyUnavailableReason =
  | "root-level"
  | "no-previous-sibling"
  | "missing-item"
  | "mixed-depth"
  | "mixed-list"
  | "non-contiguous";

export type ListHierarchyAvailability = {
  lift: { enabled: boolean; reason: ListHierarchyUnavailableReason | null };
  sink: { enabled: boolean; reason: ListHierarchyUnavailableReason | null };
};

export type ListHierarchyAction = "lift" | "sink";

export type ListHierarchyTarget = {
  listPos: number;
  sourceIds: readonly string[];
};

function unavailable(reason: ListHierarchyUnavailableReason): ListHierarchyAvailability {
  return {
    lift: { enabled: false, reason },
    sink: { enabled: false, reason },
  };
}

function nextSiblingIndex(snapshot: ListDragTreeSnapshot, index: number, depth: number): number {
  let cursor = index + 1;
  while (cursor < snapshot.entries.length && snapshot.entries[cursor]!.depth > depth) cursor += 1;
  return cursor;
}

function previousSiblingIndex(snapshot: ListDragTreeSnapshot, index: number, depth: number): number | null {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const candidate = snapshot.entries[cursor]!;
    if (candidate.depth === depth) return cursor;
    if (candidate.depth < depth) return null;
  }
  return null;
}

export function resolveListHierarchyAvailability(
  snapshot: ListDragTreeSnapshot,
  sourceIds: readonly string[],
): ListHierarchyAvailability {
  const indexById = new Map(snapshot.entries.map((entry, index) => [entry.id, index]));
  const selectedIndices = [...new Set(sourceIds.map((id) => indexById.get(id)))];
  if (selectedIndices.length === 0 || selectedIndices.some((index) => index == null)) return unavailable("missing-item");
  const indices = (selectedIndices as number[]).sort((left, right) => left - right);
  const first = snapshot.entries[indices[0]!]!;
  if (indices.some((index) => snapshot.entries[index]!.depth !== first.depth)) return unavailable("mixed-depth");
  if (indices.some((index) => snapshot.entries[index]!.listType !== first.listType)) return unavailable("mixed-list");
  for (let offset = 1; offset < indices.length; offset += 1) {
    if (indices[offset] !== nextSiblingIndex(snapshot, indices[offset - 1]!, first.depth)) {
      return unavailable("non-contiguous");
    }
  }

  const previousSibling = previousSiblingIndex(snapshot, indices[0]!, first.depth);
  return {
    lift: first.depth > 0
      ? { enabled: true, reason: null }
      : { enabled: false, reason: "root-level" },
    sink: previousSibling != null && !indices.includes(previousSibling)
      ? { enabled: true, reason: null }
      : { enabled: false, reason: "no-previous-sibling" },
  };
}

function selectionForSources(state: EditorState, snapshot: ListDragTreeSnapshot, sourceIds: readonly string[]): TextSelection | null {
  const selected = sourceIds
    .map((id) => snapshot.entries.find((entry) => entry.id === id))
    .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
    .sort((left, right) => left.pos - right.pos);
  if (selected.length !== new Set(sourceIds).size || selected.length === 0) return null;
  try {
    const first = Selection.near(state.doc.resolve(selected[0]!.pos + 1), 1);
    const lastEntry = selected[selected.length - 1]!;
    const last = Selection.near(state.doc.resolve(lastEntry.pos + lastEntry.node.nodeSize - 1), -1);
    return TextSelection.create(state.doc, first.from, last.to);
  } catch {
    return null;
  }
}

export function createListHierarchyTransaction(
  state: EditorState,
  input: ListHierarchyTarget & { action: ListHierarchyAction },
): Transaction | null {
  const snapshot = inspectListDragTree(state.doc, input.listPos);
  if (!snapshot) return null;
  const availability = resolveListHierarchyAvailability(snapshot, input.sourceIds);
  if (!availability[input.action].enabled) return null;
  const selection = selectionForSources(state, snapshot, input.sourceIds);
  const listItemType = state.schema.nodes.list_item;
  if (!selection || !listItemType) return null;
  const selectedState = state.apply(state.tr.setSelection(selection).setMeta("addToHistory", false));
  const command = input.action === "lift" ? liftListItem(listItemType) : sinkListItem(listItemType);
  let transaction: Transaction | null = null;
  const applied = command(selectedState, (next) => { transaction = next; });
  return applied && transaction
    ? (transaction as Transaction).setMeta("omiaListHierarchy", { action: input.action, count: input.sourceIds.length })
    : null;
}
