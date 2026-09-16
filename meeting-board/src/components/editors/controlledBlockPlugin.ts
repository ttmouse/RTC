import type { Processor } from "unified";
import type { Root } from "mdast";
import { $nodeSchema, $remark } from "@milkdown/kit/utils";
import {
  controlledAlignmentClosing,
  controlledAlignmentOpening,
  parseControlledAlignmentOpening,
  type ControlledBlockAlignment,
} from "../../lib/controlledBlockFormat";

export const CONTROLLED_ALIGNED_PARAGRAPH_NAME = "omiaAlignedParagraph";

type MdNode = {
  type: string;
  value?: string;
  align?: ControlledBlockAlignment;
  children?: MdNode[];
  [key: string]: unknown;
};

function transformChildren(children: MdNode[]): MdNode[] {
  const output: MdNode[] = [];
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index]!;
    const next = children[index + 1];
    const close = children[index + 2];
    const htmlValue = (node: MdNode | undefined) => node?.type === "html" && typeof node.value === "string"
      ? node.value
      : node?.type === "paragraph" && node.children?.length === 1
        && node.children[0]?.type === "html" && typeof node.children[0].value === "string"
        ? node.children[0].value
        : null;
    const opening = htmlValue(child);
    const alignment = opening ? parseControlledAlignmentOpening(opening) : null;
    if (alignment && next?.type === "paragraph" && htmlValue(close) === controlledAlignmentClosing()) {
      output.push({ type: CONTROLLED_ALIGNED_PARAGRAPH_NAME, align: alignment, children: next.children ?? [] });
      index += 2;
      continue;
    }
    output.push(transformControlledBlockAst(child));
  }
  return output;
}

export function transformControlledBlockAst(tree: MdNode): MdNode {
  if (tree.children) tree.children = transformChildren(tree.children);
  return tree;
}

const controlledBlockRemark = $remark("omiaControlledBlockRemark", () => function controlledBlockRemark(this: Processor) {
  const data = this.data() as Record<string, unknown>;
  const extensions = (data.toMarkdownExtensions as unknown[] | undefined) ?? [];
  data.toMarkdownExtensions = [
    ...extensions,
    {
      handlers: {
        [CONTROLLED_ALIGNED_PARAGRAPH_NAME]: (node: MdNode, _parent: unknown, state: {
          enter: (name: string) => () => void;
          containerPhrasing: (node: MdNode, info: Record<string, unknown>) => string;
        }, info: Record<string, unknown>) => {
          const alignment = node.align === "right" ? "right" : "center";
          const opening = controlledAlignmentOpening(alignment);
          const closing = controlledAlignmentClosing();
          const exit = state.enter("paragraph");
          const content = state.containerPhrasing(node, { ...info, before: opening, after: closing });
          exit();
          return `${opening}\n\n${content}\n\n${closing}`;
        },
      },
    },
  ];
  return (tree: Root) => transformControlledBlockAst(tree as MdNode) as Root;
});

export const controlledAlignedParagraphSchema = $nodeSchema(CONTROLLED_ALIGNED_PARAGRAPH_NAME, () => ({
  content: "inline*",
  group: "block",
  attrs: {
    align: { validate: (value: unknown) => value === "center" || value === "right" },
  },
  parseDOM: [{
    tag: "div[data-omia-align]",
    getAttrs: (element) => {
      if (!(element instanceof HTMLDivElement) || element.attributes.length !== 1) return false;
      const align = element.getAttribute("data-omia-align");
      return align === "center" || align === "right" ? { align } : false;
    },
  }],
  toDOM: (node) => ["div", { "data-omia-align": node.attrs.align }, 0],
  parseMarkdown: {
    match: (node) => node.type === CONTROLLED_ALIGNED_PARAGRAPH_NAME && (node.align === "center" || node.align === "right"),
    runner: (state, node, type) => {
      state.openNode(type, { align: node.align });
      if (node.children) state.next(node.children);
      state.closeNode();
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === CONTROLLED_ALIGNED_PARAGRAPH_NAME,
    runner: (state, node) => {
      state.openNode(CONTROLLED_ALIGNED_PARAGRAPH_NAME, undefined, { align: node.attrs.align });
      state.next(node.content);
      state.closeNode();
    },
  },
}));

export const controlledBlockPlugins = [
  ...controlledBlockRemark,
  ...controlledAlignedParagraphSchema,
];
