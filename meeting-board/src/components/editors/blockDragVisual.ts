import { clearBlockVisualState } from "./blockUi";

export const BLOCK_DRAG_GHOST_MAX_BLOCKS = 3;
export const BLOCK_DRAG_GHOST_MAX_TEXT = 360;

const BLOCK_DRAG_GHOST_MIN_WIDTH = 280;
const BLOCK_DRAG_GHOST_VIEWPORT_GUTTER = 32;
const BLOCK_DRAG_GHOST_MAX_NODES = 120;
const SENSITIVE_PREVIEW_SELECTOR = [
  "button",
  "input",
  "textarea",
  "select",
  "audio",
  "video",
  "iframe",
  "object",
  "embed",
  "canvas",
  "[data-omia-drag-sensitive]",
  "[contenteditable='true']",
  "[role='button']",
  "[role='menu']",
  ".milkdown-block-handle",
].join(",");

type BlockDragGhostInput = {
  sourceTargets: readonly HTMLElement[];
  sourceWidth: number;
  viewportWidth: number;
  lang: "zh" | "en";
};

type BlockDragVisualCleanupInput = {
  host: HTMLElement;
  sourceTargets: readonly HTMLElement[];
  dropTarget: HTMLElement | null;
  dropLine: HTMLElement | null;
  ghost: HTMLElement | null;
  pointerId: number | null;
  status: HTMLElement | null;
};

export function resolveBlockDragGhostWidth(sourceWidth: number, viewportWidth: number): number {
  const available = Math.max(1, Math.round(viewportWidth) - BLOCK_DRAG_GHOST_VIEWPORT_GUTTER);
  const preferred = Math.max(BLOCK_DRAG_GHOST_MIN_WIDTH, Math.round(sourceWidth));
  return Math.min(preferred, available);
}

export function clearBlockDragVisuals(input: BlockDragVisualCleanupInput): void {
  const status = input.status ?? "omia-block-state-status";
  input.sourceTargets.forEach((target) => clearBlockVisualState(target, "drag-source", status));
  if (input.dropTarget) clearBlockVisualState(input.dropTarget, "drag-target", status);
  input.dropLine?.remove();
  input.ghost?.remove();
  input.host.classList.remove("is-block-pointer-dragging");
  if (
    input.pointerId != null
    && input.host.hasPointerCapture?.(input.pointerId)
  ) input.host.releasePointerCapture(input.pointerId);
}

function removePreviewInteractions(root: HTMLElement): void {
  root.querySelectorAll<HTMLElement>(SENSITIVE_PREVIEW_SELECTOR).forEach((node) => node.remove());
  root.querySelectorAll<HTMLElement>("*").forEach((node) => {
    for (const attribute of [
      "id", "name", "tabindex", "contenteditable", "autofocus", "aria-controls", "aria-describedby",
      "aria-labelledby", "aria-owns", "aria-activedescendant", "href", "srcdoc",
    ]) node.removeAttribute(attribute);
    node.draggable = false;
  });
}

function normalizedPreviewText(source: HTMLElement): string {
  return (source.textContent ?? "").replace(/\s+/g, " ").trim();
}

function truncatePreviewText(root: HTMLElement, fallback: string): boolean {
  if (root.querySelectorAll("*").length > BLOCK_DRAG_GHOST_MAX_NODES) {
    root.replaceChildren(document.createTextNode(fallback.slice(0, BLOCK_DRAG_GHOST_MAX_TEXT)));
    if (fallback.length > BLOCK_DRAG_GHOST_MAX_TEXT) root.append("…");
    return true;
  }

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) textNodes.push(node as Text);
  let remaining = BLOCK_DRAG_GHOST_MAX_TEXT;
  let truncated = false;
  textNodes.forEach((node) => {
    const value = node.data;
    if (remaining <= 0) {
      if (value.length > 0) truncated = true;
      node.data = "";
      return;
    }
    if (value.length <= remaining) {
      remaining -= value.length;
      return;
    }
    node.data = `${value.slice(0, remaining).trimEnd()}…`;
    remaining = 0;
    truncated = true;
  });
  return truncated;
}

function createPreviewBlock(source: HTMLElement): { block: HTMLElement; truncated: boolean } {
  const fallback = normalizedPreviewText(source);
  const block = source.cloneNode(true) as HTMLElement;
  block.classList.remove(
    "block-selected-single",
    "block-selected-multi",
    "block-drag-source",
    "block-drag-target",
    "block-menu-target",
  );
  block.classList.add("editor-block-drag-ghost__block");
  block.removeAttribute("id");
  block.removeAttribute("aria-describedby");
  block.removeAttribute("contenteditable");
  block.draggable = false;
  removePreviewInteractions(block);
  return { block, truncated: truncatePreviewText(block, fallback) };
}

export function createBlockDragGhost(input: BlockDragGhostInput): HTMLElement {
  const ghost = document.createElement("div");
  ghost.className = "editor-block-drag-ghost";
  ghost.setAttribute("aria-hidden", "true");
  ghost.style.width = `${resolveBlockDragGhostWidth(input.sourceWidth, input.viewportWidth)}px`;

  const grip = document.createElement("span");
  grip.className = "editor-block-drag-ghost__grip";

  const body = document.createElement("div");
  body.className = "editor-block-drag-ghost__body";
  if (input.sourceTargets.length > 1) {
    const count = document.createElement("span");
    count.className = "editor-block-drag-ghost__count";
    count.textContent = input.lang === "en"
      ? `${input.sourceTargets.length} blocks`
      : `${input.sourceTargets.length} 个区块`;
    body.appendChild(count);
  }

  const preview = document.createElement("div");
  preview.className = "editor-block-drag-ghost__preview";
  let truncated = false;
  input.sourceTargets.slice(0, BLOCK_DRAG_GHOST_MAX_BLOCKS).forEach((source) => {
    const result = createPreviewBlock(source);
    preview.appendChild(result.block);
    truncated ||= result.truncated;
  });
  body.appendChild(preview);

  const remaining = Math.max(0, input.sourceTargets.length - BLOCK_DRAG_GHOST_MAX_BLOCKS);
  if (remaining > 0) {
    truncated = true;
    const more = document.createElement("span");
    more.className = "editor-block-drag-ghost__more";
    more.textContent = input.lang === "en" ? `+${remaining} blocks` : `另有 ${remaining} 个区块`;
    body.appendChild(more);
  }
  if (truncated) ghost.classList.add("is-truncated");
  ghost.append(grip, body);
  return ghost;
}
