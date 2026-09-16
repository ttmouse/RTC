import { $prose } from "@milkdown/kit/utils";
import type { Node as ProseNode } from "@milkdown/kit/prose/model";
import {
  Plugin,
  PluginKey,
  type EditorState,
  type Transaction,
} from "@milkdown/kit/prose/state";
import { Decoration, DecorationSet } from "@milkdown/kit/prose/view";

export type SectionRange = Readonly<{
  headingPos: number;
  from: number;
  to: number;
  level: number;
}>;

type SectionFoldState = Readonly<{ folded: ReadonlySet<number> }>;
type SectionFoldMeta = Readonly<
  | { type: "toggle"; headingPos: number }
  | { type: "unfold-all" }
  | { type: "replace"; headingPositions: readonly number[] }
>;

export const sectionFoldPluginKey = new PluginKey<SectionFoldState>("omia-section-fold");

function headingLevel(node: ProseNode | null | undefined): number | null {
  if (!node || node.type.name !== "heading") return null;
  const level = Number(node.attrs.level);
  return Number.isInteger(level) && level >= 1 && level <= 6 ? level : null;
}

/** Resolve a top-level Markdown heading and every following block in its hierarchy. */
export function sectionRangeAtHeading(document: ProseNode, headingPos: number): SectionRange | null {
  const heading = document.nodeAt(headingPos);
  const level = headingLevel(heading);
  if (level == null) return null;
  const from = headingPos + heading!.nodeSize;
  let to = document.content.size;
  document.forEach((node, pos) => {
    if (pos <= headingPos) return;
    const candidateLevel = headingLevel(node);
    if (to === document.content.size && candidateLevel != null && candidateLevel <= level) to = pos;
  });
  return { headingPos, from, to, level };
}

function mappedFoldedPositions(
  previous: ReadonlySet<number>,
  transaction: Transaction,
): Set<number> {
  const mapped = new Set<number>();
  for (const pos of previous) {
    const result = transaction.mapping.mapResult(pos, 1);
    const previousHeading = transaction.before.nodeAt(pos);
    const nextHeading = transaction.doc.nodeAt(result.pos);
    const sameHeadingSignature = headingLevel(previousHeading) === headingLevel(nextHeading)
      && previousHeading?.textContent === nextHeading?.textContent;
    // Text edits/undo inside a heading may mark one side of its boundary deleted while the heading node survives.
    // A structural move can otherwise map the deleted anchor onto an adjacent heading of the same level.
    if (!result.deletedAcross
      && headingLevel(nextHeading) != null
      && (!result.deleted || sameHeadingSignature)) mapped.add(result.pos);
  }
  return mapped;
}

export function createSectionFoldPlugin(): Plugin<SectionFoldState> {
  return new Plugin<SectionFoldState>({
    key: sectionFoldPluginKey,
    state: {
      init: () => ({ folded: new Set<number>() }),
      apply(transaction, previous) {
        const folded = mappedFoldedPositions(previous.folded, transaction);
        const meta = transaction.getMeta(sectionFoldPluginKey) as SectionFoldMeta | undefined;
        if (meta?.type === "unfold-all") folded.clear();
        else if (meta?.type === "replace") {
          folded.clear();
          meta.headingPositions.forEach((headingPos) => {
            if (headingLevel(transaction.doc.nodeAt(headingPos)) != null) folded.add(headingPos);
          });
        }
        else if (meta?.type === "toggle") {
          if (folded.has(meta.headingPos)) folded.delete(meta.headingPos);
          else if (headingLevel(transaction.doc.nodeAt(meta.headingPos)) != null) folded.add(meta.headingPos);
        }
        return { folded };
      },
    },
    props: {
      decorations: sectionFoldDecorations,
    },
  });
}

export const sectionFoldPlugin = $prose(() => createSectionFoldPlugin());

export function foldedHeadingPositions(state: EditorState): readonly number[] {
  return [...(sectionFoldPluginKey.getState(state)?.folded ?? [])].sort((left, right) => left - right);
}

export function sectionFoldDecorations(state: EditorState): DecorationSet {
  const decorations: Decoration[] = [];
  for (const headingPos of foldedHeadingPositions(state)) {
    const range = sectionRangeAtHeading(state.doc, headingPos);
    if (!range || range.from >= range.to) continue;
    state.doc.forEach((node, pos) => {
      if (pos < range.from || pos >= range.to) return;
      decorations.push(Decoration.node(pos, pos + node.nodeSize, {
        class: "omia-section-fold-hidden",
        "data-omia-folded-under": String(headingPos),
        "aria-hidden": "true",
      }));
    });
  }
  return decorations.length > 0 ? DecorationSet.create(state.doc, decorations) : DecorationSet.empty;
}

export function createSectionFoldTransaction(state: EditorState, headingPos: number): Transaction | null {
  if (headingLevel(state.doc.nodeAt(headingPos)) == null) return null;
  return state.tr
    .setMeta(sectionFoldPluginKey, { type: "toggle", headingPos } satisfies SectionFoldMeta)
    .setMeta("addToHistory", false);
}

export function createUnfoldAllSectionsTransaction(state: EditorState): Transaction | null {
  if (foldedHeadingPositions(state).length === 0) return null;
  return state.tr
    .setMeta(sectionFoldPluginKey, { type: "unfold-all" } satisfies SectionFoldMeta)
    .setMeta("addToHistory", false);
}

/** Re-anchor view-only folds when one document transaction relocates complete heading nodes. */
export function replaceFoldedHeadingPositions(
  transaction: Transaction,
  headingPositions: readonly number[],
): Transaction {
  return transaction.setMeta(sectionFoldPluginKey, {
    type: "replace",
    headingPositions: [...new Set(headingPositions)].sort((left, right) => left - right),
  } satisfies SectionFoldMeta);
}

export function shouldCopyWholeFoldedDocument(input: Readonly<{
  from: number;
  to: number;
  documentSize: number;
  foldedCount: number;
}>): boolean {
  return input.foldedCount > 0
    && input.from <= 1
    && input.to >= input.documentSize - 1;
}
