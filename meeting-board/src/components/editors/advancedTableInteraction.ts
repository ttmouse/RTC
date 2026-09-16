import type { EditorState, Transaction } from "@milkdown/kit/prose/state";
import { closeHistory } from "@milkdown/kit/prose/history";
import { isControlledColorToken, type ControlledColorToken } from "../../lib/controlledInlineFormat";
import {
  ADVANCED_TABLE_NODE_NAME,
  validateAdvancedTableModel,
  type AdvancedTableModel,
  type AdvancedTableCell,
  type AdvancedTableBlock,
  type AdvancedTableRow,
  type AdvancedTableTarget,
} from "./advancedTableModel";

/** Advanced-table widths are persisted as positive integer basis points. */
export const ADVANCED_TABLE_WIDTH_TOTAL = 10_000;
export const ADVANCED_TABLE_MIN_COLUMN_BPS = 1;

/** A view concern only: narrow windows scroll instead of rewriting the model. */
export const ADVANCED_TABLE_MIN_COLUMN_PX = 96;
export const ADVANCED_TABLE_KEYBOARD_STEP_BPS = 250;

export type AdvancedTableWidthLayout = {
  tableWidthPx: number;
  columnWidthsPx: number[];
  overflow: boolean;
};

export type AdvancedTableSection = "head" | "body";
export type AdvancedTableCellCoordinate = {
  section: AdvancedTableSection;
  row: number;
  column: number;
};
export type AdvancedTableCellAnchorCoordinate = AdvancedTableCellCoordinate & {
  cellIndex: number;
  colspan: number;
  rowspan: number;
};
export type AdvancedTableSelectionRect = {
  section: AdvancedTableSection;
  top: number;
  left: number;
  bottom: number;
  right: number;
};
export type AdvancedTableMergeFailure =
  | "invalid-model"
  | "empty-selection"
  | "invalid-selection"
  | "cross-section"
  | "non-rectangular"
  | "partial-span"
  | "single-cell";

type GridAnchor = {
  row: number;
  column: number;
  cell: AdvancedTableCell;
};

type SectionGrid = {
  rows: AdvancedTableRow[];
  slots: GridAnchor[][];
  anchors: GridAnchor[];
};

export type AdvancedTableMergeAnalysis =
  | { ok: true; rect: AdvancedTableSelectionRect; anchors: GridAnchor[] }
  | { ok: false; reason: AdvancedTableMergeFailure };

export type AdvancedTableCellBlockOperation =
  | { type: "insert"; index: number; block: AdvancedTableBlock }
  | { type: "replace"; index: number; block: AdvancedTableBlock }
  | { type: "move"; from: number; to: number };

function isAdvancedTableWidthVector(widths: readonly number[]): boolean {
  return widths.length > 0
    && widths.length <= 100
    && widths.every((width) => Number.isInteger(width) && width >= ADVANCED_TABLE_MIN_COLUMN_BPS)
    && widths.reduce((sum, width) => sum + width, 0) === ADVANCED_TABLE_WIDTH_TOTAL;
}

function buildSectionGrid(model: AdvancedTableModel, section: AdvancedTableSection): SectionGrid | null {
  const rows = model[section];
  const slots = Array.from({ length: rows.length }, () => Array<GridAnchor | undefined>(model.widths.length));
  const anchors: GridAnchor[] = [];
  for (let row = 0; row < rows.length; row++) {
    let column = 0;
    for (const cell of rows[row].cells) {
      while (column < model.widths.length && slots[row][column]) column++;
      if (column >= model.widths.length) return null;
      const anchor = { row, column, cell };
      anchors.push(anchor);
      for (let y = row; y < row + cell.rowspan; y++) {
        for (let x = column; x < column + cell.colspan; x++) {
          if (!slots[y] || slots[y][x]) return null;
          slots[y][x] = anchor;
        }
      }
      column += cell.colspan;
    }
  }
  if (slots.some((row) => row.some((slot) => !slot))) return null;
  return { rows, slots: slots as GridAnchor[][], anchors };
}

export function listAdvancedTableCellAnchors(
  model: AdvancedTableModel,
  section: AdvancedTableSection,
): AdvancedTableCellAnchorCoordinate[] {
  if (!validateAdvancedTableModel(model)) return [];
  const grid = buildSectionGrid(model, section);
  if (!grid) return [];
  return grid.anchors.map((anchor) => ({
    section,
    row: anchor.row,
    column: anchor.column,
    cellIndex: grid.rows[anchor.row].cells.indexOf(anchor.cell),
    colspan: anchor.cell.colspan,
    rowspan: anchor.cell.rowspan,
  }));
}

