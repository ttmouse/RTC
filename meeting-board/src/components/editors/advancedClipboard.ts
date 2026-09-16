import type { Fragment, Node as ProseNode } from "@milkdown/kit/prose/model";
import type { Slice } from "@milkdown/kit/prose/model";
import { Plugin } from "@milkdown/kit/prose/state";
import { $prose } from "@milkdown/kit/utils";
import {
  ADVANCED_TABLE_NODE_NAME,
  validateAdvancedTableModel,
  type AdvancedTableBlock,
  type AdvancedTableModel,
} from "./advancedTableModel";
import {
  PERSISTENT_LAYOUT_NODE_NAME,
  validatePersistentLayoutModel,
  type PersistentLayoutBlock,
  type PersistentLayoutModel,
} from "./layoutModel";

function controlledBlockText(block: AdvancedTableBlock | PersistentLayoutBlock): string {
  const template = document.createElement("template");
  template.innerHTML = block.html;
  return (template.content.textContent ?? "").replace(/\s+/g, " ").trim();
}

export function advancedTableClipboardText(model: AdvancedTableModel): string {
  if (!validateAdvancedTableModel(model)) return "";
  return [...model.head, ...model.body].map((row) => row.cells.map((cell) => (
    cell.blocks.map(controlledBlockText).filter(Boolean).join(" / ")
  )).join("\t")).join("\n");
}

export function persistentLayoutClipboardText(model: PersistentLayoutModel): string {
  if (!validatePersistentLayoutModel(model)) return "";
  // 文件契约的确定阅读顺序：左列到右列，每列从上到下。外部纯文本不携带
  // widths、DOM 坐标、选择态或拖动句柄等 Omia 私有视图状态。
  return model.columns.map((column) => column.blocks
    .map((block) => block.kind === "advanced-table"
      ? (() => {
          const template = document.createElement("template");
          template.innerHTML = block.html;
          return (template.content.textContent ?? "").replace(/\s+/g, " ").trim();
        })()
      : controlledBlockText(block))
    .filter(Boolean)
    .join("\n"))
    .filter(Boolean)
    .join("\n\n");
}

function proseNodeClipboardText(node: ProseNode): string {
  if (node.isText) return node.text ?? "";
  if (node.type.name === ADVANCED_TABLE_NODE_NAME) {
    return advancedTableClipboardText(node.attrs.model as AdvancedTableModel);
  }
  if (node.type.name === PERSISTENT_LAYOUT_NODE_NAME) {
    return persistentLayoutClipboardText(node.attrs.model as PersistentLayoutModel);
  }
  if (node.type.name === "hardbreak" || node.type.name === "hard_break") return "\n";

  const children: string[] = [];
  node.forEach((child) => children.push(proseNodeClipboardText(child)));
  const name = node.type.name;
  if (name === "table" || name === "table_header_row" || name === "table_row") {
    return children.filter(Boolean).join(name === "table" ? "\n" : "\t");
  }
  if (name === "table_header" || name === "table_cell") return children.join("");
  if (name.includes("list")) return children.filter(Boolean).join("\n");
  return children.join("");
}

export function advancedClipboardPlainText(fragment: Fragment): string {
  const blocks: string[] = [];
  fragment.forEach((node) => {
    const text = proseNodeClipboardText(node).trimEnd();
    if (text) blocks.push(text);
  });
  return blocks.join("\n\n");
}

export function createAdvancedClipboardPlugin(): Plugin {
  return new Plugin({
    props: {
      clipboardTextSerializer(slice: Slice) {
        return advancedClipboardPlainText(slice.content);
      },
    },
  });
}

export const advancedClipboardPlugin = $prose(() => createAdvancedClipboardPlugin());
