export type PersistentLayoutBlockRef = Readonly<{ columnIndex: number; blockIndex: number }>;
export type PersistentLayoutDropIntent = Readonly<{ columnIndex: number; blockIndex: number }>;
export type PersistentLayoutPointerOwner = "layout-block" | "top-level-block" | "table-resize" | "image-node" | "system-file" | null;

export type PersistentLayoutDropColumn = Readonly<{
  columnIndex: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
  blocks: readonly Readonly<{ blockIndex: number; top: number; bottom: number }>[];
}>;

export function layoutBlockRefKey(ref: PersistentLayoutBlockRef): string {
  return `${ref.columnIndex}:${ref.blockIndex}`;
}

export function parseLayoutBlockRefKey(value: string): PersistentLayoutBlockRef | null {
  const match = /^(0|[1-9]\d*):(0|[1-9]\d*)$/.exec(value);
  return match ? { columnIndex: Number(match[1]), blockIndex: Number(match[2]) } : null;
}

export function resolvePersistentLayoutPointerOwner(
  target: Element | null,
  input: { systemFileDragActive?: boolean } = {},
): PersistentLayoutPointerOwner {
  if (input.systemFileDragActive) return "system-file";
  if (!target) return null;
  if (target.closest("[data-omia-table-resize-boundary], [data-omia-advanced-table-resize]")) return "table-resize";
  if (target.closest("[data-omia-layout-drag-handle='1']")) return "layout-block";
  if (target.closest(".milkdown-image-block[draggable='true']")) return "image-node";
  if (target.closest(".milkdown-block-handle, [data-block-handle]")) return "top-level-block";
  return null;
}

export function resolvePersistentLayoutDropIntent(
  columns: readonly PersistentLayoutDropColumn[],
  point: { clientX: number; clientY: number; hitColumnIndex?: number | null },
): PersistentLayoutDropIntent | null {
  if (!Number.isFinite(point.clientX) || !Number.isFinite(point.clientY) || columns.length === 0) return null;
  const semantic = point.hitColumnIndex == null
    ? null
    : columns.find((column) => column.columnIndex === point.hitColumnIndex) ?? null;
  const column = semantic ?? columns.find((candidate) => (
    point.clientX >= candidate.left && point.clientX <= candidate.right
  )) ?? null;
  if (!column || column.right < column.left || column.bottom < column.top) return null;
  const ordered = [...column.blocks].sort((left, right) => left.blockIndex - right.blockIndex);
  if (ordered.some((block, index) => block.blockIndex !== index || block.bottom < block.top)) return null;
  for (const block of ordered) {
    if (point.clientY < block.top + (block.bottom - block.top) / 2) {
      return { columnIndex: column.columnIndex, blockIndex: block.blockIndex };
    }
  }
  return { columnIndex: column.columnIndex, blockIndex: ordered.length };
}

function orderedSelection(all: readonly PersistentLayoutBlockRef[], keys: ReadonlySet<string>): Set<string> {
  return new Set(all.map(layoutBlockRefKey).filter((key) => keys.has(key)));
}

export function updatePersistentLayoutDragSelection(
  all: readonly PersistentLayoutBlockRef[],
  current: ReadonlySet<string>,
  target: PersistentLayoutBlockRef,
  input: { additive: boolean; range: boolean; anchor?: PersistentLayoutBlockRef | null },
): Set<string> {
  const targetKey = layoutBlockRefKey(target);
  const targetIndex = all.findIndex((ref) => layoutBlockRefKey(ref) === targetKey);
  if (targetIndex < 0) return orderedSelection(all, current);
  if (input.range) {
    const anchorKey = layoutBlockRefKey(input.anchor ?? target);
    const anchorIndex = all.findIndex((ref) => layoutBlockRefKey(ref) === anchorKey);
    const from = Math.min(anchorIndex < 0 ? targetIndex : anchorIndex, targetIndex);
    const to = Math.max(anchorIndex < 0 ? targetIndex : anchorIndex, targetIndex);
    return new Set(all.slice(from, to + 1).map(layoutBlockRefKey));
  }
  if (!input.additive) return new Set([targetKey]);
  const next = new Set(current);
  if (next.has(targetKey)) next.delete(targetKey);
  else next.add(targetKey);
  return orderedSelection(all, next);
}
