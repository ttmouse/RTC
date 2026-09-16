import MarkdownIt from "markdown-it";
import type { EditorState, Transaction } from "@milkdown/kit/prose/state";

export const IMAGE_RATIO_METADATA_RE = /^\s*<!-- omia:image-ratio=(\d+(?:\.\d+)?) -->\s*$/;

const markdown = new MarkdownIt({ html: true });
const LEGACY_RATIO_RE = /^(?:\d+(?:\.\d+)?|\.\d+)$/;

type StandaloneImage = {
  start: number;
  end: number;
  src: string;
  alt: string;
  title: string;
};

function standaloneImages(source: string): StandaloneImage[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const tokens = markdown.parse(source, {});
  const images: StandaloneImage[] = [];
  for (let index = 0; index + 2 < tokens.length; index++) {
    const open = tokens[index];
    const inline = tokens[index + 1];
    const close = tokens[index + 2];
    if (open.type !== "paragraph_open" || inline.type !== "inline" || close.type !== "paragraph_close") continue;
    if (!inline.map || inline.map[1] - inline.map[0] !== 1 || inline.children?.length !== 1) continue;
    const image = inline.children[0];
    if (image.type !== "image" || !/^ {0,3}!\[/.test(lines[inline.map[0]] ?? "")) continue;
    images.push({
      start: inline.map[0],
      end: inline.map[1],
      src: image.attrGet("src") ?? "",
      alt: image.content ?? "",
      title: image.attrGet("title") ?? "",
    });
    index += 2;
  }
  return images;
}

function escapeAlt(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/([\[\]])/g, "\\$1").replace(/\s*\n\s*/g, " ");
}

function destination(value: string): string {
  if (/[\s<>]/.test(value)) return `<${value.replace(/\\/g, "\\\\").replace(/>/g, "\\>")}>`;
  return value.replace(/([\\()])/g, "\\$1");
}

function title(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\s*\n\s*/g, " ");
}

function imageSyntax(alt: string, src: string, imageTitle = ""): string {
  return `![${escapeAlt(alt)}](${destination(src)}${imageTitle ? ` "${title(imageTitle)}"` : ""})`;
}

/** Converts portable on-disk Markdown into the existing image-block schema's ratio/caption convention. */
export function preparePortableImageMarkdown(source: string): string {
  const normalized = source.replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  for (const image of standaloneImages(normalized).reverse()) {
    const metadata = lines[image.end]?.match(IMAGE_RATIO_METADATA_RE);
    if (!metadata && LEGACY_RATIO_RE.test(image.alt.trim())) continue;
    const ratio = metadata ? Number(metadata[1]) : 1;
    const safeRatio = Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
    const description = image.alt.trim() || image.title.trim();
    const internal = imageSyntax(safeRatio.toFixed(2), image.src, description);
    lines.splice(image.start, image.end - image.start + (metadata ? 1 : 0), internal);
  }
  return lines.join("\n");
}

/** Converts the existing image-block serializer output to semantic alt plus invisible Omia ratio metadata. */
export function serializePortableImageMarkdown(source: string): string {
  const normalized = source.replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  for (const image of standaloneImages(normalized).reverse()) {
    if (!LEGACY_RATIO_RE.test(image.alt.trim())) continue;
    const ratio = Number(image.alt);
    const safeRatio = Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
    const portable = `${imageSyntax(image.title, image.src)}\n<!-- omia:image-ratio=${safeRatio.toFixed(2)} -->`;
    const existingMetadata = lines[image.end]?.match(IMAGE_RATIO_METADATA_RE);
    lines.splice(image.start, image.end - image.start + (existingMetadata ? 1 : 0), portable);
  }
  return lines.join("\n");
}

type GuardedImageRange = { pos: number; nodeSize: number };

function normalizeImageSource(raw: string): string | null {
  const value = raw.trim();
  if (!value || /[\u0000-\u001f\u007f]/.test(value)) return null;
  if (/^data:/i.test(value)) return /^data:image\/(?:png|jpe?g|gif|webp|avif|bmp|svg\+xml)[;,]/i.test(value) ? value : null;
  const windowsPath = /^[a-z]:[\\/]/i.test(value);
  const scheme = windowsPath ? "" : (value.match(/^([a-z][a-z0-9+.-]*):/i)?.[1].toLowerCase() ?? "");
  if (scheme && !["http", "https", "file", "asset"].includes(scheme)) return null;
  return value;
}

export function editImageNode(
  state: EditorState,
  target: GuardedImageRange,
  update: { caption?: string; src?: string },
): Transaction | null {
  const node = state.doc.nodeAt(target.pos);
  if (!node || node.type.name !== "image-block" || node.nodeSize !== target.nodeSize) return null;
  const src = update.src === undefined ? String(node.attrs.src ?? "") : normalizeImageSource(update.src);
  if (src === null) return null;
  const caption = update.caption === undefined ? String(node.attrs.caption ?? "") : update.caption.trim();
  if (src === node.attrs.src && caption === node.attrs.caption) return null;
  return state.tr.setNodeMarkup(target.pos, undefined, { ...node.attrs, src, caption }, node.marks);
}
