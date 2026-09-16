import type { Ctx } from "@milkdown/kit/ctx";
import { imageBlockSchema } from "@milkdown/kit/component/image-block";
import { commandsCtx, editorViewCtx } from "@milkdown/kit/core";
import {
  addBlockTypeCommand,
  blockquoteSchema,
  bulletListSchema,
  clearTextInCurrentBlockCommand,
  codeBlockSchema,
  headingSchema,
  hrSchema,
  listItemSchema,
  orderedListSchema,
  paragraphSchema,
  setBlockTypeCommand,
  wrapInBlockTypeCommand,
} from "@milkdown/kit/preset/commonmark";
import { createTable } from "@milkdown/kit/preset/gfm";
import { TextSelection } from "@milkdown/kit/prose/state";
import { insertCallout } from "./callout";
import {
  getInsertCommandRegistry,
  isInsertCommandAvailable,
  type InsertCommandCapabilities,
  type InsertCommandId,
} from "./insertCommands";
import type { RichLinkKind } from "./editorHelpers";
import { clampTableSize, DEFAULT_TABLE_SIZE, type TableSize } from "./tableSizeModel";
import { createPersistentLayoutTransaction } from "./layoutInteraction";

export type InsertCommandEnvironment = {
  capabilities: InsertCommandCapabilities;
  openRichLink: (ctx: Ctx, kind: RichLinkKind) => void;
};

export type InsertCommandOptions = {
  tableSize?: TableSize;
  layoutColumns?: 2 | 3;
  /** Top-level position used by the complete “insert below” path. */
  insertAt?: number;
};

const richLinkKind = (id: InsertCommandId): RichLinkKind | null => {
  if (id === "bookmark" || id === "video" || id === "audio" || id === "file") return id;
  return null;
};

const insertTable = (ctx: Ctx, size: TableSize, insertAt?: number): boolean => {
  const view = ctx.get(editorViewCtx);
  const tableSize = clampTableSize(size);

  try {
    const table = createTable(ctx, tableSize.rows, tableSize.columns);
    let transaction = view.state.tr;
    let tableStart: number;
    if (insertAt != null) {
      if (!Number.isInteger(insertAt) || insertAt < 0 || insertAt > transaction.doc.content.size) return false;
      const $insert = transaction.doc.resolve(insertAt);
      if ($insert.depth !== 0) return false;
      tableStart = insertAt;
      transaction = transaction.insert(insertAt, table);
    } else {
      const { $from, $to } = transaction.selection;
      const blockContentStart = $from.pos - $from.parent.content.size;
      if (blockContentStart < 0) return false;
      transaction = transaction.deleteRange(blockContentStart, $to.pos);
      tableStart = transaction.selection.from;
      transaction = transaction.replaceSelectionWith(table);
    }
    const nearFirstCell = transaction.doc.resolve(
      Math.min(tableStart + 1, transaction.doc.content.size),
    );
    transaction = transaction
      .setSelection(TextSelection.near(nearFirstCell, 1))
      .scrollIntoView();
    if (!transaction.docChanged) return false;

    view.dispatch(transaction);
    view.focus();
    return true;
  } catch {
    return false;
  }
};

/** Slash 与浏览型 `+` 都只能从这里执行命令，避免两套事务随 UI 分化。 */
export function executeInsertCommand(
  ctx: Ctx,
  id: InsertCommandId,
  environment: InsertCommandEnvironment,
  options?: InsertCommandOptions,
): boolean {
  const command = getInsertCommandRegistry("slash").find((entry) => entry.id === id);
  if (!command || !isInsertCommandAvailable(command, environment.capabilities)) return false;

  const richKind = richLinkKind(id);
  if (richKind) {
    environment.openRichLink(ctx, richKind);
    return true;
  }
  if (id.startsWith("callout-")) {
    insertCallout(ctx, id.slice("callout-".length));
    return true;
  }
  if (id === "table") {
    return insertTable(ctx, options?.tableSize ?? DEFAULT_TABLE_SIZE, options?.insertAt);
  }
  if (id === "columns") {
    const view = ctx.get(editorViewCtx);
    const transaction = createPersistentLayoutTransaction(view.state, {
      columns: options?.layoutColumns ?? 2,
      insertAt: options?.insertAt,
    });
    if (!transaction?.docChanged) return false;
    view.dispatch(transaction.scrollIntoView());
    view.focus();
    return true;
  }

  const commands = ctx.get(commandsCtx);
  const clear = () => commands.call(clearTextInCurrentBlockCommand.key);
  if (id === "text") {
    clear();
    commands.call(setBlockTypeCommand.key, { nodeType: paragraphSchema.type(ctx) });
  } else if (/^h[1-6]$/.test(id)) {
    clear();
    commands.call(setBlockTypeCommand.key, {
      nodeType: headingSchema.type(ctx),
      attrs: { level: Number(id.slice(1)) },
    });
  } else if (id === "quote") {
    clear();
    commands.call(wrapInBlockTypeCommand.key, { nodeType: blockquoteSchema.type(ctx) });
  } else if (id === "divider") {
    clear();
    commands.call(addBlockTypeCommand.key, { nodeType: hrSchema.type(ctx) });
  } else if (id === "bullet-list") {
    clear();
    commands.call(wrapInBlockTypeCommand.key, { nodeType: bulletListSchema.type(ctx) });
  } else if (id === "ordered-list") {
    clear();
    commands.call(wrapInBlockTypeCommand.key, { nodeType: orderedListSchema.type(ctx) });
  } else if (id === "task-list") {
    clear();
    commands.call(wrapInBlockTypeCommand.key, {
      nodeType: listItemSchema.type(ctx),
      attrs: { checked: false },
    });
  } else if (id === "image") {
    clear();
    commands.call(addBlockTypeCommand.key, { nodeType: imageBlockSchema.type(ctx) });
  } else if (id === "code") {
    clear();
    commands.call(setBlockTypeCommand.key, { nodeType: codeBlockSchema.type(ctx) });
  } else if (id === "math") {
    clear();
    commands.call(addBlockTypeCommand.key, {
      nodeType: codeBlockSchema.type(ctx),
      attrs: { language: "LaTeX" },
    });
  } else {
    return false;
  }

  ctx.get(editorViewCtx).focus();
  return true;
}
