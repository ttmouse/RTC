import { DOMParser as ProseDOMParser, DOMSerializer, Fragment, type Node as ProseNode } from "@milkdown/kit/prose/model";
import { NodeSelection, type EditorState, type Transaction } from "@milkdown/kit/prose/state";
import {
  PERSISTENT_LAYOUT_NODE_NAME,
  PERSISTENT_LAYOUT_EMPTY_BLOCK,
  canonicalizePersistentLayoutBlock,
  createPersistentLayoutModel,
  linearizePersistentLayout,
  serializePersistentLayoutHtml,
  validatePersistentLayoutModel,
  type PersistentLayoutBlock,
  type PersistentLayoutModel,
} from "./layoutModel";
import type { PersistentLayoutBlockRef, PersistentLayoutDropIntent } from "./layoutDragModel";

export type PersistentLayoutTarget = { pos: number; nodeSize: number };
export type PersistentLayoutWidthPreset = "left-wide" | "equal" | "right-wide";
export type PersistentLayoutOrderAction = "previous" | "next";
export type PersistentLayoutDowngradeLoss = "column-structure" | "column-widths";

function equalWidths(count: number): number[] {
  const base = Math.floor(10000 / count);
  return Array.from({ length: count }, (_unused, index) => base + (index < 10000 - base * count ? 1 : 0));
}

function distribute(blocks: readonly PersistentLayoutBlock[], count: 2 | 3): PersistentLayoutBlock[][] {
  const source = blocks.length ? [...blocks] : [PERSISTENT_LAYOUT_EMPTY_BLOCK];
  const columns: PersistentLayoutBlock[][] = [];
  let cursor = 0;
  for (let index = 0; index < count; index++) {
    const remaining = source.length - cursor;
    const slots = count - index;
    const take = remaining > 0 ? Math.ceil(remaining / slots) : 0;
    columns.push(take ? source.slice(cursor, cursor + take) : [PERSISTENT_LAYOUT_EMPTY_BLOCK]);
    cursor += take;
  }
  return columns;
}

function nodeHtml(state: EditorState, node: ProseNode): string | null {
  if (node.type.name === "image-block") {
    const src = String(node.attrs.src ?? "");
    const caption = String(node.attrs.caption ?? "");
    const ratio = Number(node.attrs.ratio ?? 1);
    const escape = (value: string) => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const ratioAttr = Number.isFinite(ratio) && ratio > 0 && ratio <= 100 ? ` data-omia-ratio="${ratio}"` : "";
    return `<figure data-omia-image="1"${ratioAttr}><img src="${escape(src)}"${caption ? ` alt="${escape(caption)}"` : ""}></figure>`;
  }
  try {
    const rendered = DOMSerializer.fromSchema(state.schema).serializeNode(node);
    const wrapper = document.createElement("div");
    wrapper.appendChild(rendered);
    return wrapper.innerHTML;
  } catch {
    return null;
  }
}

function canonicalNodeBlock(state: EditorState, node: ProseNode): PersistentLayoutBlock | null {
  if (node.type.name === PERSISTENT_LAYOUT_NODE_NAME || node.type.name === "heading" && node.attrs.level === 1) return null;
  const html = nodeHtml(state, node);
  return html ? canonicalizePersistentLayoutBlock(html) : null;
}

function topLevelSelection(state: EditorState): { from: number; to: number; blocks: PersistentLayoutBlock[] } | null {
  const { from, to, empty, $from } = state.selection;
  const currentTopLevel = empty && $from.depth > 0 ? $from.before(1) : from;
  let rangeFrom = -1;
  let rangeTo = -1;
  const blocks: PersistentLayoutBlock[] = [];
  state.doc.forEach((node, offset) => {
    const end = offset + node.nodeSize;
    const intersects = empty ? offset === currentTopLevel : end > from && offset < to;
    if (!intersects) return;
    if (node.type.name === "heading" && node.attrs.level === 1) {
      rangeFrom = -2;
      return;
    }
    const block = canonicalNodeBlock(state, node);
    if (!block) { rangeFrom = -2; return; }
    if (rangeFrom < 0) rangeFrom = offset;
    rangeTo = end;
    blocks.push(block);
  });
  return rangeFrom >= 0 && rangeTo > rangeFrom && blocks.length ? { from: rangeFrom, to: rangeTo, blocks } : null;
}

