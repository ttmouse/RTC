import type { Processor } from "unified";
import type { Root } from "mdast";
import type { Node as ProseNode } from "@milkdown/kit/prose/model";
import { redo, undo } from "@milkdown/kit/prose/history";
import type { EditorView, NodeView, ViewMutationRecord } from "@milkdown/kit/prose/view";
import { $nodeSchema, $remark, $view } from "@milkdown/kit/utils";
import {
  ADVANCED_TABLE_NODE_NAME,
  parseAdvancedTableHtml,
  serializeAdvancedTableHtml,
  validateAdvancedTableModel,
  type AdvancedTableModel,
} from "./advancedTableModel";
import {
  advancedTablePointerDeltaToBasisPoints,
  createAdvancedTableKeyboardResizeTransaction,
  createAdvancedTableResizeTransaction,
  listAdvancedTableCellAnchors,
  resizeAdvancedTableBoundary,
  resolveAdvancedTableWidthLayout,
} from "./advancedTableInteraction";

export function advancedTableHistoryIntent(event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey">): "undo" | "redo" | null {
  const key = event.key.toLowerCase();
  if ((event.metaKey || event.ctrlKey) && key === "z") return event.shiftKey ? "redo" : "undo";
  if (event.ctrlKey && !event.metaKey && !event.shiftKey && key === "y") return "redo";
  return null;
}

type MdNode = {
  type: string;
  value?: string;
  model?: AdvancedTableModel;
  children?: MdNode[];
  [key: string]: unknown;
};

/** Converts only complete, valid advanced-table HTML nodes. Invalid/future
 * containers remain raw HTML so markdownFidelity keeps the document in source. */
export function transformAdvancedTableAst(tree: MdNode): MdNode {
  if (tree.type === "paragraph" && tree.children?.length === 1) {
    const only = tree.children[0];
    if (only.type === "html" && typeof only.value === "string") {
      const parsed = parseAdvancedTableHtml(only.value);
      if (parsed.ok) return { type: ADVANCED_TABLE_NODE_NAME, model: parsed.model };
    }
  }
  if (tree.children) {
    tree.children = tree.children.map((child) => {
      if (child.type === "html" && typeof child.value === "string") {
        const parsed = parseAdvancedTableHtml(child.value);
        if (parsed.ok) return { type: ADVANCED_TABLE_NODE_NAME, model: parsed.model };
      }
      return transformAdvancedTableAst(child);
    });
  }
  return tree;
}

const advancedTableRemark = $remark("omiaAdvancedTableRemark", () => function advancedTableRemark(this: Processor) {
  return (tree: Root) => transformAdvancedTableAst(tree as MdNode) as Root;
});

export function renderAdvancedTableDom(model: AdvancedTableModel): HTMLTableElement {
  if (!validateAdvancedTableModel(model)) throw new Error("Invalid advanced table model");
  const template = document.createElement("template");
  template.innerHTML = serializeAdvancedTableHtml(model);
  const table = template.content.firstElementChild;
  if (!(table instanceof HTMLTableElement)) throw new Error("Advanced table DOM render failed");
  return table;
}

export const advancedTableSchema = $nodeSchema(ADVANCED_TABLE_NODE_NAME, () => ({
  group: "block",
  atom: true,
  selectable: true,
  draggable: false,
  isolating: true,
  attrs: {
    model: { validate: validateAdvancedTableModel },
  },
  parseDOM: [{
    tag: 'table[data-omia-table="1"]',
    // Clipboard DOM 同时也是合法的普通 <table>。必须先于 GFM table 的宽泛规则命中，
    // 否则跨 Omia 文档粘贴会静默丢掉列宽、合并、背景和复杂单元格模型。
    priority: 100,
    getAttrs: (element) => {
      if (!(element instanceof HTMLTableElement)) return false;
      const parsed = parseAdvancedTableHtml(element.outerHTML);
      return parsed.ok ? { model: parsed.model } : false;
    },
  }],
  toDOM: (node) => renderAdvancedTableDom(node.attrs.model as AdvancedTableModel),
  parseMarkdown: {
    match: (node) => node.type === ADVANCED_TABLE_NODE_NAME && validateAdvancedTableModel(node.model),
    runner: (state, node, type) => state.addNode(type, { model: node.model }),
  },
  toMarkdown: {
    match: (node) => node.type.name === ADVANCED_TABLE_NODE_NAME && validateAdvancedTableModel(node.attrs.model),
    runner: (state, node) => state.addNode("html", undefined, serializeAdvancedTableHtml(node.attrs.model as AdvancedTableModel)),
  },
}));

type ActiveResize = {
  boundary: number;
  pointerId: number;
  startX: number;
  tableWidthPx: number;
  widths: number[];
};

class AdvancedTableNodeView implements NodeView {
  dom: HTMLElement;
  private node: ProseNode;
  private table: HTMLTableElement | null = null;
  private canvas: HTMLElement | null = null;
  private handles: HTMLElement[] = [];
  private activeResize: ActiveResize | null = null;
  private restoreFocusBoundary: number | null = null;
  private resizeObserver: ResizeObserver | null = null;

