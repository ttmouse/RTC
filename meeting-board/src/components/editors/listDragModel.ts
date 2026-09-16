export type ListDragType = "bullet" | "ordered";

export type ListDragItem = {
  id: string;
  depth: number;
  listType: ListDragType;
  checked: boolean | null;
};

export type ListDragDropReason =
  | "invalid-geometry"
  | "invalid-items"
  | "invalid-source"
  | "invalid-target"
  | "target-inside-source"
  | "no-op";

export type ListDragDropResult =
  | { ok: false; reason: ListDragDropReason }
  | {
      ok: true;
      sourceRootIds: string[];
      movedIds: string[];
      insertionIndex: number;
      depth: number;
      depthDelta: number;
      parentId: string | null;
      listType: ListDragType;
      checked: boolean | null;
      cue: "same-level" | "nested" | "lifted";
      plannedItems: ListDragItem[];
    };

type ListDragDropInput = {
  items: readonly ListDragItem[];
  sourceIds: readonly string[];
  targetId: string;
  dropAfter: boolean;
  pointerX: number;
  rootLeft: number;
  indentWidth: number;
};

function validFlatList(items: readonly ListDragItem[]): boolean {
  if (items.length === 0 || items[0]?.depth !== 0) return false;
  const ids = new Set<string>();
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const previous = items[index - 1];
    if (
      !item
      || !item.id
      || ids.has(item.id)
      || !Number.isInteger(item.depth)
      || item.depth < 0
      || (previous && item.depth > previous.depth + 1)
      || (item.listType !== "bullet" && item.listType !== "ordered")
    ) return false;
    ids.add(item.id);
  }
  return true;
}

function subtreeEnd(items: readonly ListDragItem[], index: number): number {
  const depth = items[index]?.depth;
  if (depth == null) return index;
  let end = index + 1;
  while (end < items.length && (items[end]?.depth ?? 0) > depth) end += 1;
  return end;
}

function samePlan(left: readonly ListDragItem[], right: readonly ListDragItem[]): boolean {
  return left.length === right.length && left.every((item, index) => {
    const other = right[index];
    return other != null
      && item.id === other.id
      && item.depth === other.depth
      && item.listType === other.listType
      && item.checked === other.checked;
  });
}

export function resolveListDragDrop(input: ListDragDropInput): ListDragDropResult {
  if (
    !Number.isFinite(input.pointerX)
    || !Number.isFinite(input.rootLeft)
    || !Number.isFinite(input.indentWidth)
    || input.indentWidth <= 0
  ) return { ok: false, reason: "invalid-geometry" };
  if (!validFlatList(input.items)) return { ok: false, reason: "invalid-items" };

  const indexById = new Map(input.items.map((item, index) => [item.id, index]));
  const selectedIndices: number[] = [];
  const seen = new Set<number>();
  for (const id of input.sourceIds) {
    const index = indexById.get(id);
    if (index == null) return { ok: false, reason: "invalid-source" };
    if (!seen.has(index)) {
      seen.add(index);
      selectedIndices.push(index);
    }
  }
  if (selectedIndices.length === 0) return { ok: false, reason: "invalid-source" };
  selectedIndices.sort((a, b) => a - b);

  const rootIndices = selectedIndices.filter((index) => !selectedIndices.some((candidate) => (
    candidate < index && subtreeEnd(input.items, candidate) > index
  )));
  const movedIndices = new Set<number>();
  rootIndices.forEach((index) => {
    for (let cursor = index; cursor < subtreeEnd(input.items, index); cursor += 1) movedIndices.add(cursor);
  });

  const targetIndex = indexById.get(input.targetId);
  if (targetIndex == null) return { ok: false, reason: "invalid-target" };
  if (movedIndices.has(targetIndex)) return { ok: false, reason: "target-inside-source" };

  const remaining = input.items.filter((_item, index) => !movedIndices.has(index));
  const requestedDepth = Math.max(0, Math.round((input.pointerX - input.rootLeft) / input.indentWidth));
  let boundary = input.dropAfter ? subtreeEnd(input.items, targetIndex) : targetIndex;
  const targetDepth = input.items[targetIndex]?.depth ?? 0;
  if (requestedDepth < targetDepth) {
    let ancestorIndex = targetIndex;
    while (ancestorIndex > 0 && (input.items[ancestorIndex]?.depth ?? 0) > requestedDepth) ancestorIndex -= 1;
    boundary = input.dropAfter ? subtreeEnd(input.items, ancestorIndex) : ancestorIndex;
  }
  const insertionIndex = input.items.reduce((count, _item, index) => (
    index < boundary && !movedIndices.has(index) ? count + 1 : count
  ), 0);

  const previous = remaining[insertionIndex - 1];
  const maximumDepth = previous ? previous.depth + 1 : 0;
  let depth = Math.min(requestedDepth, maximumDepth);
  let parentId: string | null = null;
  while (depth > 0 && !parentId) {
    for (let index = insertionIndex - 1; index >= 0; index -= 1) {
      const item = remaining[index];
      if (item?.depth === depth - 1) {
        parentId = item.id;
        break;
      }
    }
    if (!parentId) depth -= 1;
  }

  const transformed: ListDragItem[] = [];
  rootIndices.forEach((rootIndex) => {
    const root = input.items[rootIndex];
    if (!root) return;
    const rootEnd = subtreeEnd(input.items, rootIndex);
    for (let index = rootIndex; index < rootEnd; index += 1) {
      const item = input.items[index];
      if (!item) continue;
      transformed.push({ ...item, depth: depth + (item.depth - root.depth) });
    }
  });

  const unchangedTypePlan = [
    ...remaining.slice(0, insertionIndex),
    ...transformed,
    ...remaining.slice(insertionIndex),
  ];
  if (samePlan(input.items, unchangedTypePlan)) return { ok: false, reason: "no-op" };

  const firstRoot = input.items[rootIndices[0] ?? -1];
  const target = input.items[targetIndex];
  if (!firstRoot || !target) return { ok: false, reason: "invalid-source" };
  const listType = depth === target.depth ? target.listType : firstRoot.listType;
  transformed[0] = { ...transformed[0]!, listType };
  const plannedItems = [
    ...remaining.slice(0, insertionIndex),
    ...transformed,
    ...remaining.slice(insertionIndex),
  ];

  const rootDepths = rootIndices.map((index) => input.items[index]?.depth ?? depth);
  const deltas = new Set(rootDepths.map((sourceDepth) => depth - sourceDepth));
  const depthDelta = depth - (firstRoot.depth ?? depth);
  const cue = deltas.size !== 1 || depthDelta === 0
    ? "same-level"
    : (depthDelta > 0 ? "nested" : "lifted");

  return {
    ok: true,
    sourceRootIds: rootIndices.map((index) => input.items[index]!.id),
    movedIds: transformed.map((item) => item.id),
    insertionIndex,
    depth,
    depthDelta,
    parentId,
    listType,
    checked: firstRoot.checked,
    cue,
    plannedItems,
  };
}