function coordinateKey(row: number, column: number): string {
  return `${row}:${column}`;
}

export function analyzeAdvancedTableMerge(
  model: AdvancedTableModel,
  selection: readonly AdvancedTableCellCoordinate[],
): AdvancedTableMergeAnalysis {
  if (!validateAdvancedTableModel(model)) return { ok: false, reason: "invalid-model" };
  if (selection.length === 0) return { ok: false, reason: "empty-selection" };
  const sections = new Set(selection.map(({ section }) => section));
  if (sections.size !== 1) return { ok: false, reason: "cross-section" };
  const section = selection[0].section;
  if (section !== "head" && section !== "body") return { ok: false, reason: "invalid-selection" };
  const grid = buildSectionGrid(model, section);
  if (!grid) return { ok: false, reason: "invalid-model" };

  const selected = new Map<string, AdvancedTableCellCoordinate>();
  for (const coordinate of selection) {
    if (!Number.isInteger(coordinate.row)
      || !Number.isInteger(coordinate.column)
      || coordinate.row < 0
      || coordinate.row >= grid.slots.length
      || coordinate.column < 0
      || coordinate.column >= model.widths.length) return { ok: false, reason: "invalid-selection" };
    selected.set(coordinateKey(coordinate.row, coordinate.column), coordinate);
  }
  const coordinates = [...selected.values()];
  const top = Math.min(...coordinates.map(({ row }) => row));
  const bottom = Math.max(...coordinates.map(({ row }) => row));
  const left = Math.min(...coordinates.map(({ column }) => column));
  const right = Math.max(...coordinates.map(({ column }) => column));
  if (coordinates.length !== (bottom - top + 1) * (right - left + 1)) {
    return { ok: false, reason: "non-rectangular" };
  }
  for (let row = top; row <= bottom; row++) {
    for (let column = left; column <= right; column++) {
      if (!selected.has(coordinateKey(row, column))) return { ok: false, reason: "non-rectangular" };
    }
  }

  const selectedAnchors = [...new Set(coordinates.map(({ row, column }) => grid.slots[row][column]))]
    .sort((a, b) => a.row - b.row || a.column - b.column);
  for (const anchor of selectedAnchors) {
    for (let row = anchor.row; row < anchor.row + anchor.cell.rowspan; row++) {
      for (let column = anchor.column; column < anchor.column + anchor.cell.colspan; column++) {
        if (!selected.has(coordinateKey(row, column))) return { ok: false, reason: "partial-span" };
      }
    }
  }
  if (selectedAnchors.length < 2) return { ok: false, reason: "single-cell" };
  return { ok: true, rect: { section, top, left, bottom, right }, anchors: selectedAnchors };
}

function rebuildRows(
  rowCount: number,
  anchors: readonly GridAnchor[],
): AdvancedTableRow[] {
  return Array.from({ length: rowCount }, (_unused, row) => ({
    cells: anchors
      .filter((anchor) => anchor.row === row)
      .sort((left, right) => left.column - right.column)
      .map((anchor) => anchor.cell),
  }));
}

export function mergeAdvancedTableCells(
  model: AdvancedTableModel,
  selection: readonly AdvancedTableCellCoordinate[],
): AdvancedTableModel | null {
  const analysis = analyzeAdvancedTableMerge(model, selection);
  if (!analysis.ok) return null;
  const grid = buildSectionGrid(model, analysis.rect.section);
  if (!grid) return null;
  const selected = new Set(analysis.anchors.map((anchor) => coordinateKey(anchor.row, anchor.column)));
  const firstBackground = analysis.anchors[0].cell.background;
  const keepBackground = analysis.anchors.every((anchor) => anchor.cell.background === firstBackground);
  const mergedCell: AdvancedTableCell = {
    colspan: analysis.rect.right - analysis.rect.left + 1,
    rowspan: analysis.rect.bottom - analysis.rect.top + 1,
    ...(keepBackground && firstBackground ? { background: firstBackground } : {}),
    blocks: analysis.anchors.flatMap((anchor) => anchor.cell.blocks),
  };
  const anchors = grid.anchors.filter((anchor) => !selected.has(coordinateKey(anchor.row, anchor.column)));
  anchors.push({ row: analysis.rect.top, column: analysis.rect.left, cell: mergedCell });
  const next: AdvancedTableModel = {
    ...model,
    [analysis.rect.section]: rebuildRows(grid.rows.length, anchors),
  };
  return validateAdvancedTableModel(next) ? next : null;
}

