import { patchMarkdownBlocks } from "../../lib/markdownBlockPatch";
import type { MarkdownEditRisk } from "../../lib/markdownFidelity";

export type GuardedMarkdownChange = {
  publish: boolean;
  markdown: string;
};

export type MarkdownRewriteInfo = {
  /** 用了编辑器结果（即会被按可视化写法改写）的块数。 */
  changedBlocks: number;
  /** 这些块里原本含有的高级语法——会在保存时被改写，保存前要提示用户。 */
  rewrittenRisks: MarkdownEditRisk[];
};

/**
 * Crepe may dispatch a document-changing setup transaction after parsing the
 * initial source (for example, to add its trailing paragraph). Its listener
 * then serializes the whole document even though the user has not edited it.
 *
 * Keep the exact source until the serialized document actually diverges from
 * the editor's ready-state baseline. Returning to that baseline through undo
 * restores the exact original bytes instead of the parser's normalized form.
 */
export function createInitialMarkdownChangeGuard(source: string) {
  let readyBaseline: string | undefined;
  let queuedBeforeReady: string | undefined;
  let lastPublished = source;
  let lastRewrite: MarkdownRewriteInfo = { changedBlocks: 0, rewrittenRisks: [] };
  const exactOverrides = new Map<string, string>();

  // 分块保真（2026-09-09）：序列化一旦偏离 baseline，不再整篇采用编辑器写法，而是只替换真改过的块，
  // 其余块回填原文字节——<mark>、代码围栏标题、Front Matter、脚注全都留在原地。
  const resolve = (serialized: string): GuardedMarkdownChange => {
    let markdown = exactOverrides.get(serialized);
    if (markdown === undefined) {
      if (serialized === readyBaseline || readyBaseline === undefined) {
        markdown = serialized === readyBaseline ? source : serialized;
        lastRewrite = { changedBlocks: 0, rewrittenRisks: [] };
      } else {
        const patched = patchMarkdownBlocks({ original: source, baseline: readyBaseline, edited: serialized });
        markdown = patched.markdown;
        lastRewrite = { changedBlocks: patched.changedBlocks, rewrittenRisks: patched.rewrittenRisks };
      }
    }
    if (markdown === lastPublished) return { publish: false, markdown };
    lastPublished = markdown;
    return { publish: true, markdown };
  };

  return {
    /** 最近一次 resolve 的改写情况（给保存前提示用）。 */
    rewriteInfo(): MarkdownRewriteInfo {
      return lastRewrite;
    },
    markReady(serialized: string): GuardedMarkdownChange {
      if (readyBaseline === undefined) readyBaseline = serialized;
      if (queuedBeforeReady === undefined) return { publish: false, markdown: source };
      const queued = queuedBeforeReady;
      queuedBeforeReady = undefined;
      return resolve(queued);
    },
    next(serialized: string): GuardedMarkdownChange {
      if (readyBaseline === undefined) {
        queuedBeforeReady = serialized;
        return { publish: false, markdown: source };
      }
      return resolve(serialized);
    },
    registerExact(serialized: string, exactMarkdown: string): GuardedMarkdownChange {
      exactOverrides.set(serialized, exactMarkdown);
      if (exactMarkdown === lastPublished) return { publish: false, markdown: exactMarkdown };
      lastPublished = exactMarkdown;
      return { publish: true, markdown: exactMarkdown };
    },
  };
}