function layoutNode(state: EditorState, model: PersistentLayoutModel): ProseNode | null {
  const type = state.schema.nodes[PERSISTENT_LAYOUT_NODE_NAME];
  if (!type || !validatePersistentLayoutModel(model)) return null;
  try { return type.create({ model }); } catch { return null; }
}

export function createPersistentLayoutTransaction(
  state: EditorState,
  input: { columns: 2 | 3; insertAt?: number },
): Transaction | null {
  const model = input.insertAt == null
    ? (() => {
        const selected = topLevelSelection(state);
        return selected ? { selected, model: createPersistentLayoutModel(distribute(selected.blocks, input.columns)) } : null;
      })()
    : { selected: null, model: createPersistentLayoutModel(distribute([], input.columns)) };
  if (!model?.model) return null;
  const replacement = layoutNode(state, model.model);
  if (!replacement) return null;
  if (input.insertAt != null) {
    if (!Number.isInteger(input.insertAt) || input.insertAt < 0 || input.insertAt > state.doc.content.size) return null;
    const $insert = state.doc.resolve(input.insertAt);
    if ($insert.depth !== 0) return null;
    return state.tr.insert(input.insertAt, replacement);
  }
  return state.tr.replaceWith(model.selected!.from, model.selected!.to, replacement);
}

function guardedLayout(state: EditorState, target: PersistentLayoutTarget): { node: ProseNode; model: PersistentLayoutModel } | null {
  const node = state.doc.nodeAt(target.pos);
  if (!node || node.nodeSize !== target.nodeSize || node.type.name !== PERSISTENT_LAYOUT_NODE_NAME
    || !validatePersistentLayoutModel(node.attrs.model)) return null;
  return { node, model: node.attrs.model as PersistentLayoutModel };
}

function replaceLayout(state: EditorState, target: PersistentLayoutTarget, model: PersistentLayoutModel): Transaction | null {
  const current = guardedLayout(state, target);
  const replacement = layoutNode(state, model);
  return current && replacement ? state.tr.replaceWith(target.pos, target.pos + target.nodeSize, replacement) : null;
}

export type PersistentLayoutBlockMoveInput = Readonly<{
  sources: readonly PersistentLayoutBlockRef[];
  destination: PersistentLayoutDropIntent;
}>;

export type PersistentLayoutBlockMovePlan = Readonly<{
  model: PersistentLayoutModel;
  movedRefs: readonly PersistentLayoutBlockRef[];
}>;

function orderedBlockRefs(model: PersistentLayoutModel): PersistentLayoutBlockRef[] {
  return model.columns.flatMap((column) => column.blocks.map((_block, blockIndex) => ({
    columnIndex: column.index,
    blockIndex,
  })));
}

