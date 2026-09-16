import type { Processor } from "unified";
import type { Root } from "mdast";
import type { Node as ProseNode } from "@milkdown/kit/prose/model";
import { redo, undo } from "@milkdown/kit/prose/history";
import { NodeSelection } from "@milkdown/kit/prose/state";
import type { EditorView, NodeView, ViewMutationRecord } from "@milkdown/kit/prose/view";
import { $nodeSchema, $remark, $view } from "@milkdown/kit/utils";
import {
  PERSISTENT_LAYOUT_NODE_NAME,
  parsePersistentLayoutHtml,
  serializePersistentLayoutHtml,
  validatePersistentLayoutModel,
  type PersistentLayoutModel,
} from "./layoutModel";
import {
  createPersistentLayoutBlockMoveTransaction,
  planPersistentLayoutBlockMove,
  resolvePersistentLayoutView,
} from "./layoutInteraction";
import {
  layoutBlockRefKey,
  parseLayoutBlockRefKey,
  resolvePersistentLayoutDropIntent,
  resolvePersistentLayoutPointerOwner,
  updatePersistentLayoutDragSelection,
  type PersistentLayoutBlockRef,
  type PersistentLayoutDropIntent,
} from "./layoutDragModel";

type MdNode = {
  type: string;
  value?: string;
  model?: PersistentLayoutModel;
  children?: MdNode[];
  [key: string]: unknown;
};

export function persistentLayoutHistoryIntent(
  event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey">,
): "undo" | "redo" | null {
  const key = event.key.toLocaleLowerCase();
  if ((event.metaKey || event.ctrlKey) && key === "z") return event.shiftKey ? "redo" : "undo";
  if (event.ctrlKey && !event.metaKey && !event.shiftKey && key === "y") return "redo";
  return null;
}

/** Converts only complete valid containers. Unknown versions and malformed HTML
 * intentionally remain raw HTML for the source-fidelity route. */
export function transformPersistentLayoutAst(tree: MdNode): MdNode {
  if (tree.type === "paragraph" && tree.children?.length === 1) {
    const only = tree.children[0];
    if (only.type === "html" && typeof only.value === "string") {
      const parsed = parsePersistentLayoutHtml(only.value);
      if (parsed.ok) return { type: PERSISTENT_LAYOUT_NODE_NAME, model: parsed.model };
    }
  }
  if (tree.children) {
    tree.children = tree.children.map((child) => {
      if (child.type === "html" && typeof child.value === "string") {
        const parsed = parsePersistentLayoutHtml(child.value);
        if (parsed.ok) return { type: PERSISTENT_LAYOUT_NODE_NAME, model: parsed.model };
      }
      return transformPersistentLayoutAst(child);
    });
  }
  return tree;
}

const persistentLayoutRemark = $remark("omiaPersistentLayoutRemark", () => function persistentLayoutRemark(this: Processor) {
  return (tree: Root) => transformPersistentLayoutAst(tree as MdNode) as Root;
});

function blockElement(blockHtml: string): HTMLElement {
  const template = document.createElement("template");
  template.innerHTML = blockHtml;
  const element = template.content.firstElementChild;
  if (!(element instanceof HTMLElement)) throw new Error("Persistent layout block render failed");
  return element;
}

export function renderPersistentLayoutDom(model: PersistentLayoutModel): HTMLDivElement {
  if (!validatePersistentLayoutModel(model)) throw new Error("Invalid persistent layout model");
  const root = document.createElement("div");
  root.className = "omia-persistent-layout-view";
  root.dataset.omiaLayoutView = "1";
  root.dataset.omiaLayoutVersion = String(model.version);
  root.setAttribute("draggable", "false");
  root.setAttribute("role", "group");
  root.setAttribute("aria-label", `${model.columns.length} column layout / ${model.columns.length} 列分栏`);
  root.style.gridTemplateColumns = model.widths.map((width) => `${width}fr`).join(" ");
  model.columns.forEach((column) => {
    const section = document.createElement("section");
    section.className = "omia-persistent-layout-column";
    section.dataset.omiaLayoutColumn = String(column.index);
    section.setAttribute("aria-label", `Column ${column.index + 1} / 第 ${column.index + 1} 列`);
    column.blocks.forEach((block, blockIndex) => {
      const wrapper = document.createElement("div");
      wrapper.className = "omia-persistent-layout-block";
      wrapper.dataset.omiaLayoutBlock = String(blockIndex);
      const handle = document.createElement("button");
      handle.type = "button";
      handle.className = "omia-persistent-layout-drag-handle";
      handle.dataset.omiaLayoutDragHandle = "1";
      handle.dataset.omiaLayoutDragColumnIndex = String(column.index);
      handle.dataset.omiaLayoutDragBlockIndex = String(blockIndex);
      handle.draggable = false;
      handle.setAttribute("aria-label", `Move block ${blockIndex + 1} in column ${column.index + 1} / 移动第 ${column.index + 1} 列第 ${blockIndex + 1} 块`);
      handle.textContent = "⠿";
      wrapper.appendChild(handle);
      wrapper.appendChild(blockElement(block.html));
      section.appendChild(wrapper);
    });
    root.appendChild(section);
  });
  return root;
}

