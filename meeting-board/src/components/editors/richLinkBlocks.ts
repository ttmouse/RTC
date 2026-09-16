// Omia 富链接块：底层仍是标准 Markdown link，title 里的 `omia:*` 只是渐进增强标记。
// 装饰插件只加 class/data attribute，不新增 schema、不改序列化，其他 Markdown 编辑器可无损降级。
import { $prose } from "@milkdown/kit/utils";
import type { Node as ProseNode } from "@milkdown/kit/prose/model";
import { Plugin, PluginKey } from "@milkdown/kit/prose/state";
import { Decoration, DecorationSet } from "@milkdown/kit/prose/view";
import type { RichLinkKind } from "./editorHelpers";

const RICH_LINK_TITLE_RE = /^omia:(bookmark|audio|video|file)$/;

function richLinkKind(node: ProseNode): RichLinkKind | null {
  if (node.type.name !== "paragraph" || !node.content.size) return null;
  let kind: RichLinkKind | null = null;
  let valid = true;
  node.forEach((child) => {
    const link = child.marks.find((mark) => mark.type.name === "link");
    const match = typeof link?.attrs.title === "string" ? link.attrs.title.match(RICH_LINK_TITLE_RE) : null;
    if (!match || (kind && kind !== match[1])) valid = false;
    else kind = match[1] as RichLinkKind;
  });
  return valid ? kind : null;
}

export const richLinkDecorations = $prose(
  () => new Plugin({
    key: new PluginKey("omia-rich-link-blocks"),
    props: {
      decorations(state) {
        const decorations: Decoration[] = [];
        state.doc.forEach((node, pos) => {
          const kind = richLinkKind(node);
          if (!kind) return;
          decorations.push(Decoration.node(pos, pos + node.nodeSize, {
            class: `omia-rich-link-block omia-rich-link-block--${kind}`,
            "data-omia-rich-link": kind,
          }));
        });
        return DecorationSet.create(state.doc, decorations);
      },
    },
  }),
);

export function richLinkIcon(kind: RichLinkKind): string {
  if (kind === "audio") return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M9 18V6l10-2v12"/><circle cx="6" cy="18" r="3"/><circle cx="16" cy="16" r="3"/></svg>';
  if (kind === "video") return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="5" width="14" height="14" rx="2"/><path d="m17 10 4-2v8l-4-2z"/></svg>';
  if (kind === "file") return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M6 2h8l4 4v16H6z"/><path d="M14 2v5h5M9 13h6M9 17h6"/></svg>';
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M10 13a5 5 0 0 0 7.1.1l2-2a5 5 0 0 0-7.1-7.1l-1.1 1.1M14 11a5 5 0 0 0-7.1-.1l-2 2A5 5 0 0 0 12 20l1.1-1.1"/></svg>';
}