export function planPersistentLayoutBlockMove(
  model: PersistentLayoutModel,
  input: PersistentLayoutBlockMoveInput,
): PersistentLayoutBlockMovePlan | null {
  if (!validatePersistentLayoutModel(model) || input.sources.length === 0) return null;
  const destinationColumn = model.columns[input.destination.columnIndex];
  if (!destinationColumn
    || destinationColumn.index !== input.destination.columnIndex
    || !Number.isInteger(input.destination.blockIndex)
    || input.destination.blockIndex < 0
    || input.destination.blockIndex > destinationColumn.blocks.length) return null;
  const sourceKeys = new Set<string>();
  for (const source of input.sources) {
    if (!Number.isInteger(source.columnIndex) || !Number.isInteger(source.blockIndex)) return null;
    const column = model.columns[source.columnIndex];
    if (!column || column.index !== source.columnIndex || !column.blocks[source.blockIndex]) return null;
    const key = `${source.columnIndex}:${source.blockIndex}`;
    if (sourceKeys.has(key)) return null;
    sourceKeys.add(key);
  }
  const sources = orderedBlockRefs(model).filter((ref) => sourceKeys.has(`${ref.columnIndex}:${ref.blockIndex}`));
  if (sources.length !== input.sources.length) return null;
  const moved = sources.map((ref) => model.columns[ref.columnIndex].blocks[ref.blockIndex]);
  const columns = model.columns.map((column) => [...column.blocks]);
  for (const source of [...sources].reverse()) columns[source.columnIndex].splice(source.blockIndex, 1);
  const removedBeforeDestination = sources.filter((source) => (
    source.columnIndex === input.destination.columnIndex && source.blockIndex < input.destination.blockIndex
  )).length;
  let insertAt = Math.max(0, input.destination.blockIndex - removedBeforeDestination);
  const destinationBlocks = columns[input.destination.columnIndex];
  const destinationIsCanonicalEmpty = sources.every((source) => source.columnIndex !== input.destination.columnIndex)
    && destinationBlocks.length === 1
    && destinationBlocks[0].kind === PERSISTENT_LAYOUT_EMPTY_BLOCK.kind
    && destinationBlocks[0].html === PERSISTENT_LAYOUT_EMPTY_BLOCK.html;
  if (destinationIsCanonicalEmpty) {
    destinationBlocks.splice(0, 1);
    insertAt = 0;
  }
  destinationBlocks.splice(insertAt, 0, ...moved);
  columns.forEach((blocks) => {
    if (blocks.length === 0) blocks.push(PERSISTENT_LAYOUT_EMPTY_BLOCK);
  });
  const next = createPersistentLayoutModel(columns, model.widths);
  if (!next || serializePersistentLayoutHtml(next) === serializePersistentLayoutHtml(model)) return null;
  return {
    model: next,
    movedRefs: moved.map((_block, offset) => ({
      columnIndex: input.destination.columnIndex,
      blockIndex: insertAt + offset,
    })),
  };
}

export function createPersistentLayoutBlockMoveTransaction(
  state: EditorState,
  target: PersistentLayoutTarget,
  input: PersistentLayoutBlockMoveInput,
): Transaction | null {
  const current = guardedLayout(state, target);
  const plan = current ? planPersistentLayoutBlockMove(current.model, input) : null;
  const transaction = plan ? replaceLayout(state, target, plan.model) : null;
  if (!transaction) return null;
  return transaction.setSelection(NodeSelection.create(transaction.doc, target.pos));
}

export function createImageSideBySideTransaction(
  state: EditorState,
  topLevelIndices: readonly number[],
): Transaction | null {
  const indices = [...new Set(topLevelIndices)].sort((left, right) => left - right);
  if (indices.length < 2 || indices.length > 3
    || indices.length !== topLevelIndices.length
    || indices.some((index, offset) => index !== indices[0] + offset)) return null;
  const blocks: Array<{ pos: number; nodeSize: number; block: PersistentLayoutBlock }> = [];
  state.doc.forEach((node, pos, index) => {
    if (!indices.includes(index)) return;
    if (node.type.name !== "image-block") return;
    const block = canonicalNodeBlock(state, node);
    if (block?.kind === "image") blocks.push({ pos, nodeSize: node.nodeSize, block });
  });
  if (blocks.length !== indices.length) return null;
  const model = createPersistentLayoutModel(blocks.map(({ block }) => [block]));
  const replacement = model && layoutNode(state, model);
  const first = blocks[0];
  const last = blocks[blocks.length - 1];
  if (!replacement || !first || !last) return null;
  const transaction = state.tr.replaceWith(first.pos, last.pos + last.nodeSize, replacement);
  return transaction.setSelection(NodeSelection.create(transaction.doc, first.pos));
}

export function createPersistentLayoutColumnCountTransaction(
  state: EditorState,
  target: PersistentLayoutTarget,
  count: 2 | 3,
): Transaction | null {
  const current = guardedLayout(state, target);
  if (!current || current.model.columns.length === count) return null;
  const blocks = linearizePersistentLayout(current.model);
  const model = blocks && createPersistentLayoutModel(distribute(blocks, count));
  return model ? replaceLayout(state, target, model) : null;
}