export function persistentLayoutSourceDom(model: PersistentLayoutModel): HTMLDivElement {
  if (!validatePersistentLayoutModel(model)) throw new Error("Invalid persistent layout model");
  const template = document.createElement("template");
  template.innerHTML = serializePersistentLayoutHtml(model);
  const root = template.content.firstElementChild;
  if (!(root instanceof HTMLDivElement)) throw new Error("Persistent layout source DOM render failed");
  return root;
}

export const persistentLayoutSchema = $nodeSchema(PERSISTENT_LAYOUT_NODE_NAME, () => ({
  group: "block",
  atom: true,
  selectable: true,
  draggable: false,
  isolating: true,
  attrs: { model: { validate: validatePersistentLayoutModel } },
  parseDOM: [{
    tag: 'div[data-omia-layout="1"]',
    getAttrs: (element) => {
      if (!(element instanceof HTMLDivElement)) return false;
      const parsed = parsePersistentLayoutHtml(element.outerHTML);
      return parsed.ok ? { model: parsed.model } : false;
    },
  }],
  // Clipboard/DOM serialization must carry the canonical file model. The NodeView
  // supplies the visual wrapper independently.
  toDOM: (node) => persistentLayoutSourceDom(node.attrs.model as PersistentLayoutModel),
  parseMarkdown: {
    match: (node) => node.type === PERSISTENT_LAYOUT_NODE_NAME && validatePersistentLayoutModel(node.model),
    runner: (state, node, type) => state.addNode(type, { model: node.model }),
  },
  toMarkdown: {
    match: (node) => node.type.name === PERSISTENT_LAYOUT_NODE_NAME && validatePersistentLayoutModel(node.attrs.model),
    runner: (state, node) => state.addNode("html", undefined, serializePersistentLayoutHtml(node.attrs.model as PersistentLayoutModel)),
  },
}));

class PersistentLayoutNodeView implements NodeView {
  dom: HTMLElement;
  private node: ProseNode;
  private readonly view: EditorView;
  private readonly getPos: () => number | undefined;
  private resizeObserver: ResizeObserver | null = null;
  private selectedKeys = new Set<string>();
  private selectionAnchor: PersistentLayoutBlockRef | null = null;
  private restoreFocusKey: string | null = null;
  private press: {
    pointerId: number;
    source: PersistentLayoutBlockRef;
    sources: PersistentLayoutBlockRef[];
    startX: number;
    startY: number;
    dragging: boolean;
    intent: PersistentLayoutDropIntent | null;
  } | null = null;
  private dragGhost: HTMLElement | null = null;