export function splitAdvancedTableCell(
  model: AdvancedTableModel,
  coordinate: AdvancedTableCellCoordinate,
): AdvancedTableModel | null {
  if (!validateAdvancedTableModel(model)
    || (coordinate.section !== "head" && coordinate.section !== "body")
    || !Number.isInteger(coordinate.row)
    || !Number.isInteger(coordinate.column)) return null;
  const grid = buildSectionGrid(model, coordinate.section);
  const anchor = grid?.slots[coordinate.row]?.[coordinate.column];
  if (!grid || !anchor || (anchor.cell.colspan === 1 && anchor.cell.rowspan === 1)) return null;

  const anchors = grid.anchors.filter((candidate) => candidate !== anchor);
  for (let row = anchor.row; row < anchor.row + anchor.cell.rowspan; row++) {
    for (let column = anchor.column; column < anchor.column + anchor.cell.colspan; column++) {
      const isOrigin = row === anchor.row && column === anchor.column;
      anchors.push({
        row,
        column,
        cell: {
          colspan: 1,
          rowspan: 1,
          ...(anchor.cell.background ? { background: anchor.cell.background } : {}),
          blocks: isOrigin ? anchor.cell.blocks : [{ kind: "paragraph", html: "<p></p>" }],
        },
      });
    }
  }
  const next: AdvancedTableModel = {
    ...model,
    [coordinate.section]: rebuildRows(grid.rows.length, anchors),
  };
  return validateAdvancedTableModel(next) ? next : null;
}

function updateAdvancedTableCell(
  model: AdvancedTableModel,
  section: AdvancedTableSection,
  row: number,
  column: number,
  transform: (cell: AdvancedTableCell) => AdvancedTableCell | null,
): AdvancedTableModel | null {
  if (section !== "head" && section !== "body") return null;
  const grid = buildSectionGrid(model, section);
  const anchor = grid?.slots[row]?.[column];
  if (!grid || !anchor) return null;
  const cellIndex = grid.rows[anchor.row].cells.indexOf(anchor.cell);
  if (cellIndex < 0) return null;
  const cell = transform(anchor.cell);
  if (!cell) return null;
  const rows = grid.rows.map((current, index) => index === anchor.row
    ? { cells: current.cells.map((candidate, candidateIndex) => candidateIndex === cellIndex ? cell : candidate) }
    : current);
  const next: AdvancedTableModel = { ...model, [section]: rows };
  return validateAdvancedTableModel(next) ? next : null;
}

export function readAdvancedTableCell(
  model: AdvancedTableModel,
  coordinate: AdvancedTableCellCoordinate,
): AdvancedTableCell | null {
  if (!validateAdvancedTableModel(model)
    || (coordinate.section !== "head" && coordinate.section !== "body")
    || !Number.isInteger(coordinate.row)
    || !Number.isInteger(coordinate.column)) return null;
  return buildSectionGrid(model, coordinate.section)?.slots[coordinate.row]?.[coordinate.column]?.cell ?? null;
}

export function setAdvancedTableCellsBackground(
  model: AdvancedTableModel,
  coordinates: readonly AdvancedTableCellCoordinate[],
  token: ControlledColorToken | null,
): AdvancedTableModel | null {
  if (!validateAdvancedTableModel(model)
    || coordinates.length === 0
    || (token !== null && !isControlledColorToken(token))) return null;
  const anchors = new Map<string, { section: AdvancedTableSection; row: number; column: number }>();
  for (const coordinate of coordinates) {
    if ((coordinate.section !== "head" && coordinate.section !== "body")
      || !Number.isInteger(coordinate.row)
      || !Number.isInteger(coordinate.column)) return null;
    const grid = buildSectionGrid(model, coordinate.section);
    const anchor = grid?.slots[coordinate.row]?.[coordinate.column];
    if (!anchor) return null;
    const key = `${coordinate.section}:${anchor.row}:${anchor.column}`;
    anchors.set(key, { section: coordinate.section, row: anchor.row, column: anchor.column });
  }
  let next = model;
  let changed = false;
  for (const anchor of anchors.values()) {
    const updated = updateAdvancedTableCell(next, anchor.section, anchor.row, anchor.column, (cell) => {
      if (cell.background === (token ?? undefined)) return cell;
      changed = true;
      const { background: _background, ...rest } = cell;
      return { ...rest, ...(token ? { background: token } : {}) };
    });
    if (!updated) return null;
    next = updated;
  }
  return changed ? next : null;
}