export function persistentLayoutPresetWidths(count: 2 | 3, preset: PersistentLayoutWidthPreset): number[] {
  if (preset === "equal") return equalWidths(count);
  if (count === 2) return preset === "left-wide" ? [6000, 4000] : [4000, 6000];
  return preset === "left-wide" ? [5000, 2500, 2500] : [2500, 2500, 5000];
}

export function createPersistentLayoutWidthTransaction(
  state: EditorState,
  target: PersistentLayoutTarget,
  preset: PersistentLayoutWidthPreset,
): Transaction | null {
  const current = guardedLayout(state, target);
  if (!current) return null;
  const widths = persistentLayoutPresetWidths(current.model.columns.length as 2 | 3, preset);
  if (widths.every((width, index) => width === current.model.widths[index])) return null;
  const model = createPersistentLayoutModel(current.model.columns.map((column) => column.blocks), widths);
  return model ? replaceLayout(state, target, model) : null;
}

export function createPersistentLayoutOrderTransaction(
  state: EditorState,
  target: PersistentLayoutTarget,
  action: PersistentLayoutOrderAction,
): Transaction | null {
  const current = guardedLayout(state, target);
  if (!current) return null;
  const columns = current.model.columns.map((column) => column.blocks);
  const widths = [...current.model.widths];
  if (action === "previous") {
    columns.unshift(columns.pop()!); widths.unshift(widths.pop()!);
  } else {
    columns.push(columns.shift()!); widths.push(widths.shift()!);
  }
  const model = createPersistentLayoutModel(columns, widths);
  return model ? replaceLayout(state, target, model) : null;
}

export function analyzePersistentLayoutDowngrade(model: PersistentLayoutModel): PersistentLayoutDowngradeLoss[] | null {
  if (!validatePersistentLayoutModel(model)) return null;
  const losses: PersistentLayoutDowngradeLoss[] = ["column-structure"];
  const equal = equalWidths(model.columns.length);
  if (model.widths.some((width, index) => width !== equal[index])) losses.push("column-widths");
  return losses;
}

export function createPersistentLayoutDowngradeTransaction(
  state: EditorState,
  target: PersistentLayoutTarget,
): Transaction | null {
  const current = guardedLayout(state, target);
  if (!current) return null;
  const blocks = linearizePersistentLayout(current.model);
  if (!blocks?.length) return null;
  try {
    const nodes: ProseNode[] = [];
    for (const block of blocks) {
      if (block.kind === "image") {
        const template = document.createElement("template");
        template.innerHTML = block.html;
        const figure = template.content.firstElementChild;
        const image = figure?.querySelector("img");
        const imageType = state.schema.nodes["image-block"];
        if (!(figure instanceof HTMLElement) || !(image instanceof HTMLImageElement) || !imageType) return null;
        const ratio = Number(figure.getAttribute("data-omia-ratio") ?? 1);
        nodes.push(imageType.create({
          src: image.getAttribute("src") ?? "",
          caption: image.getAttribute("alt") ?? image.getAttribute("title") ?? "",
          ratio,
        }));
        continue;
      }
      const wrapper = document.createElement("div");
      wrapper.innerHTML = block.html;
      const slice = ProseDOMParser.fromSchema(state.schema).parseSlice(wrapper, { preserveWhitespace: true });
      slice.content.forEach((node) => nodes.push(node));
    }
    if (!nodes.length) return null;
    return state.tr.replaceWith(target.pos, target.pos + target.nodeSize, Fragment.fromArray(nodes));
  } catch {
    return null;
  }
}

export function resolvePersistentLayoutView(model: PersistentLayoutModel, viewportWidth: number): {
  stacked: boolean;
  widths: readonly number[];
  readingOrder: readonly string[];
} {
  if (!validatePersistentLayoutModel(model) || !Number.isFinite(viewportWidth) || viewportWidth <= 0) throw new Error("Invalid layout view input");
  return {
    stacked: viewportWidth < 680,
    widths: [...model.widths],
    readingOrder: model.columns.flatMap((column) => column.blocks.map((block) => block.html)),
  };
}
