import type { Node as ProseNode } from "@milkdown/kit/prose/model";
import type { EditorState, Transaction } from "@milkdown/kit/prose/state";
export {
  analyzeAdvancedTableDowngrade,
  analyzeAdvancedTableUpgrade,
  createAdvancedTableDowngradeTransaction,
  createAdvancedTableUpgradeTransaction,
} from "./advancedTableModel";

export type PortableTableAction =
  | "row-before" | "row-after" | "delete-row"
  | "column-before" | "column-after" | "delete-column"
  | "align-left" | "align-center" | "align-right";

export type PortableTableTarget = {
  pos: number;
  nodeSize: number;
  row: number;
  column: number;
};

export type PortableTableContext = {
  row: number;
  column: number;
  rowCount: number;
  columnCount: number;
  rowKind: "header" | "body";
  alignment: string | null;
  canInsertRowBefore: boolean;
  canDeleteRow: boolean;
  canDeleteColumn: boolean;
};

function children(node: ProseNode): ProseNode[] {
  const result: ProseNode[] = [];
  node.forEach((child) => result.push(child));
  return result;
}

function rebuilt(node: ProseNode, nextChildren: readonly ProseNode[]): ProseNode {
  return node.type.create(node.attrs, nextChildren, node.marks);
}

function emptyCellLike(cell: ProseNode, alignment: unknown): ProseNode | null {
  return cell.type.createAndFill({ ...cell.attrs, alignment });
}

export function resolvePortableTableContext(
  state: EditorState,
  target: PortableTableTarget,
): PortableTableContext | null {
  const table = state.doc.nodeAt(target.pos);
  if (!table || table.type.name !== "table" || table.nodeSize !== target.nodeSize || table.childCount < 2) return null;
  const rows = children(table);
  const width = rows[0]?.childCount ?? 0;
  if (!width || rows.some((row) => row.childCount !== width)) return null;
  if (target.row < 0 || target.row >= rows.length || target.column < 0 || target.column >= width) return null;
  const alignment = rows[0]?.child(target.column).attrs.alignment;
  return {
    row: target.row,
    column: target.column,
    rowCount: rows.length,
    columnCount: width,
    rowKind: target.row === 0 ? "header" : "body",
    alignment: typeof alignment === "string" ? alignment : null,
    canInsertRowBefore: target.row > 0,
    canDeleteRow: target.row > 0 && rows.length > 2,
    canDeleteColumn: width > 1,
  };
}

export function editPortableTable(
  state: EditorState,
  target: PortableTableTarget,
  action: PortableTableAction,
): Transaction | null {
  const table = state.doc.nodeAt(target.pos);
  if (!table || table.type.name !== "table" || table.nodeSize !== target.nodeSize || table.childCount < 2) return null;
  const rows = children(table);
  const width = rows[0]?.childCount ?? 0;
  if (!width || rows.some((row) => row.childCount !== width)) return null;
  if (target.row < 0 || target.row >= rows.length || target.column < 0 || target.column >= width) return null;

  let nextRows = rows;
  if (action === "row-before" || action === "row-after") {
    if (action === "row-before" && target.row === 0) return null;
    const bodyTemplate = rows[Math.max(1, Math.min(target.row, rows.length - 1))];
    const header = rows[0];
    const nextCells: ProseNode[] = [];
    for (let column = 0; column < width; column++) {
      const template = bodyTemplate.child(Math.min(column, bodyTemplate.childCount - 1));
      const cell = emptyCellLike(template, header.child(column).attrs.alignment);
      if (!cell) return null;
      nextCells.push(cell);
    }
    const row = rebuilt(bodyTemplate, nextCells);
    const insertAt = action === "row-before" ? target.row : target.row + 1;
    nextRows = [...rows.slice(0, insertAt), row, ...rows.slice(insertAt)];
  } else if (action === "delete-row") {
    if (target.row === 0 || rows.length <= 2) return null;
    nextRows = rows.filter((_row, index) => index !== target.row);
  } else if (action === "column-before" || action === "column-after") {
    const insertAt = action === "column-before" ? target.column : target.column + 1;
    const alignment = rows[0].child(target.column).attrs.alignment;
    const rebuiltRows: ProseNode[] = [];
    for (const row of rows) {
      const rowCells = children(row);
      const template = row.child(target.column);
      const cell = emptyCellLike(template, alignment);
      if (!cell) return null;
      rebuiltRows.push(rebuilt(row, [...rowCells.slice(0, insertAt), cell, ...rowCells.slice(insertAt)]));
    }
    nextRows = rebuiltRows;
  } else if (action === "delete-column") {
    if (width <= 1) return null;
    nextRows = rows.map((row) => rebuilt(row, children(row).filter((_cell, index) => index !== target.column)));
  } else {
    const alignment = action === "align-left" ? "left" : action === "align-center" ? "center" : "right";
    nextRows = rows.map((row) => rebuilt(row, children(row).map((cell, index) => (
      index === target.column ? cell.type.create({ ...cell.attrs, alignment }, cell.content, cell.marks) : cell
    ))));
  }

  const replacement = rebuilt(table, nextRows);
  return state.tr.replaceWith(target.pos, target.pos + target.nodeSize, replacement);
}

export function applyTableCellSelection(
  table: HTMLElement,
  row: number,
  column: number,
  selected: boolean,
  label: string,
): HTMLElement | null {
  const rows = Array.from(table.querySelectorAll<HTMLElement>("tr"));
  const cell = rows[row]?.querySelectorAll<HTMLElement>("th, td")[column] ?? null;
  if (!cell) return null;
  cell.classList.toggle("omia-table-cell-selected", selected);
  if (selected) {
    cell.setAttribute("aria-current", "true");
    cell.setAttribute("aria-label", label);
  } else {
    cell.removeAttribute("aria-current");
    cell.removeAttribute("aria-label");
  }
  return cell;
}
