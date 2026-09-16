import type { EditorState, Transaction } from "@milkdown/kit/prose/state";
import { normalizeRichLinkInput, type RichLinkKind } from "./editorHelpers";

export type PortableNodeKind = "bookmark" | "audio" | "video" | "file" | "image" | "table" | "math" | "layout";
export type NodeToolbarKind = PortableNodeKind | "code";

export type NodeToolbarAction =
  | "open" | "edit-source" | "display" | "description" | "replace-source" | "edit" | "delete"
  | "row-before" | "row-after" | "delete-row"
  | "column-before" | "column-after" | "delete-column"
  | "align-left" | "align-center" | "align-right"
  | "layout-two" | "layout-three"
  | "layout-left-wide" | "layout-equal" | "layout-right-wide"
  | "layout-previous" | "layout-next" | "layout-linearize";

const RICH_LINK_KINDS = new Set<PortableNodeKind>(["bookmark", "audio", "video", "file"]);

export function resolvePortableNodeKind(target: Element | null): PortableNodeKind | null {
  if (!target) return null;
  const rich = target.closest<HTMLElement>("[data-omia-rich-link]");
  const richKind = rich?.dataset.omiaRichLink as PortableNodeKind | undefined;
  if (richKind && RICH_LINK_KINDS.has(richKind)) return richKind;
  if (target.closest("[data-omia-layout-view='1']")) return "layout";
  if (target.closest(".milkdown-image-block")) return "image";
  if (target.closest(".milkdown-table-block, table")) return "table";
  if (target.closest(".milkdown-latex-block, .milkdown-latex-inline, [data-type='math_block'], [data-type='math_inline']")) return "math";
  return null;
}

/** Code is node-owned context, but deliberately remains outside the portable-media kind. */
export function resolveNodeToolbarKind(target: Element | null): NodeToolbarKind | null {
  if (!target) return null;
  if (target.closest(".milkdown-code-block")) return "code";
  return resolvePortableNodeKind(target);
}

/** Prevents native WebViews from following a rich-card anchor before its node toolbar opens. */
export function claimPortableNodeActivation(event: Pick<Event, "preventDefault">, target: Element | null): PortableNodeKind | null {
  const kind = resolvePortableNodeKind(target);
  if (!kind) return null;
  event.preventDefault();
  return kind;
}

/** The synthetic advanced-cell click may be followed by one trusted compatibility click.
 * Suppress it only inside the same advanced table; an old GFM table or ordinary text
 * must remain reachable on the first click. */
export function shouldSuppressAdvancedCompatibilityClick(root: HTMLElement | null, target: Element | null): boolean {
  return Boolean(root && target && root.contains(target));
}

export function nodeToolbarActions(kind: PortableNodeKind): readonly NodeToolbarAction[] {
  if (kind === "bookmark") return ["open", "edit-source", "display", "delete"];
  if (kind === "audio" || kind === "video" || kind === "file") return ["open", "edit-source", "delete"];
  if (kind === "image") return ["description", "replace-source", "delete"];
  if (kind === "table") return [
    "row-before", "row-after", "delete-row",
    "column-before", "column-after", "delete-column",
    "align-left", "align-center", "align-right", "delete",
  ];
  if (kind === "layout") return [
    "layout-two", "layout-three",
    "layout-left-wide", "layout-equal", "layout-right-wide",
    "layout-previous", "layout-next", "layout-linearize", "delete",
  ];
  return ["edit", "delete"];
}

export type NodeToolbarActionGroup = {
  id: "primary" | "row" | "column" | "alignment" | "structure" | "width" | "order" | "more" | "danger";
  actions: readonly NodeToolbarAction[];
};

const NODE_ACTION_LABELS: Record<NodeToolbarAction, { zh: string; en: string }> = {
  open: { zh: "打开", en: "Open" },
  "edit-source": { zh: "编辑来源", en: "Edit source" },
  display: { zh: "显示方式", en: "Display" },
  description: { zh: "描述", en: "Description" },
  "replace-source": { zh: "替换来源", en: "Replace source" },
  edit: { zh: "编辑", en: "Edit" },
  delete: { zh: "删除", en: "Delete" },
  "row-before": { zh: "上方插行", en: "Row above" },
  "row-after": { zh: "下方插行", en: "Row below" },
  "delete-row": { zh: "删除行", en: "Delete row" },
  "column-before": { zh: "左侧插列", en: "Column left" },
  "column-after": { zh: "右侧插列", en: "Column right" },
  "delete-column": { zh: "删除列", en: "Delete column" },
  "align-left": { zh: "左对齐", en: "Align left" },
  "align-center": { zh: "居中", en: "Align center" },
  "align-right": { zh: "右对齐", en: "Align right" },
  "layout-two": { zh: "两列", en: "2 columns" },
  "layout-three": { zh: "三列", en: "3 columns" },
  "layout-left-wide": { zh: "左宽", en: "Left wide" },
  "layout-equal": { zh: "等宽", en: "Equal" },
  "layout-right-wide": { zh: "右宽", en: "Right wide" },
  "layout-previous": { zh: "向前轮换", en: "Rotate previous" },
  "layout-next": { zh: "向后轮换", en: "Rotate next" },
  "layout-linearize": { zh: "解除分栏", en: "Remove columns" },
};

