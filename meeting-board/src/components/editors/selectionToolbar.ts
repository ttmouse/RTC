import {
  CONVERTIBLE_BLOCK_TYPES,
  type BlockEntryType,
  type ConvertibleBlockType,
} from "./blockUi";
import { TextSelection, type EditorState, type Transaction } from "@milkdown/kit/prose/state";

type SelectionToolbarControllerOptions = {
  isEligible: () => boolean;
  setReady: (ready: boolean) => void;
  requestFrame?: (callback: FrameRequestCallback) => number;
  cancelFrame?: (id: number) => void;
};

export type SelectionToolbarController = {
  pointerDown: () => void;
  pointerUp: () => void;
  selectionChanged: () => void;
  keyboardSelection: () => void;
  dismiss: () => void;
  dispose: () => void;
};

export type SelectionPointerFinishInput = Readonly<{
  targetIsToolbar: boolean;
  hasEditorOrigin: boolean;
}>;

/**
 * A direct toolbar click belongs to the toolbar, but a drag that started in
 * the editor must still finish when the floating toolbar appears beneath the
 * release point. WebView2 can otherwise leave a copyable native range without
 * completing the actionable editor selection.
 */
export function shouldFinishSelectionPointer(input: SelectionPointerFinishInput): boolean {
  return input.hasEditorOrigin;
}

export type SelectionToolbarActionableState = Readonly<{
  dataShow: boolean;
  hostReady: boolean;
  selectionHidden: boolean;
  ariaHidden: boolean;
  inert: boolean;
}>;

/** Crepe's data-show alone is insufficient while Omia's accessibility gate is still closed. */
export function shouldApplySelectionToolbarFallback(state: SelectionToolbarActionableState): boolean {
  return !(state.dataShow
    && state.hostReady
    && !state.selectionHidden
    && !state.ariaHidden
    && !state.inert);
}

/**
 * Reconciles a directional DOM drag selection with ProseMirror without
 * normalising anchor/head. Native WKWebView/WebView2 can expose the completed
 * browser range before ProseMirror observes a reverse drag that ends in the
 * page title. Keeping the direction here is required for the next Shift+Arrow
 * gesture and for positioning the toolbar at the user's actual drag head.
 */
export function createDirectionalTextSelectionTransaction(
  state: EditorState,
  anchor: number,
  head: number,
): Transaction | null {
  if (!Number.isInteger(anchor) || !Number.isInteger(head) || anchor === head
    || anchor < 0 || head < 0 || anchor > state.doc.content.size || head > state.doc.content.size) return null;
  try {
    const selection = TextSelection.create(state.doc, anchor, head);
    if (selection.empty || selection.eq(state.selection)) return null;
    return state.tr.setSelection(selection);
  } catch {
    return null;
  }
}

export type SelectionToolbarFallbackGeometry = Readonly<{
  anchor: Readonly<{ left: number; top: number; bottom: number }>;
  parent: Readonly<{ left: number; top: number }>;
  toolbar: Readonly<{ width: number; height: number }>;
  viewport: Readonly<{ width: number; height: number }>;
  gap?: number;
  margin?: number;
}>;

/** Positions the native-WebView fallback at the directional selection head. */
export function selectionToolbarFallbackPosition(input: SelectionToolbarFallbackGeometry) {
  const gap = input.gap ?? 10;
  const margin = input.margin ?? 8;
  const maxLeft = Math.max(margin, input.viewport.width - input.toolbar.width - margin);
  const viewportLeft = Math.max(margin, Math.min(maxLeft, input.anchor.left - input.toolbar.width / 2));
  let viewportTop = input.anchor.top - input.toolbar.height - gap;
  if (viewportTop < margin) viewportTop = input.anchor.bottom + gap;
  const maxTop = Math.max(margin, input.viewport.height - input.toolbar.height - margin);
  viewportTop = Math.max(margin, Math.min(maxTop, viewportTop));
  return {
    left: Math.round(viewportLeft - input.parent.left),
    top: Math.round(viewportTop - input.parent.top),
  };
}

export type SelectionBlockSample = {
  type: BlockEntryType;
  topLevelIndex: number;
  protected?: boolean;
};

export type SelectionBlockTypeModel = {
  kind: "single" | "uniform" | "mixed" | "unavailable";
  currentType: ConvertibleBlockType | null;
  blockCount: number;
  canConvert: boolean;
  label: string;
  reason: string | null;
};

export type SelectionToolbarActionId =
  | "block-type"
  | "alignment"
  | "bold"
  | "italic"
  | "underline"
  | "text-color"
  | "background-color"
  | "clear-format"
  | "strikethrough"
  | "inline-code"
  | "inline-formula"
  | "link"
  | "more";

export type SelectionToolbarComposition = {
  groups: readonly ["type", "alignment", "format", "color", "more"];
  visible: SelectionToolbarActionId[];
  overflow: SelectionToolbarActionId[];
};

const CONVERTIBLE_SET = new Set<BlockEntryType>(CONVERTIBLE_BLOCK_TYPES);