export function insertAdvancedTableCellBlock(
  model: AdvancedTableModel,
  coordinate: AdvancedTableCellCoordinate,
  index: number,
  block: AdvancedTableBlock,
): AdvancedTableModel | null {
  if (!Number.isInteger(index) || !block || typeof block.kind !== "string" || typeof block.html !== "string") return null;
  return updateAdvancedTableCell(model, coordinate.section, coordinate.row, coordinate.column, (cell) => {
    if (index < 0 || index > cell.blocks.length) return null;
    const blocks = [...cell.blocks];
    blocks.splice(index, 0, block);
    return { ...cell, blocks };
  });
}

export function moveAdvancedTableCellBlock(
  model: AdvancedTableModel,
  coordinate: AdvancedTableCellCoordinate,
  from: number,
  to: number,
): AdvancedTableModel | null {
  if (!Number.isInteger(from) || !Number.isInteger(to) || from === to) return null;
  return updateAdvancedTableCell(model, coordinate.section, coordinate.row, coordinate.column, (cell) => {
    if (from < 0 || from >= cell.blocks.length || to < 0 || to >= cell.blocks.length) return null;
    const blocks = [...cell.blocks];
    const [block] = blocks.splice(from, 1);
    blocks.splice(to, 0, block);
    return { ...cell, blocks };
  });
}

export function replaceAdvancedTableCellBlock(
  model: AdvancedTableModel,
  coordinate: AdvancedTableCellCoordinate,
  index: number,
  block: AdvancedTableBlock,
): AdvancedTableModel | null {
  if (!Number.isInteger(index) || !block || typeof block.kind !== "string" || typeof block.html !== "string") return null;
  return updateAdvancedTableCell(model, coordinate.section, coordinate.row, coordinate.column, (cell) => {
    if (index < 0 || index >= cell.blocks.length) return null;
    const blocks = [...cell.blocks];
    blocks[index] = block;
    return { ...cell, blocks };
  });
}

/**
 * Moves one logical boundary. Only the two adjacent columns change, their
 * combined width stays exact, and either column clamps at one basis point.
 */
export function resizeAdvancedTableBoundary(
  widths: readonly number[],
  boundaryIndex: number,
  deltaBasisPoints: number,
): number[] | null {
  if (!isAdvancedTableWidthVector(widths)
    || !Number.isInteger(boundaryIndex)
    || boundaryIndex < 0
    || boundaryIndex >= widths.length - 1
    || !Number.isFinite(deltaBasisPoints)) return null;

  const delta = Math.trunc(deltaBasisPoints);
  const pairTotal = widths[boundaryIndex] + widths[boundaryIndex + 1];
  const left = Math.max(
    ADVANCED_TABLE_MIN_COLUMN_BPS,
    Math.min(pairTotal - ADVANCED_TABLE_MIN_COLUMN_BPS, widths[boundaryIndex] + delta),
  );
  const next = [...widths];
  next[boundaryIndex] = left;
  next[boundaryIndex + 1] = pairTotal - left;
  return next;
}

/**
 * Resolves persisted weights into an exact integer-pixel layout. Every column
 * receives its physical minimum first; remaining pixels use largest-remainder
 * apportionment, so the result is deterministic and sums to the table width.
 */
export function resolveAdvancedTableWidthLayout(
  widths: readonly number[],
  viewportWidthPx: number,
): AdvancedTableWidthLayout {
  if (!isAdvancedTableWidthVector(widths)) throw new Error("Invalid advanced table widths");
  if (!Number.isFinite(viewportWidthPx) || viewportWidthPx <= 0) throw new Error("Invalid advanced table viewport");

  const viewport = Math.max(1, Math.floor(viewportWidthPx));
  const physicalMinimum = widths.length * ADVANCED_TABLE_MIN_COLUMN_PX;
  const tableWidthPx = Math.max(viewport, physicalMinimum);
  const distributable = tableWidthPx - physicalMinimum;
  const exactShares = widths.map((width) => distributable * width / ADVANCED_TABLE_WIDTH_TOTAL);
  const allocated = exactShares.map(Math.floor);
  let remainder = distributable - allocated.reduce((sum, width) => sum + width, 0);
  const priority = exactShares
    .map((value, index) => ({ index, fraction: value - allocated[index] }))
    .sort((left, right) => right.fraction - left.fraction || left.index - right.index);
  for (let index = 0; index < remainder; index++) allocated[priority[index].index] += 1;
  remainder = 0;

  return {
    tableWidthPx,
    columnWidthsPx: allocated.map((width) => width + ADVANCED_TABLE_MIN_COLUMN_PX),
    overflow: tableWidthPx > viewport,
  };
}