const NODE_GROUP_LABELS: Record<NodeToolbarActionGroup["id"], { zh: string; en: string }> = {
  primary: { zh: "操作", en: "Actions" },
  row: { zh: "行", en: "Row" },
  column: { zh: "列", en: "Column" },
  alignment: { zh: "对齐", en: "Alignment" },
  structure: { zh: "结构", en: "Structure" },
  width: { zh: "列宽", en: "Width" },
  order: { zh: "顺序", en: "Order" },
  more: { zh: "更多", en: "More" },
  danger: { zh: "危险操作", en: "Danger" },
};

export function nodeToolbarActionLabel(action: NodeToolbarAction, lang: "zh" | "en"): string {
  return NODE_ACTION_LABELS[action][lang];
}

export function nodeToolbarGroupLabel(group: NodeToolbarActionGroup["id"], lang: "zh" | "en"): string {
  return NODE_GROUP_LABELS[group][lang];
}

export function nodeToolbarActionGroups(kind: PortableNodeKind): readonly NodeToolbarActionGroup[] {
  if (kind === "table") return [
    { id: "row", actions: ["row-before", "row-after", "delete-row"] },
    { id: "column", actions: ["column-before", "column-after", "delete-column"] },
    { id: "alignment", actions: ["align-left", "align-center", "align-right"] },
    { id: "danger", actions: ["delete"] },
  ];
  if (kind === "layout") return [
    { id: "structure", actions: ["layout-two", "layout-three"] },
    { id: "width", actions: ["layout-left-wide", "layout-equal", "layout-right-wide"] },
    { id: "order", actions: ["layout-previous", "layout-next"] },
    { id: "more", actions: ["layout-linearize"] },
    { id: "danger", actions: ["delete"] },
  ];
  const actions = nodeToolbarActions(kind);
  return [
    { id: "primary", actions: actions.filter((action) => action !== "delete") },
    { id: "danger", actions: actions.filter((action) => action === "delete") },
  ].filter((group) => group.actions.length > 0) as NodeToolbarActionGroup[];
}

const NODE_LABELS: Record<NodeToolbarKind, { zh: string; en: string }> = {
  code: { zh: "代码块", en: "Code block" },
  bookmark: { zh: "网页书签", en: "Web bookmark" },
  audio: { zh: "音频", en: "Audio" },
  video: { zh: "视频", en: "Video" },
  file: { zh: "文件", en: "File" },
  image: { zh: "图片", en: "Image" },
  table: { zh: "表格", en: "Table" },
  math: { zh: "公式", en: "Equation" },
  layout: { zh: "分栏", en: "Columns" },
};

export function nodeToolbarLabel(kind: NodeToolbarKind, lang: "zh" | "en"): string {
  return NODE_LABELS[kind][lang];
}

export function applyPortableNodeSelection(target: HTMLElement, selected: boolean, label: string): void {
  target.classList.toggle("omia-node-selected", selected);
  if (selected) {
    target.setAttribute("aria-current", "true");
    target.setAttribute("aria-label", label);
  } else {
    target.removeAttribute("aria-current");
    target.removeAttribute("aria-label");
  }
}

type GuardedNodeRange = { pos: number; nodeSize: number };

export function editRichLinkNodeSource(
  state: EditorState,
  target: GuardedNodeRange & { kind: RichLinkKind },
  rawHref: string,
): Transaction | null {
  const node = state.doc.nodeAt(target.pos);
  const linkType = state.schema.marks.link;
  if (!node || node.nodeSize !== target.nodeSize || node.type.name !== "paragraph" || !linkType || !node.textContent) return null;
  let ownsRichMarker = true;
  node.descendants((child) => {
    if (!child.isText || !child.marks.some((mark) => mark.type === linkType && mark.attrs.title === `omia:${target.kind}`)) {
      ownsRichMarker = false;
    }
  });
  if (!ownsRichMarker) return null;
  const normalized = normalizeRichLinkInput(target.kind, rawHref, node.textContent);
  if (!normalized.ok) return null;
  const replacement = node.type.create(
    node.attrs,
    state.schema.text(normalized.value.label, [linkType.create({ href: normalized.value.href, title: normalized.value.title })]),
    node.marks,
  );
  return state.tr.replaceWith(target.pos, target.pos + target.nodeSize, replacement);
}

export function deletePortableNode(state: EditorState, target: GuardedNodeRange): Transaction | null {
  const node = state.doc.nodeAt(target.pos);
  if (!node || node.nodeSize !== target.nodeSize || target.pos < 0 || target.pos + target.nodeSize > state.doc.content.size) return null;
  if (state.doc.childCount === 1 && target.pos === 0) {
    const paragraph = state.schema.nodes.paragraph;
    if (!paragraph) return null;
    return state.tr.replaceWith(0, target.nodeSize, paragraph.create());
  }
  return state.tr.delete(target.pos, target.pos + target.nodeSize);
}
