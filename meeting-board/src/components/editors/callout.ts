// Notion 式「提示框 / callout」——纯装饰层实现，不新增 ProseMirror schema 节点。
// 底层始终是标准 blockquote，首段为 GFM 警告标记 [!NOTE] 等时，装饰成带图标+底色的提示框。
// 存回 markdown 永远是 `> [!NOTE]\n>\n> 内容`（标准 GFM alert），换任何编辑器打开都无损降级为引用块。
import { $prose } from "@milkdown/kit/utils";
import { editorViewCtx } from "@milkdown/kit/core";
import type { Ctx } from "@milkdown/kit/ctx";
import { Plugin, PluginKey, TextSelection } from "@milkdown/kit/prose/state";
import { Decoration, DecorationSet } from "@milkdown/kit/prose/view";

// 首段「整段」恰为 [!TYPE]（允许前后空白）才算 callout，避免误伤普通引用。
const CALLOUT_RE = /^\s*\[!(note|tip|important|warning|caution)\]\s*$/i;

// 装饰插件：把符合条件的 blockquote 画成提示框。
export const calloutDecorations = $prose(
  () =>
    new Plugin({
      key: new PluginKey("xiaoer-callout"),
      props: {
        decorations(state) {
          const decos: Decoration[] = [];
          state.doc.descendants((node, pos) => {
            if (node.type.name !== "blockquote") return;
            const first = node.firstChild;
            if (!first) return;
            const m = first.textContent.match(CALLOUT_RE);
            if (!m) return;
            const type = m[1].toLowerCase();
            // 整个 blockquote 套提示框样式
            decos.push(
              Decoration.node(pos, pos + node.nodeSize, {
                class: `crepe-callout crepe-callout-${type}`,
              })
            );
            // 首段（[!TYPE] 标记行）→ 标题样式（CSS 隐藏原文、用 ::before 显示中文标题+图标）
            const tagFrom = pos + 1;
            decos.push(
              Decoration.node(tagFrom, tagFrom + first.nodeSize, {
                class: "crepe-callout-tag",
              })
            );
          });
          return DecorationSet.create(state.doc, decos);
        },
      },
    })
);

// 五种提示框类型（顺序=斜杠菜单显示顺序），color 用于菜单小图标着色，与 CSS 配色一致。
// zh/en 为菜单项文案；CSS 里的标题（::before）另按 .lang-en 切换，二者保持一致。
export const CALLOUT_TYPES = [
  { type: "note", zh: "笔记", en: "Note", color: "var(--c-warn-69)" },
  { type: "tip", zh: "提示", en: "Tip", color: "var(--accent-deep)" },
  { type: "important", zh: "重要", en: "Important", color: "var(--c-warn-70)" },
  { type: "warning", zh: "注意", en: "Warning", color: "var(--c-warn-44)" },
  { type: "caution", zh: "警告", en: "Caution", color: "var(--c-warn-6)" },
] as const;

// 斜杠菜单项图标：info 圆圈，按类型着色（fill 直接覆盖 currentColor，菜单里就是彩色）。
export function calloutIcon(color: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="20" height="20" fill="${color}"><path d="M11 7h2v2h-2zm0 4h2v6h-2zm1-9C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8z"/></svg>`;
}

// 斜杠菜单「提示框」项的插入动作：当前块替换为指定类型的 callout，光标落内容段。
export function insertCallout(ctx: Ctx, type: string = "note"): void {
  const view = ctx.get(editorViewCtx);
  const { state } = view;
  const blockquote = state.schema.nodes.blockquote;
  const paragraph = state.schema.nodes.paragraph;
  if (!blockquote || !paragraph) return;
  const marker = paragraph.create(null, state.schema.text(`[!${type.toUpperCase()}]`));
  const body = paragraph.create();
  const callout = blockquote.createChecked(null, [marker, body]);
  const { $from } = state.selection;
  const from = $from.before($from.depth);
  const to = $from.after($from.depth);
  let tr = state.tr.replaceWith(from, to, callout);
  // 光标进入内容段：from + 进入 blockquote(1) + 跳过标记段 + 进入内容段(1)
  const bodyStart = from + 1 + marker.nodeSize + 1;
  tr = tr.setSelection(
    TextSelection.create(tr.doc, Math.min(bodyStart, tr.doc.content.size - 1))
  );
  view.dispatch(tr.scrollIntoView());
  view.focus();
}