export function advancedTablePointerDeltaToBasisPoints(
  deltaPx: number,
  tableWidthPx: number,
): number | null {
  if (!Number.isFinite(deltaPx) || !Number.isFinite(tableWidthPx) || tableWidthPx <= 0) return null;
  return Math.round(deltaPx * ADVANCED_TABLE_WIDTH_TOTAL / tableWidthPx);
}

function resolveAdvancedResizeTarget(
  state: EditorState,
  target: AdvancedTableTarget,
): { model: AdvancedTableModel; nodeType: NonNullable<typeof state.schema.nodes[string]> } | null {
  const node = state.doc.nodeAt(target.pos);
  if (!node
    || node.nodeSize !== target.nodeSize
    || node.type.name !== ADVANCED_TABLE_NODE_NAME
    || !validateAdvancedTableModel(node.attrs.model)) return null;
  return { model: node.attrs.model as AdvancedTableModel, nodeType: node.type };
}

/** Creates the only persisted step for a completed pointer resize. */
export function createAdvancedTableResizeTransaction(
  state: EditorState,
  target: AdvancedTableTarget,
  boundaryIndex: number,
  deltaBasisPoints: number,
): Transaction | null {
  const resolved = resolveAdvancedResizeTarget(state, target);
  if (!resolved) return null;
  const widths = resizeAdvancedTableBoundary(resolved.model.widths, boundaryIndex, deltaBasisPoints);
  if (!widths || widths.every((width, index) => width === resolved.model.widths[index])) return null;
  const nextModel: AdvancedTableModel = { ...resolved.model, widths };
  if (!validateAdvancedTableModel(nextModel)) return null;
  return closeHistory(state.tr.setNodeMarkup(target.pos, resolved.nodeType, { model: nextModel }));
}

export function createAdvancedTableKeyboardResizeTransaction(
  state: EditorState,
  target: AdvancedTableTarget,
  boundaryIndex: number,
  key: string,
): Transaction | null {
  const delta = key === "ArrowLeft"
    ? -ADVANCED_TABLE_KEYBOARD_STEP_BPS
    : key === "ArrowRight"
      ? ADVANCED_TABLE_KEYBOARD_STEP_BPS
      : null;
  return delta == null ? null : createAdvancedTableResizeTransaction(state, target, boundaryIndex, delta);
}

function replaceAdvancedTableModel(
  state: EditorState,
  target: AdvancedTableTarget,
  transform: (model: AdvancedTableModel) => AdvancedTableModel | null,
): Transaction | null {
  const resolved = resolveAdvancedResizeTarget(state, target);
  if (!resolved) return null;
  const nextModel = transform(resolved.model);
  if (!nextModel || !validateAdvancedTableModel(nextModel)) return null;
  return closeHistory(state.tr.setNodeMarkup(target.pos, resolved.nodeType, { model: nextModel }));
}

export function createAdvancedTableMergeTransaction(
  state: EditorState,
  target: AdvancedTableTarget,
  selection: readonly AdvancedTableCellCoordinate[],
): Transaction | null {
  return replaceAdvancedTableModel(state, target, (model) => mergeAdvancedTableCells(model, selection));
}

export function createAdvancedTableSplitTransaction(
  state: EditorState,
  target: AdvancedTableTarget,
  coordinate: AdvancedTableCellCoordinate,
): Transaction | null {
  return replaceAdvancedTableModel(state, target, (model) => splitAdvancedTableCell(model, coordinate));
}

export function createAdvancedTableCellBackgroundTransaction(
  state: EditorState,
  target: AdvancedTableTarget,
  coordinates: readonly AdvancedTableCellCoordinate[],
  token: ControlledColorToken | null,
): Transaction | null {
  return replaceAdvancedTableModel(state, target, (model) => setAdvancedTableCellsBackground(model, coordinates, token));
}

export function createAdvancedTableCellBlockTransaction(
  state: EditorState,
  target: AdvancedTableTarget,
  coordinate: AdvancedTableCellCoordinate,
  operation: AdvancedTableCellBlockOperation,
): Transaction | null {
  return replaceAdvancedTableModel(state, target, (model) => operation.type === "insert"
    ? insertAdvancedTableCellBlock(model, coordinate, operation.index, operation.block)
    : operation.type === "replace"
      ? replaceAdvancedTableCellBlock(model, coordinate, operation.index, operation.block)
      : moveAdvancedTableCellBlock(model, coordinate, operation.from, operation.to));
}
