import type { Node as ProseNode, NodeType } from "@milkdown/kit/prose/model";
import type { EditorState, Transaction } from "@milkdown/kit/prose/state";
import {
  resolveListDragDrop,
  type ListDragItem,
  type ListDragType,
} from "./listDragModel";

export type ListDragTreeEntry = ListDragItem & {
  pos: number;
  node: ProseNode;
  listAttrs: Record<string, unknown>;
};

export type ListDragTreeSnapshot = {
  listPos: number;
  listNode: ProseNode;
  entries: ListDragTreeEntry[];
};

export type ListDragTransactionInput = {
  listPos: number;
  sourceIds: readonly string[];
  targetId: string;
  dropAfter: boolean;
  pointerX: number;
  rootLeft: number;
  indentWidth: number;
};

type PlannedTreeItem = {
  model: ListDragItem;
  entry: ListDragTreeEntry;
  children: PlannedTreeItem[];
};

function listTypeOf(node: ProseNode): ListDragType | null {
  if (node.type.name === "bullet_list") return "bullet";
  if (node.type.name === "ordered_list") return "ordered";
  return null;
}

function isPortableListItem(node: ProseNode): boolean {
  if (node.type.name !== "list_item" || node.childCount === 0 || node.firstChild?.type.name !== "paragraph") return false;
  let sawNestedList = false;
  let portable = true;
  node.forEach((child) => {
    const isList = listTypeOf(child) != null;
    if (isList) sawNestedList = true;
    else if (sawNestedList) portable = false;
  });
  return portable;
}

export function inspectListDragTree(document: ProseNode, listPos: number): ListDragTreeSnapshot | null {
  const listNode = document.nodeAt(listPos);
  if (!listNode || listTypeOf(listNode) == null) return null;
  const entries: ListDragTreeEntry[] = [];
  let portable = true;

  const visitList = (node: ProseNode, pos: number, depth: number) => {
    const listType = listTypeOf(node);
    if (!listType) {
      portable = false;
      return;
    }
    node.forEach((listItem, offset) => {
      if (!isPortableListItem(listItem)) {
        portable = false;
        return;
      }
      const itemPos = pos + 1 + offset;
      entries.push({
        id: `list-item:${itemPos}`,
        pos: itemPos,
        node: listItem,
        depth,
        listType,
        checked: typeof listItem.attrs.checked === "boolean" ? listItem.attrs.checked : null,
        listAttrs: { ...node.attrs },
      });
      listItem.forEach((child, childOffset) => {
        if (listTypeOf(child)) visitList(child, itemPos + 1 + childOffset, depth + 1);
      });
    });
  };
  visitList(listNode, listPos, 0);
  return portable && entries.length > 0 ? { listPos, listNode, entries } : null;
}

function plannedTree(items: readonly ListDragItem[], entries: Map<string, ListDragTreeEntry>): PlannedTreeItem[] | null {
  const roots: PlannedTreeItem[] = [];
  const stack: PlannedTreeItem[] = [];
  for (const model of items) {
    const entry = entries.get(model.id);
    if (!entry || model.depth > stack.length) return null;
    const current: PlannedTreeItem = { model, entry, children: [] };
    if (model.depth === 0) roots.push(current);
    else stack[model.depth - 1]?.children.push(current);
    stack.length = model.depth;
    stack.push(current);
  }
  return roots;
}

function listNodeType(document: ProseNode, listType: ListDragType): NodeType | null {
  return document.type.schema.nodes[listType === "ordered" ? "ordered_list" : "bullet_list"] ?? null;
}

function normalizeGfmAttrs(attrs: Record<string, unknown>): Record<string, unknown> {
  const normalized = { ...attrs };
  for (const name of ["spread", "checked"] as const) {
    if (normalized[name] === "true") normalized[name] = true;
    else if (normalized[name] === "false") normalized[name] = false;
  }
  if (typeof normalized.order === "string" && /^\d+$/.test(normalized.order)) {
    normalized.order = Number(normalized.order);
  }
  return normalized;
}

function wrapperAttrs(tree: PlannedTreeItem): Record<string, unknown> | null {
  return tree.entry.listType === tree.model.listType ? normalizeGfmAttrs(tree.entry.listAttrs) : null;
}

function buildListNodes(document: ProseNode, trees: readonly PlannedTreeItem[]): ProseNode[] | null {
  const result: ProseNode[] = [];
  let cursor = 0;
  while (cursor < trees.length) {
    const listType = trees[cursor]?.model.listType;
    if (!listType) return null;
    let end = cursor + 1;
    while (end < trees.length && trees[end]?.model.listType === listType) end += 1;
    const group = trees.slice(cursor, end);
    const type = listNodeType(document, listType);
    if (!type) return null;
    const listItems = group.map((tree) => buildListItem(document, tree));
    if (listItems.some((node) => !node)) return null;
    const list = type.create(wrapperAttrs(group[0]!), listItems as ProseNode[]);
    if (!list.type.validContent(list.content)) return null;
    result.push(list);
    cursor = end;
  }
  return result;
}

function buildListItem(document: ProseNode, tree: PlannedTreeItem): ProseNode | null {
  const baseChildren: ProseNode[] = [];
  tree.entry.node.forEach((child) => {
    if (listTypeOf(child) == null) baseChildren.push(child);
  });
  const nestedLists = buildListNodes(document, tree.children);
  if (!nestedLists) return null;
  const node = tree.entry.node.type.create(
    normalizeGfmAttrs(tree.entry.node.attrs),
    [...baseChildren, ...nestedLists],
    tree.entry.node.marks,
  );
  return node.type.validContent(node.content) ? node : null;
}

export function createListDragTransaction(
  state: EditorState,
  input: ListDragTransactionInput,
): Transaction | null {
  const snapshot = inspectListDragTree(state.doc, input.listPos);
  if (!snapshot) return null;
  const plan = resolveListDragDrop({
    items: snapshot.entries,
    sourceIds: input.sourceIds,
    targetId: input.targetId,
    dropAfter: input.dropAfter,
    pointerX: input.pointerX,
    rootLeft: input.rootLeft,
    indentWidth: input.indentWidth,
  });
  if (!plan.ok) return null;

  try {
    const entries = new Map(snapshot.entries.map((entry) => [entry.id, entry]));
    const trees = plannedTree(plan.plannedItems, entries);
    if (!trees) return null;
    const replacement = buildListNodes(state.doc, trees);
    if (!replacement || replacement.length === 0) return null;
    replacement.forEach((node) => node.check());
    const transaction = state.tr.replaceWith(
      snapshot.listPos,
      snapshot.listPos + snapshot.listNode.nodeSize,
      replacement,
    );
    return transaction.setMeta("omiaListDrag", {
      depth: plan.depth,
      cue: plan.cue,
      sourceCount: plan.sourceRootIds.length,
    });
  } catch {
    return null;
  }
}
