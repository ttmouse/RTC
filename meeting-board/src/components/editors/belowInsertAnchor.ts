export type BelowInsertAnchor<T> = Readonly<{
  node: T;
  originalIndex: number;
}>;

type BlockSequence<T> = {
  childCount: number;
  child: (index: number) => T;
  forEach: (callback: (node: T, offset: number, index: number) => void) => void;
};

export function createBelowInsertAnchor<T>(
  document: BlockSequence<T>,
  targetIndex: number,
): BelowInsertAnchor<T> | null {
  if (targetIndex < 0 || targetIndex >= document.childCount) return null;
  return Object.freeze({ node: document.child(targetIndex), originalIndex: targetIndex });
}

/** Node identity survives unrelated ProseMirror transactions; zero or duplicate matches are stale. */
export function resolveBelowInsertAnchor<T>(
  document: BlockSequence<T>,
  anchor: BelowInsertAnchor<T>,
): number | null {
  const matches: Array<{ offset: number; nodeSize: number }> = [];
  document.forEach((node, offset) => {
    if (node === anchor.node) matches.push({ offset, nodeSize: Number((node as { nodeSize?: number }).nodeSize ?? 0) });
  });
  if (matches.length !== 1 || matches[0].nodeSize <= 0) return null;
  return matches[0].offset + matches[0].nodeSize;
}