const TYPE_LABELS: Record<ConvertibleBlockType, { zh: string; en: string }> = {
  text: { zh: "正文", en: "Text" },
  h1: { zh: "一级标题", en: "Heading 1" },
  h2: { zh: "二级标题", en: "Heading 2" },
  h3: { zh: "三级标题", en: "Heading 3" },
  h4: { zh: "四级标题", en: "Heading 4" },
  h5: { zh: "五级标题", en: "Heading 5" },
  h6: { zh: "六级标题", en: "Heading 6" },
  quote: { zh: "引用", en: "Quote" },
  callout: { zh: "高亮块", en: "Callout" },
  code: { zh: "代码块", en: "Code block" },
  bullet: { zh: "无序列表", en: "Bullet list" },
  ordered: { zh: "有序列表", en: "Numbered list" },
  todo: { zh: "待办清单", en: "To-do list" },
};

export function selectionBlockTypeLabel(type: ConvertibleBlockType, lang: "zh" | "en"): string {
  return TYPE_LABELS[type][lang];
}

export function resolveSelectionBlockType(
  samples: readonly SelectionBlockSample[],
  lang: "zh" | "en",
): SelectionBlockTypeModel {
  const uniqueBlocks = new Map<number, SelectionBlockSample>();
  for (const sample of samples) if (!uniqueBlocks.has(sample.topLevelIndex)) uniqueBlocks.set(sample.topLevelIndex, sample);
  const blocks = [...uniqueBlocks.values()];
  const unavailable = blocks.length === 0 || blocks.some((sample) => sample.protected || !CONVERTIBLE_SET.has(sample.type));
  if (unavailable) {
    return {
      kind: "unavailable",
      currentType: null,
      blockCount: blocks.length,
      canConvert: false,
      label: lang === "en" ? "Unavailable" : "不可转换",
      reason: lang === "en" ? "This selection contains a protected or unsupported block" : "选区包含受保护或不支持转换的区块",
    };
  }
  const types = new Set(blocks.map(({ type }) => type as ConvertibleBlockType));
  if (types.size !== 1) {
    return {
      kind: "mixed",
      currentType: null,
      blockCount: blocks.length,
      canConvert: false,
      label: lang === "en" ? "Mixed types" : "多种类型",
      reason: lang === "en" ? "Select blocks of one type to convert them safely" : "请选择同一种类型的区块后再转换",
    };
  }
  const currentType = [...types][0]!;
  return {
    kind: blocks.length === 1 ? "single" : "uniform",
    currentType,
    blockCount: blocks.length,
    canConvert: true,
    label: selectionBlockTypeLabel(currentType, lang),
    reason: null,
  };
}

export function selectionBlockConversions(model: SelectionBlockTypeModel) {
  return CONVERTIBLE_BLOCK_TYPES.map((id) => ({
    id,
    current: id === model.currentType,
    disabled: !model.canConvert || id === model.currentType,
  }));
}

export function buildSelectionToolbarComposition(input: { availableWidth: number }): SelectionToolbarComposition {
  void input;
  return {
    groups: ["type", "alignment", "format", "color", "more"],
    visible: [
      "block-type", "alignment", "bold", "strikethrough", "italic", "underline",
      "link", "inline-code", "text-color", "more",
    ],
    overflow: ["inline-formula", "clear-format"],
  };
}

export type SelectionToolbarMoveKey = "ArrowDown" | "ArrowUp" | "ArrowLeft" | "ArrowRight" | "Home" | "End" | "Tab";

export function moveSelectionToolbarFocus(
  currentIndex: number,
  key: SelectionToolbarMoveKey,
  itemCount: number,
  shiftKey = false,
): number {
  if (itemCount <= 0) return -1;
  if (key === "Home") return 0;
  if (key === "End") return itemCount - 1;
  const backwards = key === "ArrowUp" || key === "ArrowLeft" || (key === "Tab" && shiftKey);
  if (currentIndex < 0) return backwards ? itemCount - 1 : 0;
  const next = currentIndex + (backwards ? -1 : 1);
  return next < 0 ? itemCount - 1 : next >= itemCount ? 0 : next;
}

/**
 * Keeps Crepe's own toolbar positioning/commands, while gating visibility on a
 * stable text selection. Pointer drags stay hidden; mouse-up and keyboard
 * selections become ready on the next paint, with live eligibility rechecked.
 */
export function createSelectionToolbarController(
  options: SelectionToolbarControllerOptions,
): SelectionToolbarController {
  const requestFrame = options.requestFrame ?? requestAnimationFrame;
  const cancelFrame = options.cancelFrame ?? cancelAnimationFrame;
  let pendingFrame: number | undefined;
  let pointerSelecting = false;
  let disposed = false;

  const cancelPendingFrame = () => {
    if (pendingFrame != null) cancelFrame(pendingFrame);
    pendingFrame = undefined;
  };
  const hide = () => {
    cancelPendingFrame();
    options.setReady(false);
  };
  const schedule = () => {
    hide();
    if (disposed || pointerSelecting || !options.isEligible()) return;
    pendingFrame = requestFrame(() => {
      pendingFrame = undefined;
      if (!disposed && !pointerSelecting && options.isEligible()) options.setReady(true);
    });
  };

  return {
    pointerDown() {
      pointerSelecting = true;
      hide();
    },
    pointerUp() {
      if (!pointerSelecting) return;
      pointerSelecting = false;
      schedule();
    },
    selectionChanged() {
      if (pointerSelecting) hide();
      else schedule();
    },
    keyboardSelection: schedule,
    dismiss() {
      pointerSelecting = false;
      hide();
    },
    dispose() {
      disposed = true;
      pointerSelecting = false;
      hide();
    },
  };
}
