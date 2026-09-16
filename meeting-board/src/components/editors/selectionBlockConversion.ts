import { Fragment, type Node as ProseNode, type Schema } from "@milkdown/kit/prose/model";
import { TextSelection, type EditorState, type Transaction } from "@milkdown/kit/prose/state";
import {
  resolveBlockEntryDescriptor,
  type BlockEntryType,
  type ConvertibleBlockType,
} from "./blockUi";
import type { SelectionBlockSample } from "./selectionToolbar";
import { pageTitleIndex } from "./pageTitle";
import { CONTROLLED_ALIGNED_PARAGRAPH_NAME } from "./controlledBlockPlugin";

type InlineSource = { content: ProseNode["content"]; text: string };

function collectInlineSources(node: ProseNode): InlineSource[] {
  if (node.isTextblock) return [{ content: node.content, text: node.textContent }];
  const result: InlineSource[] = [];
  node.forEach((child, _offset, index) => {
    if (node.type.name === "blockquote" && index === 0 && /^\[!(?:note|tip|important|warning|caution)\]$/i.test(child.textContent.trim())) return;
    result.push(...collectInlineSources(child));
  });
  return result.length > 0 ? result : [{ content: Fragment.empty, text: node.textContent }];
}

function requireNode(schema: Schema, name: string) {
  const node = schema.nodes[name];
  if (!node) throw new Error(`Missing schema node: ${name}`);
  return node;
}

function paragraph(schema: Schema, source: InlineSource): ProseNode {
  return requireNode(schema, "paragraph").create(null, source.content);
}

function buildReplacementNodes(schema: Schema, sources: InlineSource[], target: ConvertibleBlockType): ProseNode[] {
  if (target === "text") return sources.map((source) => paragraph(schema, source));
  if (/^h[1-6]$/.test(target)) {
    const level = Number(target.slice(1));
    return sources.map((source) => requireNode(schema, "heading").create({ level }, source.content));
  }
  if (target === "code") {
    const code = requireNode(schema, "code_block");
    return sources.map((source) => code.create(null, source.text ? schema.text(source.text) : undefined));
  }
  if (target === "quote") {
    return [requireNode(schema, "blockquote").createChecked(null, sources.map((source) => paragraph(schema, source)))];
  }
  if (target === "callout") {
    const marker = requireNode(schema, "paragraph").create(null, schema.text("[!NOTE]"));
    return [requireNode(schema, "blockquote").createChecked(null, [marker, ...sources.map((source) => paragraph(schema, source))])];
  }
  const list = requireNode(schema, target === "ordered" ? "ordered_list" : "bullet_list");
  const item = requireNode(schema, "list_item");
  const itemAttrs = target === "todo" ? { checked: false } : null;
  const items = sources.map((source) => item.createAndFill(itemAttrs, paragraph(schema, source)));
  if (items.some((node) => !node)) throw new Error("List item conversion is unavailable");
  return [list.createAndFill(null, items as ProseNode[])!];
}

export function topLevelIndexesForSelection(state: EditorState, protectFirstBlock = false): number[] {
  const { from, to } = state.selection;
  const indexes: number[] = [];
  state.doc.forEach((node, offset, index) => {
    const contentFrom = offset + 1;
    const contentTo = offset + node.nodeSize - 1;
    if (to < contentFrom || from > contentTo || (protectFirstBlock && index === 0)) return;
    indexes.push(index);
  });
  return indexes;
}

function blockEntryType(node: ProseNode): BlockEntryType {
  if (node.type.name === CONTROLLED_ALIGNED_PARAGRAPH_NAME) return "text";
  if (node.type.name === "bullet_list") {
    let hasTaskItem = false;
    node.descendants((child) => {
      if (child.type.name === "list_item" && typeof child.attrs.checked === "boolean") hasTaskItem = true;
      return !hasTaskItem;
    });
    if (hasTaskItem) return "todo";
  }
  return resolveBlockEntryDescriptor({
    nodeName: node.type.name,
    headingLevel: Number(node.attrs.level ?? 1),
    textContent: node.textContent,
  }, "en").id;
}

export function selectionBlockSamplesForState(state: EditorState, protectFirstBlock = false): SelectionBlockSample[] {
  const selected = new Set(topLevelIndexesForSelection(state, false));
  const titleIndex = pageTitleIndex(state.doc);
  const samples: SelectionBlockSample[] = [];
  state.doc.forEach((node, _offset, index) => {
    if (!selected.has(index)) return;
    samples.push({
      type: blockEntryType(node),
      topLevelIndex: index,
      protected: index === titleIndex || (protectFirstBlock && index === 0),
    });
  });
  return samples;
}

export function createSelectionBlockConversionTransaction(
  state: EditorState,
  indexes: readonly number[],
  target: ConvertibleBlockType,
): Transaction | null {
  if (indexes.length === 0) return null;
  const blocks: Array<{ index: number; pos: number; node: ProseNode }> = [];
  state.doc.forEach((node, pos, index) => {
    if (indexes.includes(index)) blocks.push({ index, pos, node });
  });
  if (blocks.length !== indexes.length) return null;
  blocks.sort((a, b) => a.index - b.index);
  if (blocks.some((block, index) => index > 0 && block.index !== blocks[index - 1]!.index + 1)) return null;
  const sources = blocks.flatMap(({ node }) => collectInlineSources(node));
  const replacements = buildReplacementNodes(state.schema, sources, target);
  const from = blocks[0]!.pos;
  const last = blocks[blocks.length - 1]!;
  const to = last.pos + last.node.nodeSize;
  let transaction = state.tr.replaceWith(from, to, Fragment.fromArray(replacements));
  transaction = transaction.setSelection(TextSelection.near(transaction.doc.resolve(Math.min(from + 1, transaction.doc.content.size))));
  return transaction.scrollIntoView();
}
