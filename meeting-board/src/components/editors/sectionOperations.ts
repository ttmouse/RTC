import type { Node as ProseNode } from "@milkdown/kit/prose/model";
import type { Transaction } from "@milkdown/kit/prose/state";
import { sectionRangeAtHeading } from "./sectionFold";

type TopLevelBlock = Readonly<{ index: number; pos: number }>;
type MovedBlock = Readonly<{ pos: number; nodeSize: number }>;

function topLevelBlocks(document: ProseNode): readonly TopLevelBlock[] {
  const blocks: TopLevelBlock[] = [];
  document.forEach((_node, pos, index) => blocks.push({ index, pos }));
  return blocks;
}

/** Return the top-level block indices belonging to one heading, including the heading itself. */
export function sectionBlockIndicesAtHeading(
  document: ProseNode,
  headingPos: number,
): readonly number[] {
  const range = sectionRangeAtHeading(document, headingPos);
  if (!range) return [];
  return topLevelBlocks(document)
    .filter((block) => block.pos >= range.headingPos && block.pos < range.to)
    .map((block) => block.index);
}

/**
 * Expand only selected headings that are currently collapsed. Parent/child overlaps and repeated
 * multi-selection entries collapse to one sorted source list, so transactions never duplicate blocks.
 */
export function expandCollapsedSectionBlockIndices(
  document: ProseNode,
  sourceIndices: readonly number[],
  collapsedHeadingPositions: readonly number[],
): readonly number[] {
  const blocks = topLevelBlocks(document);
  const collapsed = new Set(collapsedHeadingPositions);
  const expanded = new Set<number>();
  for (const index of sourceIndices) {
    const block = blocks[index];
    if (!block) continue;
    expanded.add(index);
    if (!collapsed.has(block.pos)) continue;
    sectionBlockIndicesAtHeading(document, block.pos).forEach((sectionIndex) => expanded.add(sectionIndex));
  }
  return [...expanded].sort((left, right) => left - right);
}

/**
 * Recompute fold anchors after a delete+insert block move. ProseMirror maps a deleted heading to
 * an adjacent surviving block, so moved headings must use their explicit offset in the insertion.
 */
export function foldedHeadingPositionsAfterBlockMove(
  transaction: Transaction,
  sourceBlocks: readonly MovedBlock[],
  insertAt: number,
  previousFoldedPositions: readonly number[],
): readonly number[] {
  const insertedOffsets = new Map<number, number>();
  let offset = 0;
  sourceBlocks.forEach((source) => {
    insertedOffsets.set(source.pos, offset);
    offset += source.nodeSize;
  });

  const next = new Set<number>();
  previousFoldedPositions.forEach((headingPos) => {
    const insertedOffset = insertedOffsets.get(headingPos);
    if (insertedOffset != null) {
      next.add(insertAt + insertedOffset);
      return;
    }
    const mapped = transaction.mapping.mapResult(headingPos, 1);
    if (!mapped.deletedAcross) next.add(mapped.pos);
  });
  return [...next].sort((left, right) => left - right);
}

/** Move a collapsed section by one sibling section without splitting either heading subtree. */
export function collapsedSectionStepDestination(
  document: ProseNode,
  sourceIndices: readonly number[],
  headingPos: number,
  direction: "up" | "down",
): number | null {
  const sectionIndices = sectionBlockIndicesAtHeading(document, headingPos);
  const sortedSources = [...new Set(sourceIndices)].sort((left, right) => left - right);
  if (sectionIndices.length === 0
    || sectionIndices.length !== sortedSources.length
    || sectionIndices.some((index, offset) => index !== sortedSources[offset])) return null;

  const blocks: Array<{ pos: number; level: number | null }> = [];
  document.forEach((node, pos) => {
    blocks.push({ pos, level: node.type.name === "heading" ? Number(node.attrs.level) : null });
  });
  const level = Number(document.nodeAt(headingPos)?.attrs.level);
  const first = sectionIndices[0]!;
  const last = sectionIndices[sectionIndices.length - 1]!;

  if (direction === "up") {
    for (let index = first - 1; index >= 0; index -= 1) {
      const candidateLevel = blocks[index]?.level;
      if (candidateLevel == null || candidateLevel > level) continue;
      return candidateLevel === level ? index : null;
    }
    return null;
  }

  const next = blocks[last + 1];
  if (!next || next.level !== level) return null;
  const nextSection = sectionBlockIndicesAtHeading(document, next.pos);
  return nextSection.length > 0 ? first + nextSection.length : null;
}
