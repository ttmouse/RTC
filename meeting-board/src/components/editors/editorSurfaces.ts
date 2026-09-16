export type BlockingEditorSurface =
  | "slash-menu"
  | "insert-menu"
  | "block-menu"
  | "rich-link-dialog"
  | "link-display-picker"
  | "link-toolbar"
  | "link-tooltip"
  | "node-toolbar";

export type TableSizePickerSource = "slash" | "browse" | "below" | null;
export type SlashTableSizePickerCaptureAction = "move" | "select" | "cancel" | null;

export function resolveSlashTableSizePickerCaptureAction(
  tableSizePickerSource: TableSizePickerSource,
  key: string,
): SlashTableSizePickerCaptureAction {
  if (tableSizePickerSource !== "slash") return null;
  if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"].includes(key)) return "move";
  if (key === "Enter") return "select";
  if (key === "Escape" || key === "Tab") return "cancel";
  return null;
}

/**
 * The slash listener runs in the capture phase, before the picker can stop
 * propagation. The open picker therefore owns the keys by state as well as
 * by DOM target; WKWebView can retarget an active-descendant key to the editor.
 */
export function shouldSlashMenuOwnKeyEvent(
  tableSizePickerSource: TableSizePickerSource,
  eventTargetInsidePicker: boolean,
): boolean {
  return tableSizePickerSource !== "slash" && !eventTargetInsidePicker;
}

const SURFACE_SELECTORS: ReadonlyArray<readonly [BlockingEditorSurface, string]> = [
  ["insert-menu", ".editor-browse-insert-menu"],
  ["block-menu", ".editor-block-menu"],
  ["rich-link-dialog", ".editor-rich-link-dialog"],
  ["link-display-picker", ".editor-link-display-picker"],
  ["link-toolbar", ".editor-link-toolbar"],
  ["slash-menu", '#omia-slash-command-menu, .milkdown-slash-menu:not([data-show="false"])'],
  ["link-tooltip", '.milkdown-link-preview[data-show="true"], .milkdown-link-edit[data-show="true"]'],
  ["node-toolbar", [
    ".editor-node-toolbar",
    ".milkdown-image-block.selected",
    ".milkdown-table-block .selectedCell",
    '.milkdown-latex-inline-edit[data-show="true"]',
  ].join(", ")],
];

/** Returns the primary surface that owns the current editor intent, if any. */
export function findBlockingEditorSurface(
  host: ParentNode,
  selectionNode?: Node | null,
): BlockingEditorSurface | null {
  const selectionElement = selectionNode instanceof Element
    ? selectionNode
    : selectionNode?.parentElement;
  if (selectionElement?.closest(".cm-editor, [data-omia-advanced-table-view='1'], table[data-omia-table='1']")) {
    return "node-toolbar";
  }

  for (const [surface, selector] of SURFACE_SELECTORS) {
    if (host.querySelector(selector)) return surface;
  }
  return null;
}

/** Link hover/edit chrome yields to a real text range; structural surfaces do not. */
export function canTextSelectionOwnSurface(surface: BlockingEditorSurface | null): boolean {
  return surface === null || surface === "link-toolbar" || surface === "link-tooltip";
}
