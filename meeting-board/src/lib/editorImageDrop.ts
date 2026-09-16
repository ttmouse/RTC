export const EDITOR_IMAGE_DROP_EVENT = "omia:editor-image-drop";

export type EditorImageDropDetail = {
  paths: string[];
  clientX: number;
  clientY: number;
};

export type EditorImageInsertionInput = {
  target: {
    pos: number;
    index: number;
    nodeSize: number;
    blankImage: boolean;
    emptyText: boolean;
    dropAfter: boolean;
  } | null;
  documentSize: number;
  protectFirst: boolean;
  protectedFirstEnd: number;
};

export type EditorImageInsertion = { from: number; to: number; appendParagraph: boolean };

export type NativeDragPosition = { x: number; y: number };

const EDITOR_IMAGE_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif",
]);

export function isSupportedEditorImagePath(path: string): boolean {
  const clean = path.split(/[?#]/, 1)[0] ?? "";
  const extension = clean.match(/\.([^.\\/]+)$/)?.[1]?.toLocaleLowerCase() ?? "";
  return EDITOR_IMAGE_EXTENSIONS.has(extension);
}

export function isSupportedEditorImageFile(file: Pick<File, "name" | "type">): boolean {
  return file.type.toLocaleLowerCase().startsWith("image/") || isSupportedEditorImagePath(file.name);
}

export function pointInsideRect(
  clientX: number,
  clientY: number,
  rect: Pick<DOMRect, "left" | "right" | "top" | "bottom">,
): boolean {
  return clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom;
}

/**
 * Omia intentionally uses a Mac-shaped WebView user agent on every platform, so UA sniffing
 * cannot distinguish WebView2 from WKWebView. `navigator.platform` remains `Win32` on the
 * Windows build and is already the app's source for platform-specific editor shortcuts.
 */
export function isMacOSDragHost(platform: string): boolean {
  return /Mac|iPhone|iPad/i.test(platform);
}

/**
 * Tauri 2 currently exposes every native drop position as `PhysicalPosition`, but Wry's
 * macOS backend obtains the value from `NSDraggingInfo.draggingLocation()`. Cocoa returns
 * that value in logical points, while WebView2 returns physical client pixels. Dividing the
 * macOS value again on a Retina screen shifts the hit point toward the top-left and can send
 * an editor image drop down the global "open file" path.
 */
export function nativeDragPositionToClient(
  position: NativeDragPosition,
  scaleFactor: number,
  macOS: boolean,
): NativeDragPosition {
  const divisor = macOS ? 1 : (Number.isFinite(scaleFactor) && scaleFactor > 0 ? scaleFactor : 1);
  return { x: position.x / divisor, y: position.y / divisor };
}

/**
 * 只有“全是可内嵌图片 + 明确落在可视编辑画布内”才改道为插图。
 * 混合文件、非图片和编辑器外落点继续交给 Omia 原有的打开文件/文件夹流程。
 */
export function shouldRouteDropToEditor(
  paths: string[],
  clientX: number,
  clientY: number,
  editorRect: Pick<DOMRect, "left" | "right" | "top" | "bottom"> | null,
): boolean {
  return paths.length > 0
    && paths.every(isSupportedEditorImagePath)
    && editorRect !== null
    && pointInsideRect(clientX, clientY, editorRect);
}

/** 计算顶层图片块的替换/插入边界；首块标题保护与文末续写行在这里集中锁死。 */
export function resolveEditorImageInsertion(input: EditorImageInsertionInput): EditorImageInsertion {
  let from = input.documentSize;
  let to = from;
  const target = input.target;
  if (target) {
    const mayReplace = target.blankImage || (target.emptyText && !(input.protectFirst && target.index === 0));
    if (mayReplace) {
      from = target.pos;
      to = target.pos + target.nodeSize;
    } else {
      from = target.pos + (target.dropAfter ? target.nodeSize : 0);
      to = from;
    }
  }
  if (input.protectFirst && from < input.protectedFirstEnd) {
    from = input.protectedFirstEnd;
    to = Math.max(to, from);
  }
  return { from, to, appendParagraph: to >= input.documentSize };
}