  constructor(node: ProseNode, view: EditorView, getPos: () => number | undefined) {
    this.node = node;
    this.view = view;
    this.getPos = getPos;
    this.dom = renderPersistentLayoutDom(node.attrs.model as PersistentLayoutModel);
    this.dom.addEventListener("pointerdown", this.onPointerDown);
    this.dom.addEventListener("pointermove", this.onPointerMove);
    this.dom.addEventListener("pointerup", this.onPointerUp);
    this.dom.addEventListener("pointercancel", this.onPointerCancel);
    this.dom.addEventListener("lostpointercapture", this.onLostPointerCapture);
    this.dom.addEventListener("dragstart", this.onDragStart);
    this.dom.addEventListener("keydown", this.onHandleKeyDown);
    window.addEventListener("keydown", this.onWindowKeyDown, true);
    window.addEventListener("blur", this.onWindowBlur);
    this.applyResponsiveView();
    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(() => this.applyResponsiveView());
      this.resizeObserver.observe(this.dom);
    }
  }

  private applyResponsiveView(): void {
    const model = this.node.attrs.model as PersistentLayoutModel;
    const width = this.dom.clientWidth || this.dom.parentElement?.clientWidth || 800;
    this.dom.dataset.stacked = resolvePersistentLayoutView(model, width).stacked ? "true" : "false";
  }

  private model(): PersistentLayoutModel {
    return this.node.attrs.model as PersistentLayoutModel;
  }

  private allBlockRefs(): PersistentLayoutBlockRef[] {
    return this.model().columns.flatMap((column) => column.blocks.map((_block, blockIndex) => ({
      columnIndex: column.index,
      blockIndex,
    })));
  }

  private refFromHandle(target: EventTarget | null): PersistentLayoutBlockRef | null {
    const handle = target instanceof Element
      ? target.closest<HTMLElement>("[data-omia-layout-drag-handle='1']")
      : null;
    return handle ? parseLayoutBlockRefKey(
      `${handle.dataset.omiaLayoutDragColumnIndex}:${handle.dataset.omiaLayoutDragBlockIndex}`,
    ) : null;
  }

  private applyBlockSelection(): void {
    this.dom.querySelectorAll<HTMLElement>("[data-omia-layout-block]").forEach((block) => {
      const columnIndex = Number(block.closest<HTMLElement>("[data-omia-layout-column]")?.dataset.omiaLayoutColumn);
      const blockIndex = Number(block.dataset.omiaLayoutBlock);
      block.classList.toggle("is-layout-drag-selected", this.selectedKeys.has(`${columnIndex}:${blockIndex}`));
    });
  }

  private selectLayoutNode(): void {
    const pos = this.getPos();
    if (typeof pos !== "number") return;
    const selection = this.view.state.selection;
    if (!(selection instanceof NodeSelection) || selection.from !== pos) {
      this.view.dispatch(this.view.state.tr.setSelection(NodeSelection.create(this.view.state.doc, pos)));
    }
  }

  private updateTapSelection(source: PersistentLayoutBlockRef, event: MouseEvent): void {
    const all = this.allBlockRefs();
    this.selectedKeys = updatePersistentLayoutDragSelection(all, this.selectedKeys, source, {
      additive: event.metaKey || event.ctrlKey,
      range: event.shiftKey,
      anchor: this.selectionAnchor,
    });
    if (!event.shiftKey) this.selectionAnchor = source;
    this.selectLayoutNode();
    this.applyBlockSelection();
  }

  private sourceRefs(source: PersistentLayoutBlockRef, event: MouseEvent): PersistentLayoutBlockRef[] {
    const all = this.allBlockRefs();
    const sourceKey = layoutBlockRefKey(source);
    const preserveGroup = !event.metaKey && !event.ctrlKey && !event.shiftKey
      && this.selectedKeys.size > 1 && this.selectedKeys.has(sourceKey);
    if (preserveGroup) {
      this.selectLayoutNode();
      this.applyBlockSelection();
    } else {
      this.updateTapSelection(source, event);
    }
    return all.filter((ref) => this.selectedKeys.has(layoutBlockRefKey(ref)));
  }

  private dropIntent(clientX: number, clientY: number): PersistentLayoutDropIntent | null {
    const columns = [...this.dom.querySelectorAll<HTMLElement>("[data-omia-layout-column]")].map((column) => {
      const rect = column.getBoundingClientRect();
      return {
        columnIndex: Number(column.dataset.omiaLayoutColumn),
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        blocks: [...column.querySelectorAll<HTMLElement>(":scope > [data-omia-layout-block]")].map((block) => {
          const blockRect = block.getBoundingClientRect();
          return {
            blockIndex: Number(block.dataset.omiaLayoutBlock),
            top: blockRect.top,
            bottom: blockRect.bottom,
          };
        }),
      };
    });
    const hits = typeof document.elementsFromPoint === "function" ? document.elementsFromPoint(clientX, clientY) : [];
    const hitColumn = hits.map((hit) => hit.closest<HTMLElement>("[data-omia-layout-column]"))
      .find((column): column is HTMLElement => Boolean(column && this.dom.contains(column)));
    return resolvePersistentLayoutDropIntent(columns, {
      clientX,
      clientY,
      hitColumnIndex: hitColumn ? Number(hitColumn.dataset.omiaLayoutColumn) : null,
    });
  }

  private showGhost(source: PersistentLayoutBlockRef, count: number, clientX: number, clientY: number): void {
    if (!this.dragGhost) {
      const sourceBlock = this.dom.querySelector<HTMLElement>(
        `[data-omia-layout-column='${source.columnIndex}'] > [data-omia-layout-block='${source.blockIndex}']`,
      );
      const ghost = document.createElement("div");
      ghost.className = "omia-persistent-layout-drag-ghost";
      ghost.textContent = count > 1 ? `${count} blocks / ${count} 个块` : sourceBlock?.textContent?.replace("⠿", "").trim() || "Block / 内容块";
      document.body.appendChild(ghost);
      this.dragGhost = ghost;
    }
    this.dragGhost.style.left = `${clientX + 12}px`;
    this.dragGhost.style.top = `${clientY + 12}px`;
  }

  private showDropIndicator(intent: PersistentLayoutDropIntent | null): void {
    this.dom.querySelector(".omia-persistent-layout-drop-indicator")?.remove();
    if (!intent) return;
    const column = this.dom.querySelector<HTMLElement>(`[data-omia-layout-column='${intent.columnIndex}']`);
    if (!column) return;
    const indicator = document.createElement("div");
    indicator.className = "omia-persistent-layout-drop-indicator";
    indicator.setAttribute("aria-hidden", "true");
    const before = column.querySelector<HTMLElement>(`:scope > [data-omia-layout-block='${intent.blockIndex}']`);
    column.insertBefore(indicator, before);
  }

  private clearDrag(): void {
    const pointerId = this.press?.pointerId;
    this.press = null;
    delete this.dom.dataset.dragging;
    this.dom.querySelector(".omia-persistent-layout-drop-indicator")?.remove();
    this.dragGhost?.remove();
    this.dragGhost = null;
    if (pointerId != null && this.dom.hasPointerCapture?.(pointerId)) this.dom.releasePointerCapture?.(pointerId);
  }

  private onPointerDown = (rawEvent: Event): void => {
    const event = rawEvent as PointerEvent;
    if (event.button !== 0 || event.isPrimary === false || resolvePersistentLayoutPointerOwner(event.target as Element | null) !== "layout-block") return;
    const source = this.refFromHandle(event.target);
    if (!source) return;
    event.preventDefault();
    const sources = this.sourceRefs(source, event);
    this.press = {
      pointerId: event.pointerId ?? 0,
      source,
      sources,
      startX: event.clientX,
      startY: event.clientY,
      dragging: false,
      intent: null,
    };
    this.dom.setPointerCapture?.(this.press.pointerId);
  };

  private onPointerMove = (rawEvent: Event): void => {
    const event = rawEvent as PointerEvent;
    if (!this.press || event.pointerId !== this.press.pointerId) return;
    const distance = Math.hypot(event.clientX - this.press.startX, event.clientY - this.press.startY);
    if (!this.press.dragging && distance < 4) return;
    event.preventDefault();
    this.press.dragging = true;
    this.dom.dataset.dragging = "true";
    this.showGhost(this.press.source, this.press.sources.length, event.clientX, event.clientY);
    const intent = this.dropIntent(event.clientX, event.clientY);
    const valid = intent && planPersistentLayoutBlockMove(this.model(), { sources: this.press.sources, destination: intent });
    this.press.intent = valid ? intent : null;
    this.showDropIndicator(this.press.intent);
  };

  private onPointerUp = (rawEvent: Event): void => {
    const event = rawEvent as PointerEvent;
    if (!this.press || event.pointerId !== this.press.pointerId) return;
    event.preventDefault();
    const press = this.press;
    const intent = press.dragging ? press.intent : null;
    const pos = this.getPos();
    const transaction = intent && typeof pos === "number"
      ? createPersistentLayoutBlockMoveTransaction(this.view.state, { pos, nodeSize: this.node.nodeSize }, {
          sources: press.sources,
          destination: intent,
        })
      : null;
    const plan = intent ? planPersistentLayoutBlockMove(this.model(), { sources: press.sources, destination: intent }) : null;
    this.clearDrag();
    if (!transaction || !plan) {
      this.applyBlockSelection();
      return;
    }
    this.selectedKeys = new Set(plan.movedRefs.map(layoutBlockRefKey));
    this.selectionAnchor = plan.movedRefs[0] ?? null;
    this.view.dispatch(transaction);
    this.applyBlockSelection();
    const first = plan.movedRefs[0];
    if (first) requestAnimationFrame(() => {
      const handle = this.dom.querySelector<HTMLElement>(
        `[data-omia-layout-column='${first.columnIndex}'] > [data-omia-layout-block='${first.blockIndex}'] [data-omia-layout-drag-handle='1']`,
      );
      handle?.focus();
      handle?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    });
  };

  private onPointerCancel = (rawEvent: Event): void => {
    const event = rawEvent as PointerEvent;
    if (this.press && event.pointerId === this.press.pointerId) this.clearDrag();
  };

  private onLostPointerCapture = (): void => { if (this.press) this.clearDrag(); };
  private onWindowKeyDown = (event: KeyboardEvent): void => { if (event.key === "Escape" && this.press) this.clearDrag(); };
  private onWindowBlur = (): void => { if (this.press) this.clearDrag(); };
  private onDragStart = (event: DragEvent): void => {
    if (resolvePersistentLayoutPointerOwner(event.target as Element | null) === "layout-block") event.preventDefault();
  };
  private onHandleKeyDown = (event: KeyboardEvent): void => {
    if (!(event.target instanceof Element)) return;
    const handle = event.target.closest<HTMLElement>("[data-omia-layout-drag-handle='1']");
    if (!handle) return;
    const intent = persistentLayoutHistoryIntent(event);
    if (!intent) return;
    event.preventDefault();
    event.stopPropagation();
    this.restoreFocusKey = `${handle.dataset.omiaLayoutDragColumnIndex}:${handle.dataset.omiaLayoutDragBlockIndex}`;
    if (!(intent === "redo" ? redo : undo)(this.view.state, this.view.dispatch, this.view)) this.restoreFocusKey = null;
  };

  update(node: ProseNode): boolean {
    if (node.type !== this.node.type || !validatePersistentLayoutModel(node.attrs.model)) return false;
    this.node = node;
    const next = renderPersistentLayoutDom(node.attrs.model as PersistentLayoutModel);
    this.dom.className = next.className;
    this.dom.replaceChildren(...Array.from(next.childNodes));
    this.dom.style.gridTemplateColumns = next.style.gridTemplateColumns;
    this.dom.setAttribute("aria-label", next.getAttribute("aria-label") ?? "");
    this.selectedKeys = new Set([...this.selectedKeys].filter((key) => {
      const ref = parseLayoutBlockRefKey(key);
      return Boolean(ref && (node.attrs.model as PersistentLayoutModel).columns[ref.columnIndex]?.blocks[ref.blockIndex]);
    }));
    this.applyBlockSelection();
    this.applyResponsiveView();
    if (this.restoreFocusKey) {
      const ref = parseLayoutBlockRefKey(this.restoreFocusKey);
      this.restoreFocusKey = null;
      const exact = ref ? this.dom.querySelector<HTMLElement>(
        `[data-omia-layout-column='${ref.columnIndex}'] > [data-omia-layout-block='${ref.blockIndex}'] [data-omia-layout-drag-handle='1']`,
      ) : null;
      (exact ?? this.dom.querySelector<HTMLElement>("[data-omia-layout-drag-handle='1']"))?.focus({ preventScroll: true });
    }
    return true;
  }

  selectNode(): void { this.dom.classList.add("ProseMirror-selectednode"); }
  deselectNode(): void { this.dom.classList.remove("ProseMirror-selectednode"); }
  stopEvent(event: Event): boolean {
    if (this.press) return true;
    if (!(event.target instanceof Element) || !event.target.closest("[data-omia-layout-drag-handle='1']")) return false;
    return event.type.startsWith("pointer") || event.type.startsWith("mouse") || event.type === "click" || event.type === "dragstart";
  }
  ignoreMutation(_mutation: ViewMutationRecord): boolean { return true; }
  destroy(): void {
    this.clearDrag();
    this.resizeObserver?.disconnect();
    this.dom.removeEventListener("pointerdown", this.onPointerDown);
    this.dom.removeEventListener("pointermove", this.onPointerMove);
    this.dom.removeEventListener("pointerup", this.onPointerUp);
    this.dom.removeEventListener("pointercancel", this.onPointerCancel);
    this.dom.removeEventListener("lostpointercapture", this.onLostPointerCapture);
    this.dom.removeEventListener("dragstart", this.onDragStart);
    this.dom.removeEventListener("keydown", this.onHandleKeyDown);
    window.removeEventListener("keydown", this.onWindowKeyDown, true);
    window.removeEventListener("blur", this.onWindowBlur);
  }
}

const persistentLayoutView = $view(persistentLayoutSchema.node, () => (
  (node, view, getPos) => new PersistentLayoutNodeView(node, view, getPos)
));

export const persistentLayoutPlugins = [
  ...persistentLayoutRemark,
  ...persistentLayoutSchema,
  persistentLayoutView,
];