  constructor(
    node: ProseNode,
    private readonly view: EditorView,
    private readonly getPos: () => number | undefined,
  ) {
    this.node = node;
    this.dom = document.createElement("div");
    this.dom.className = "omia-advanced-table-view";
    this.dom.setAttribute("draggable", "false");
    this.dom.setAttribute("data-omia-advanced-table-view", "1");
    this.dom.addEventListener("pointerdown", this.onPointerDown);
    this.dom.addEventListener("pointermove", this.onPointerMove);
    this.dom.addEventListener("pointerup", this.onPointerUp);
    this.dom.addEventListener("pointercancel", this.onPointerCancel);
    this.dom.addEventListener("keydown", this.onKeyDown);
    this.render();
    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(() => {
        if (!this.activeResize) this.applyLayout((this.node.attrs.model as AdvancedTableModel).widths);
      });
      this.resizeObserver.observe(this.dom);
    }
  }

  private target(): { pos: number; nodeSize: number } | null {
    const pos = this.getPos();
    return typeof pos === "number" ? { pos, nodeSize: this.node.nodeSize } : null;
  }

  private viewportWidth(): number {
    return this.dom.clientWidth || this.dom.parentElement?.clientWidth || 800;
  }

  private applyLayout(widths: readonly number[]): void {
    if (!this.table || !this.canvas) return;
    const layout = resolveAdvancedTableWidthLayout(widths, this.viewportWidth());
    this.canvas.style.width = `${layout.tableWidthPx}px`;
    this.canvas.dataset.overflow = layout.overflow ? "true" : "false";
    this.table.style.width = `${layout.tableWidthPx}px`;
    this.table.style.tableLayout = "fixed";
    Array.from(this.table.querySelectorAll<HTMLElement>("col")).forEach((column, index) => {
      column.style.width = `${layout.columnWidthsPx[index]}px`;
    });
    let left = 0;
    this.handles.forEach((handle, index) => {
      left += layout.columnWidthsPx[index];
      handle.style.left = `${left}px`;
      handle.setAttribute("aria-valuenow", String(widths[index]));
      handle.setAttribute("aria-valuemax", String(widths[index] + widths[index + 1] - 1));
    });
  }

  private render(): void {
    const model = this.node.attrs.model as AdvancedTableModel;
    const scroll = document.createElement("div");
    scroll.className = "omia-advanced-table-scroll";
    const canvas = document.createElement("div");
    canvas.className = "omia-advanced-table-canvas";
    const table = renderAdvancedTableDom(model);
    table.setAttribute("draggable", "false");
    (["head", "body"] as const).forEach((section) => {
      const sectionElement = table.querySelector(section === "head" ? "thead" : "tbody");
      const rows = sectionElement ? Array.from(sectionElement.querySelectorAll(":scope > tr")) : [];
      listAdvancedTableCellAnchors(model, section).forEach((anchor) => {
        const cell = rows[anchor.row]?.children[anchor.cellIndex];
        if (!(cell instanceof HTMLElement)) return;
        cell.dataset.omiaTableSection = section;
        cell.dataset.omiaTableRow = String(anchor.row);
        cell.dataset.omiaTableColumn = String(anchor.column);
        cell.dataset.omiaTableColspan = String(anchor.colspan);
        cell.dataset.omiaTableRowspan = String(anchor.rowspan);
      });
    });
    canvas.appendChild(table);
    this.handles = model.widths.slice(0, -1).map((width, boundary) => {
      const handle = document.createElement("button");
      handle.type = "button";
      handle.className = "omia-advanced-table-resize-handle";
      handle.setAttribute("role", "separator");
      handle.setAttribute("aria-orientation", "vertical");
      handle.setAttribute("aria-label", `Resize column ${boundary + 1} / 调整第 ${boundary + 1} 列宽度`);
      handle.setAttribute("aria-valuemin", "1");
      handle.setAttribute("aria-valuenow", String(width));
      handle.setAttribute("data-omia-table-resize-boundary", String(boundary));
      handle.setAttribute("draggable", "false");
      handle.contentEditable = "false";
      canvas.appendChild(handle);
      return handle;
    });
    scroll.appendChild(canvas);
    this.dom.replaceChildren(scroll);
    this.table = table;
    this.canvas = canvas;
    this.applyLayout(model.widths);
  }

  private handleFromEvent(event: Event): HTMLElement | null {
    const target = event.target;
    if (!(target instanceof Element)) return null;
    return target.closest<HTMLElement>("[data-omia-table-resize-boundary]");
  }

  private onPointerDown = (event: PointerEvent): void => {
    const handle = this.handleFromEvent(event);
    if (!handle || event.button !== 0 || this.activeResize) return;
    const boundary = Number(handle.dataset.omiaTableResizeBoundary);
    const model = this.node.attrs.model as AdvancedTableModel;
    if (!Number.isInteger(boundary) || boundary < 0 || boundary >= model.widths.length - 1) return;
    event.preventDefault();
    event.stopPropagation();
    handle.focus({ preventScroll: true });
    this.activeResize = {
      boundary,
      pointerId: event.pointerId,
      startX: event.clientX,
      tableWidthPx: Number.parseFloat(this.table?.style.width ?? "") || this.viewportWidth(),
      widths: [...model.widths],
    };
    window.addEventListener("pointerup", this.onWindowPointerUp, true);
    window.addEventListener("pointercancel", this.onWindowPointerCancel, true);
    handle.classList.add("is-resizing");
    try { handle.setPointerCapture?.(event.pointerId); } catch { /* pointer already ended */ }
  };

  private onPointerMove = (event: PointerEvent): void => {
    const active = this.activeResize;
    if (!active || event.pointerId !== active.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    window.removeEventListener("pointerup", this.onWindowPointerUp, true);
    window.removeEventListener("pointercancel", this.onWindowPointerCancel, true);
    const delta = advancedTablePointerDeltaToBasisPoints(event.clientX - active.startX, active.tableWidthPx);
    const preview = delta == null ? null : resizeAdvancedTableBoundary(active.widths, active.boundary, delta);
    if (preview) this.applyLayout(preview);
  };

  private finishPointerResize(event: PointerEvent, commit: boolean): void {
    const active = this.activeResize;
    if (!active || event.pointerId !== active.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    this.activeResize = null;
    this.handles.forEach((handle) => handle.classList.remove("is-resizing"));
    const target = this.target();
    const delta = advancedTablePointerDeltaToBasisPoints(event.clientX - active.startX, active.tableWidthPx);
    if (commit && target && delta != null) {
      const transaction = createAdvancedTableResizeTransaction(this.view.state, target, active.boundary, delta);
      if (transaction) {
        this.restoreFocusBoundary = active.boundary;
        this.view.dispatch(transaction.scrollIntoView());
        return;
      }
    }
    this.applyLayout((this.node.attrs.model as AdvancedTableModel).widths);
  }

  private onPointerUp = (event: PointerEvent): void => this.finishPointerResize(event, true);
  private onPointerCancel = (event: PointerEvent): void => this.finishPointerResize(event, false);
  private onWindowPointerUp = (event: PointerEvent): void => this.finishPointerResize(event, true);
  private onWindowPointerCancel = (event: PointerEvent): void => this.finishPointerResize(event, false);

  private onKeyDown = (event: KeyboardEvent): void => {
    const handle = this.handleFromEvent(event);
    if (!handle) return;
    const historyIntent = advancedTableHistoryIntent(event);
    if (historyIntent) {
      const command = historyIntent === "redo" ? redo : undo;
      this.restoreFocusBoundary = Number(handle.dataset.omiaTableResizeBoundary);
      if (!command(this.view.state, this.view.dispatch)) {
        this.restoreFocusBoundary = null;
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    const boundary = Number(handle.dataset.omiaTableResizeBoundary);
    const target = this.target();
    if (!target || !Number.isInteger(boundary)) return;
    const transaction = createAdvancedTableKeyboardResizeTransaction(this.view.state, target, boundary, event.key);
    if (!transaction) return;
    event.preventDefault();
    event.stopPropagation();
    this.restoreFocusBoundary = boundary;
    this.view.dispatch(transaction.scrollIntoView());
  };

  update(node: ProseNode): boolean {
    if (node.type !== this.node.type || !validateAdvancedTableModel(node.attrs.model)) return false;
    this.node = node;
    this.render();
    if (this.restoreFocusBoundary != null) {
      this.handles[this.restoreFocusBoundary]?.focus({ preventScroll: true });
      this.restoreFocusBoundary = null;
    }
    return true;
  }

  selectNode(): void { this.dom.classList.add("ProseMirror-selectednode"); }
  deselectNode(): void { this.dom.classList.remove("ProseMirror-selectednode"); }
  stopEvent(event: Event): boolean { return Boolean(this.handleFromEvent(event)); }
  ignoreMutation(_mutation: ViewMutationRecord): boolean { return true; }

  destroy(): void {
    this.resizeObserver?.disconnect();
    window.removeEventListener("pointerup", this.onWindowPointerUp, true);
    window.removeEventListener("pointercancel", this.onWindowPointerCancel, true);
    this.dom.removeEventListener("pointerdown", this.onPointerDown);
    this.dom.removeEventListener("pointermove", this.onPointerMove);
    this.dom.removeEventListener("pointerup", this.onPointerUp);
    this.dom.removeEventListener("pointercancel", this.onPointerCancel);
    this.dom.removeEventListener("keydown", this.onKeyDown);
  }
}

const advancedTableView = $view(advancedTableSchema.node, () => (
  (node, view, getPos) => new AdvancedTableNodeView(node, view, getPos)
));

export const advancedTablePlugins = [
  ...advancedTableRemark,
  ...advancedTableSchema,
  advancedTableView,
];
