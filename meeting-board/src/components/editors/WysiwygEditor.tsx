import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { Ctx } from "@milkdown/kit/ctx";
import { Crepe, CrepeFeature } from "@milkdown/crepe";
import { commandsCtx, editorViewCtx, schemaCtx, serializerCtx } from "@milkdown/kit/core";
import { imageBlockSchema } from "@milkdown/kit/component/image-block";
import {
  blockquoteSchema,
  bulletListSchema,
  headingSchema,
  listItemSchema,
  orderedListSchema,
  paragraphSchema,
  setBlockTypeCommand,
  wrapInBlockTypeCommand,
} from "@milkdown/kit/preset/commonmark";
import { NodeSelection, Selection, TextSelection, type EditorState, type Transaction } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";
import type { Node as ProseNode } from "@milkdown/kit/prose/model";
import { oneDark } from "@codemirror/theme-one-dark";
import { replaceAll } from "@milkdown/utils";
import { languages as codeLanguages } from "@codemirror/language-data";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { invoke } from "@tauri-apps/api/core";
import { useLang } from "../../lib/i18n";
import { isImeEnter } from "../../lib/imeGuard";
import { analyzeMarkdownEditSafety, extractFrontMatter, type MarkdownEditRisk } from "../../lib/markdownFidelity";
import { CONTROLLED_COLOR_TOKENS, type ControlledColorToken } from "../../lib/controlledInlineFormat";
import { calloutDecorations } from "./callout";
import {
  blockDragAutoScrollVelocity,
  blockGroupStepDestination,
  canMoveTopLevelBlock,
  imageFileToDataUrl,
  initialEditorValue,
  inspectNewDocument,
  isBlockHandleTap,
  isBlockDropPointUsable,
  resolveBlockGroupDropIndex,
  resolveBlockKeyboardAction,
  resolveSlashMenuLayout,
  resolveInsertMenuLeft,
  normalizeRichLinkInput,
  shouldStageSelectAll,
  slashCommandLabel,
  type RichLinkKind,
} from "./editorHelpers";
import { richLinkDecorations, richLinkIcon } from "./richLinkBlocks";
import { executeInsertCommand } from "./insertCommandExecutor";
import { TableSizePicker } from "./TableSizePicker";
import { DEFAULT_TABLE_SIZE, moveTableSize, type TableSize, type TableSizeNavigationKey } from "./tableSizeModel";
import {
  getInsertCommandRegistry,
  insertCommandIcon,
  isInsertCommandAvailable,
  searchInsertCommands,
  type InsertCommandBrowseCategory,
  type InsertCommandId,
  type InsertCommand,
} from "./insertCommands";
import {
  buildBrowseInsertMenu,
  canOwnSlashInsertMenu,
  canOpenBrowseInsertMenu,
  insertMenuStatus,
  moveInsertMenuActiveIndex,
  parseSlashInvocation,
  resolveBlockMenuShortcut,
  blockMenuShortcutHint,
  shouldReleaseNativeSlashMenu,
  shouldExecuteInsertMenuCommand,
  type SlashMenuCloseReason,
} from "./insertMenus";
import {
  createDirectionalTextSelectionTransaction,
  createSelectionToolbarController,
  resolveSelectionBlockType,
  selectionToolbarFallbackPosition,
  shouldApplySelectionToolbarFallback,
  shouldFinishSelectionPointer,
} from "./selectionToolbar";
import { decorateSelectionToolbarAccessibility } from "./selectionToolbarA11y";
import { installSelectionToolbarShell, type SelectionToolbarShell } from "./selectionToolbarShell";
import { controlledInlinePlugins } from "./controlledInlinePlugin";
import { controlledBlockPlugins } from "./controlledBlockPlugin";
import { advancedTablePlugins } from "./advancedTablePlugin";
import { persistentLayoutPlugins } from "./layoutPlugin";
import { advancedClipboardPlugin } from "./advancedClipboard";
import { safeClipboardImportPlugin, sanitizeUnknownClipboardHtmlWithReport } from "./safeClipboardImport";
import {
  bindVisualTitleToFirstH1,
  isPageTitlePosition,
  pageTitleIndex,
  pageTitlePlugin,
  resolvePageTitleBoundaryAction,
} from "./pageTitle";
import {
  controlledInlineSelectionState,
  createControlledInlineTransaction,
} from "./controlledInlineTransactions";
import {
  controlledBlockAlignmentState,
  createControlledBlockAlignmentTransaction,
} from "./controlledBlockTransactions";
import {
  createSelectionBlockConversionTransaction,
  selectionBlockSamplesForState,
} from "./selectionBlockConversion";
import { createInitialMarkdownChangeGuard, type MarkdownRewriteInfo } from "./markdownChangeGuard";
import {
  canTextSelectionOwnSurface,
  findBlockingEditorSurface,
  resolveSlashTableSizePickerCaptureAction,
  shouldSlashMenuOwnKeyEvent,
} from "./editorSurfaces";
import { classifyUrlPasteIntent } from "./linkIntent";
import {
  insertUrlPaste,
  editLinkHref,
  findLinkRangeAtPos,
  linkDomainFallback,
  replaceLinkDisplay,
  resolveLinkTitle,
  removeLink,
  safeNavigableHref,
  upgradeLinkToBookmark,
} from "./linkTransactions";
import {
  applyBlockVisualState,
  applyBlockSelectionOverlayState,
  blockMenuInsertCommands,
  buildBlockMenuInformationArchitecture,
  clearBlockVisualState,
  decorateBlockHandleEntry,
  isDuplicateBrowseAddCompatibilityClick,
  moveBlockMenuFocus,
  resolveBlockEntryDescriptor,
  shouldRunBlockMenuEnter,
  type BlockEntryType,
  type ConvertibleBlockType,
} from "./blockUi";
import { clearBlockDragVisuals, createBlockDragGhost } from "./blockDragVisual";
import {
  createBelowInsertAnchor,
  resolveBelowInsertAnchor,
  type BelowInsertAnchor,
} from "./belowInsertAnchor";
import {
  applyPortableNodeSelection,
  claimPortableNodeActivation,
  deletePortableNode,
  editRichLinkNodeSource,
  nodeToolbarActionGroups,
  nodeToolbarActionLabel,
  nodeToolbarActions,
  nodeToolbarGroupLabel,
  nodeToolbarLabel,
  resolveNodeToolbarKind,
  shouldSuppressAdvancedCompatibilityClick,
  type NodeToolbarKind,
  type NodeToolbarAction,
  type PortableNodeKind,
} from "./nodeToolbar";
import {
  CODE_TOOLBAR_ACTIONS,
  buildCodeLanguageCatalog,
  changeCodeLanguage,
  codeTargetOrdinal,
  codeToolbarActionLabel,
  copyCodeText,
  createCodeTargetToken,
  filterCodeLanguages,
  patchCodeFenceLanguage,
  resolveCodeSurfaceIntent,
  setCodeWrapView,
} from "./codeToolbar";
import { resolveListDragDrop } from "./listDragModel";
import {
  editImageNode,
  preparePortableImageMarkdown,
  serializePortableImageMarkdown,
} from "./imagePortability";
import {
  applyTableCellSelection,
  analyzeAdvancedTableDowngrade,
  createAdvancedTableDowngradeTransaction,
  createAdvancedTableUpgradeTransaction,
  editPortableTable,
  resolvePortableTableContext,
  type PortableTableAction,
  type PortableTableContext,
} from "./tablePortability";
import {
  ADVANCED_TABLE_NODE_NAME,
  type AdvancedTableBlock,
  type AdvancedTableDowngradeLoss,
  type AdvancedTableModel,
} from "./advancedTableModel";
import {
  PERSISTENT_LAYOUT_NODE_NAME,
  type PersistentLayoutModel,
} from "./layoutModel";
import {
  analyzePersistentLayoutDowngrade,
  createImageSideBySideTransaction,
  createPersistentLayoutColumnCountTransaction,
  createPersistentLayoutDowngradeTransaction,
  createPersistentLayoutOrderTransaction,
  createPersistentLayoutWidthTransaction,
  persistentLayoutPresetWidths,
  type PersistentLayoutDowngradeLoss,
} from "./layoutInteraction";
import {
  analyzeAdvancedTableMerge,
  createAdvancedTableCellBackgroundTransaction,
  createAdvancedTableCellBlockTransaction,
  createAdvancedTableMergeTransaction,
  createAdvancedTableSplitTransaction,
  readAdvancedTableCell,
  splitAdvancedTableCell,
  type AdvancedTableCellBlockOperation,
  type AdvancedTableCellCoordinate,
  type AdvancedTableSection,
} from "./advancedTableInteraction";
import {
  createHeadingNavigationTransaction,
  deriveHeadingOutline,
  sameHeadingOutline,
  type HeadingOutlineEntry,
} from "./headingOutline";
import {
  createSectionFoldTransaction,
  createUnfoldAllSectionsTransaction,
  foldedHeadingPositions,
  replaceFoldedHeadingPositions,
  sectionFoldPlugin,
  shouldCopyWholeFoldedDocument,
} from "./sectionFold";
import {
  collapsedSectionStepDestination,
  expandCollapsedSectionBlockIndices,
  foldedHeadingPositionsAfterBlockMove,
} from "./sectionOperations";
import {
  createListDragTransaction,
  inspectListDragTree,
  type ListDragTransactionInput,
  type ListDragTreeSnapshot,
} from "./listDragTransaction";
import {
  createListHierarchyTransaction,
  resolveListHierarchyAvailability,
  type ListHierarchyAvailability,
  type ListHierarchyTarget,
} from "./listHierarchy";
import {
  EDITOR_IMAGE_DROP_EVENT,
  isSupportedEditorImageFile,
  resolveEditorImageInsertion,
  type EditorImageDropDetail,
} from "../../lib/editorImageDrop";
import "@milkdown/crepe/theme/common/style.css";
import "@milkdown/crepe/theme/frame.css";
import "../../themes/crepe-paper.css";
import "../../themes/markdown-fidelity.css";

type Props = {
  value: string;
  onChange: (v: string) => void;
  /** 新建页从标题块起笔，已有 Markdown 仍完全按原文结构打开。 */
  newDocument?: boolean;
  autoFocus?: boolean;
  onReady?: () => void;
  onReadyError?: (reason: string) => void;
  /**
   * 手动源码模式（默认关）。2026-09-09 起高级语法不再自动切源码：一律可视化编辑 + 分块保真保存
   * （见 lib/markdownBlockPatch）；想看源码的人从菜单里主动切。
   */
  sourceMode?: boolean;
  /** 分块保真的改写情况：哪些原文块会按可视化结果重写、里面有什么高级语法。App 用它做保存前提示。 */
  onSourceRewrite?: (info: MarkdownRewriteInfo) => void;
};

/**
 * Narrow imperative bridge for document-wide, user-visible transactions.  It deliberately uses
 * Milkdown's non-flushing replaceAll path so ProseMirror records one ordinary undo/redo event
 * instead of recreating the editor and discarding its existing history.
 */
export type WysiwygEditorHandle = {
  replaceAllMarkdown: (markdown: string) => boolean;
};

function isBlankNewDocument(markdown: string): boolean {
  const structure = inspectNewDocument(markdown);
  return structure.titleEmpty && structure.bodyEmpty;
}

function serializeEditorMarkdown(markdown: string): string {
  return serializePortableImageMarkdown(markdown.replace(
    /^(\s*>\s*)\\(\[!(?:note|tip|important|warning|caution)\])/gim,
    "$1$2",
  ));
}

type BlockAction = "copy" | "duplicate" | "move-up" | "move-down" | "list-lift" | "list-sink" | "image-side-by-side" | "delete"
  | "text" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6"
  | "quote" | "callout" | "code" | "bullet" | "ordered" | "todo";

type BlockMenuState = {
  pos: number;
  indices: number[];
  currentType: BlockEntryType;
  left: number;
  top: number;
  target: HTMLElement;
  canMoveUp: boolean;
  canMoveDown: boolean;
  canConvert: boolean;
  canImageSideBySide: boolean;
  overlay: HTMLElement;
  belowAnchor: BelowInsertAnchor<ProseNode>;
  listHierarchy?: ListHierarchyTarget & { availability: ListHierarchyAvailability };
};

type RichLinkDialogState = {
  kind: RichLinkKind;
  pos: number;
  replaceNodeSize: number;
  belowAnchor?: BelowInsertAnchor<ProseNode>;
  url: string;
  label: string;
  error: string;
};

type LinkDisplayPickerState = {
  from: number;
  to: number;
  href: string;
  label: string;
  left: number;
  top: number;
  canBookmark: boolean;
  loading: boolean;
};

type LinkToolbarState = {
  from: number;
  to: number;
  href: string;
  label: string;
  left: number;
  top: number;
  editing: boolean;
  draft: string;
};

type NodeToolbarState = {
  kind: NodeToolbarKind;
  pos: number;
  nodeSize: number;
  revision?: number;
  target: HTMLElement;
  left: number;
  top: number;
  href?: string;
  label?: string;
  src?: string;
  caption?: string;
  ratio?: number;
  tableRow?: number;
  tableColumn?: number;
  tableContext?: PortableTableContext;
  tableAdvanced?: boolean;
  tableLosses?: AdvancedTableDowngradeLoss[];
  tableSection?: AdvancedTableSection;
  tableAnchor?: AdvancedTableCellCoordinate;
  tableSelection?: AdvancedTableCellCoordinate[];
  tableCanMerge?: boolean;
  tableCanSplit?: boolean;
  tableMergeReason?: string;
  tableCellBackground?: ControlledColorToken;
  tableCellBlocks?: AdvancedTableBlock[];
  tableBlockIndex?: number;
  layoutModel?: PersistentLayoutModel;
  layoutLosses?: PersistentLayoutDowngradeLoss[];
  language?: string;
  codeText?: string;
  wrap?: boolean;
  query?: string;
  cellRect?: { left: number; top: number; width: number; height: number };
  mode: "actions" | "source" | "description" | "language" | "table-upgrade" | "table-downgrade" | "table-background" | "table-blocks" | "table-block-edit" | "layout-linearize";
  draft: string;
};

const TABLE_DOWNGRADE_LOSS_LABELS: Record<AdvancedTableDowngradeLoss, { zh: string; en: string }> = {
  "column-widths": { zh: "列宽", en: "column widths" },
  "merged-cells": { zh: "合并单元格", en: "merged cells" },
  "cell-backgrounds": { zh: "单元格底色", en: "cell backgrounds" },
  "complex-blocks": { zh: "复杂单元格块", en: "complex cell blocks" },
  "inline-formatting": { zh: "单元格行内格式", en: "inline cell formatting" },
};

function advancedTableRectSelection(
  anchor: AdvancedTableCellCoordinate,
  focus: AdvancedTableCellCoordinate,
): AdvancedTableCellCoordinate[] {
  if (anchor.section !== focus.section) return [focus];
  const top = Math.min(anchor.row, focus.row);
  const bottom = Math.max(anchor.row, focus.row);
  const left = Math.min(anchor.column, focus.column);
  const right = Math.max(anchor.column, focus.column);
  const selection: AdvancedTableCellCoordinate[] = [];
  for (let row = top; row <= bottom; row++) {
    for (let column = left; column <= right; column++) selection.push({ section: anchor.section, row, column });
  }
  return selection;
}

function applyAdvancedTableCellSelection(
  table: HTMLElement,
  selection: readonly AdvancedTableCellCoordinate[],
  selected: boolean,
): void {
  const keys = new Set(selection.map(({ section, row, column }) => `${section}:${row}:${column}`));
  table.querySelectorAll<HTMLElement>("[data-omia-table-section]").forEach((cell) => {
    const section = cell.dataset.omiaTableSection;
    const row = Number(cell.dataset.omiaTableRow);
    const column = Number(cell.dataset.omiaTableColumn);
    const rowspan = Number(cell.dataset.omiaTableRowspan ?? "1");
    const colspan = Number(cell.dataset.omiaTableColspan ?? "1");
    let ownsSelection = false;
    for (let y = row; y < row + rowspan && !ownsSelection; y++) {
      for (let x = column; x < column + colspan; x++) {
        if (keys.has(`${section}:${y}:${x}`)) { ownsSelection = true; break; }
      }
    }
    const active = selected && ownsSelection;
    cell.classList.toggle("omia-table-cell-selected", active);
    if (active) cell.setAttribute("aria-selected", "true");
    else cell.removeAttribute("aria-selected");
  });
}

const ADVANCED_TABLE_MERGE_REASON_LABELS: Record<string, { zh: string; en: string }> = {
  "single-cell": { zh: "至少选择两个单元格", en: "Select at least two cells" },
  "non-rectangular": { zh: "只能合并完整矩形", en: "Only a complete rectangle can be merged" },
  "cross-section": { zh: "不能跨表头和正文合并", en: "Header and body cannot be merged together" },
  "partial-span": { zh: "选择必须包含整个已合并单元格", en: "Select the whole existing merged cell" },
  "invalid-selection": { zh: "当前选区已失效", en: "The current selection is stale" },
};

function advancedTableBlockText(block: AdvancedTableBlock): string {
  const template = document.createElement("template");
  template.innerHTML = block.html;
  return template.content.textContent ?? "";
}

function escapeAdvancedTableText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function editableAdvancedTableBlock(block: AdvancedTableBlock): boolean {
  return block.kind === "paragraph" || block.kind === "code" || block.kind.startsWith("heading-");
}

const CODE_LANGUAGE_SOURCES = codeLanguages.map((language) => ({
  name: language.name,
  alias: language.alias,
  extensions: language.extensions,
}));

type SlashInsertMenuState = {
  query: string;
  left: number;
  top: number;
  placement: "above" | "below";
  activeIndex: number;
};

type BrowseInsertMenuState = {
  pos: number;
  left: number;
  top: number;
  placement: "above" | "below";
  activeIndex: number;
  groupMaxHeight: number;
};

type TableSizePickerState = {
  source: "slash" | "browse" | "below";
  pos?: number;
  value: TableSize;
};

async function copyEditorText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const area = document.createElement("textarea");
      area.value = text;
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      const copied = document.execCommand("copy");
      area.remove();
      return copied;
    } catch {
      return false;
    }
  }
}

function BlockActionIcon({ action }: { action: BlockAction }) {
  if (action === "copy") return <svg viewBox="0 0 20 20"><rect x="6" y="6" width="10" height="10" rx="2"/><path d="M13 6V4.5A1.5 1.5 0 0 0 11.5 3h-7A1.5 1.5 0 0 0 3 4.5v7A1.5 1.5 0 0 0 4.5 13H6"/></svg>;
  if (action === "duplicate") return <svg viewBox="0 0 20 20"><rect x="5.5" y="5.5" width="10.5" height="10.5" rx="2"/><path d="M13 5.5v-1A1.5 1.5 0 0 0 11.5 3h-7A1.5 1.5 0 0 0 3 4.5v7A1.5 1.5 0 0 0 4.5 13h1M10.75 8.5v4.5M8.5 10.75H13"/></svg>;
  if (action === "move-up") return <svg viewBox="0 0 20 20"><path d="m5.5 11 4.5-4.5 4.5 4.5M10 6.5V15"/></svg>;
  if (action === "move-down") return <svg viewBox="0 0 20 20"><path d="m5.5 9 4.5 4.5L14.5 9M10 13.5V5"/></svg>;
  if (action === "list-lift") return <svg viewBox="0 0 20 20"><path d="M8 6h8M8 10h8M8 14h8M5.5 7.5 3 10l2.5 2.5M3 10h4"/></svg>;
  if (action === "list-sink") return <svg viewBox="0 0 20 20"><path d="M8 6h8M8 10h8M8 14h8M4.5 7.5 7 10l-2.5 2.5M7 10H3"/></svg>;
  if (action === "image-side-by-side") return <svg viewBox="0 0 20 20"><rect x="2.5" y="4" width="6.5" height="12" rx="1.5"/><rect x="11" y="4" width="6.5" height="12" rx="1.5"/><path d="m4 13 1.6-2 1.8 2.4M12.5 13l1.5-2 2 2.5"/></svg>;
  if (action === "delete") return <svg viewBox="0 0 20 20"><path d="M4 6h12M7 6V4h6v2M6 6l.7 10h6.6L14 6M8.3 9v4M11.7 9v4"/></svg>;
  if (action === "quote") return <svg viewBox="0 0 20 20"><path d="M4 6h4v4H5.5v3H3V9.5C3 7.8 3.4 6.7 4 6ZM12 6h4v4h-2.5v3H11V9.5c0-1.7.4-2.8 1-3.5Z"/></svg>;
  if (action === "bullet" || action === "ordered" || action === "todo") return <svg viewBox="0 0 20 20"><path d="M7.5 6h8M7.5 10h8M7.5 14h8"/><circle cx="4" cy="6" r=".8"/><circle cx="4" cy="10" r=".8"/><circle cx="4" cy="14" r=".8"/></svg>;
  if (/^h[1-6]$/.test(action)) return <svg viewBox="0 0 20 20"><path d="M3 5v10M10 5v10M3 10h7"/><text x="12.1" y="14.2" fill="currentColor" stroke="none" fontSize="8.2" fontWeight="700">{action.slice(1)}</text></svg>;
  if (action === "code") return <svg viewBox="0 0 20 20"><path d="m7 6-4 4 4 4M13 6l4 4-4 4M11.5 4 8.5 16"/></svg>;
  if (action === "callout") return <svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="7"/><path d="M10 8.5v5M10 6.2v.2"/></svg>;
  return <svg viewBox="0 0 20 20"><path d="M4 5h12M10 5v11M7 16h6"/></svg>;
}

function InsertCommandMark({ command }: { command: InsertCommand }) {
  return <span className="editor-insert-command__mark" aria-hidden="true">{command.glyph}</span>;
}

// 斜杠/拖拽菜单文案：跟随 app 语言（zh/en）。语言切换时父级 key 含 lang → 整个编辑器重挂，
// 用新文案重建（内容存在 App 的 draft 里，重挂不丢）。
function menuLabels(lang: "zh" | "en") {
  const command = slashCommandLabel;
  return lang === "en"
    ? { tg: "Text", text: command("Text", "正文", "Paragraph", "P"), h1: command("Heading 1", "一级标题", "H1"), h2: command("Heading 2", "二级标题", "H2"), h3: command("Heading 3", "三级标题", "H3"), h4: command("Heading 4", "四级标题", "H4"), h5: command("Heading 5", "五级标题", "H5"), h6: command("Heading 6", "六级标题", "H6"), quote: command("Quote", "引用"), divider: command("Divider", "分割线", "HR"), lg: "List", bullet: command("Bullet List", "无序列表", "Bullets"), ordered: command("Ordered List", "有序列表", "Numbered"), task: command("To-do List", "待办清单", "Todo", "Task"), ag: "Advanced", image: command("Image", "图片", "IMG"), code: command("Code Block", "代码块", "Code"), table: command("Table", "表格"), math: command("Equation", "数学公式", "Math"), callout: "Callout", bookmark: command("Web bookmark", "网页书签", "Bookmark", "Link card"), audio: command("Audio", "音频", "Music"), video: command("Video", "视频", "Movie"), file: command("File", "文件", "Attachment"),
        // Crepe 内置组件文案
        ph: "Type something, or press / for blocks", imgUpload: "Upload", imgUploadFile: "Upload file", imgConfirm: "Confirm", imgCaption: "Add a caption", imgPaste: "or paste a link", linkPaste: "Paste link", cbSearch: "Search language", cbNoResult: "No result", cbCopy: "Copy", cbPreview: "Preview", cbLoading: "Loading…" }
    : { tg: "文本", text: command("正文", "Text", "Paragraph", "P"), h1: command("一级标题", "Heading 1", "H1"), h2: command("二级标题", "Heading 2", "H2"), h3: command("三级标题", "Heading 3", "H3"), h4: command("四级标题", "Heading 4", "H4"), h5: command("五级标题", "Heading 5", "H5"), h6: command("六级标题", "Heading 6", "H6"), quote: command("引用", "Quote"), divider: command("分割线", "Divider", "HR"), lg: "列表", bullet: command("无序列表", "Bullet List", "Bullets"), ordered: command("有序列表", "Ordered List", "Numbered"), task: command("待办清单", "To-do List", "Todo", "Task"), ag: "高级", image: command("图片", "Image", "IMG"), code: command("代码块", "Code Block", "Code"), table: command("表格", "Table"), math: command("数学公式", "Equation", "Math"), callout: "提示框", bookmark: command("网页书签", "Web bookmark", "Bookmark", "链接卡片"), audio: command("音频", "Audio", "Music"), video: command("视频", "Video", "Movie"), file: command("文件", "File", "Attachment", "附件"),
        // Crepe 内置组件文案
        ph: "输入内容，或按 / 插入区块", imgUpload: "上传", imgUploadFile: "上传图片", imgConfirm: "确定", imgCaption: "添加图片说明", imgPaste: "或粘贴图片链接", linkPaste: "粘贴链接", cbSearch: "搜索语言", cbNoResult: "无结果", cbCopy: "复制", cbPreview: "预览", cbLoading: "加载中…" };
}

// 所见即所得 Markdown 编辑器（Milkdown Crepe）：直接在排版好的视图上改字，输出仍是干净 markdown。
// 非受控：仅用初始 value 创建；外部切换文档/语言时由父级用 key 重新挂载。
export const WysiwygEditor = forwardRef<WysiwygEditorHandle, Props>(function WysiwygEditor(
  { value, onChange, newDocument = false, autoFocus = false, onReady, onReadyError, sourceMode = false, onSourceRewrite },
  handleRef,
) {
  const ref = useRef<HTMLDivElement>(null);
  const crepeRef = useRef<Crepe | null>(null);
  const onChangeRef = useRef(onChange);
  const onSourceRewriteRef = useRef(onSourceRewrite);
  onSourceRewriteRef.current = onSourceRewrite;
  const onReadyRef = useRef(onReady);
  const onReadyErrorRef = useRef(onReadyError);
  const blockMenuRef = useRef<HTMLDivElement>(null);
  const clearBlockSelectionRef = useRef<() => void>(() => {});
  const noticeTimerRef = useRef<number | undefined>(undefined);
  const documentRevisionRef = useRef(0);
  const serializedDocumentRef = useRef<string | null>(null);
  const exactMarkdownRef = useRef(value);
  const pendingExactMarkdownRef = useRef<string | null>(null);
  const [notice, setNotice] = useState<{ kind: "loading" | "success" | "error"; text: string } | null>(null);
  const [blockMenu, setBlockMenu] = useState<BlockMenuState | null>(null);
  const [blockMenuQuery, setBlockMenuQuery] = useState("");
  const [richLinkDialog, setRichLinkDialog] = useState<RichLinkDialogState | null>(null);
  const [linkDisplayPicker, setLinkDisplayPicker] = useState<LinkDisplayPickerState | null>(null);
  const [linkToolbar, setLinkToolbar] = useState<LinkToolbarState | null>(null);
  const [nodeToolbar, setNodeToolbar] = useState<NodeToolbarState | null>(null);
  const [slashInsertMenu, setSlashInsertMenu] = useState<SlashInsertMenuState | null>(null);
  const [browseInsertMenu, setBrowseInsertMenu] = useState<BrowseInsertMenuState | null>(null);
  const [tableSizePicker, setTableSizePicker] = useState<TableSizePickerState | null>(null);
  const [headingOutline, setHeadingOutline] = useState<readonly HeadingOutlineEntry[]>([]);
  const [headingOutlineOpen, setHeadingOutlineOpen] = useState(false);
  const [foldedSections, setFoldedSections] = useState<readonly number[]>([]);
  const slashInsertMenuStateRef = useRef<SlashInsertMenuState | null>(null);
  const browseInsertMenuStateRef = useRef<BrowseInsertMenuState | null>(null);
  const tableSizePickerStateRef = useRef<TableSizePickerState | null>(null);
  const slashInsertMenuRef = useRef<HTMLDivElement>(null);
  const browseInsertMenuRef = useRef<HTMLDivElement>(null);
  const imeComposingRef = useRef(false);
  const lastImeCompositionEndAtRef = useRef(Number.NEGATIVE_INFINITY);
  const executeInsertCommandRef = useRef<(
    id: InsertCommandId,
    source: "slash" | "browse" | "below",
    pos?: number,
    tableSize?: TableSize,
  ) => boolean>(() => false);
  const richLinkUrlRef = useRef<HTMLInputElement>(null);
  const linkDisplayPickerRef = useRef<HTMLDivElement>(null);
  const linkToolbarRef = useRef<HTMLDivElement>(null);
  const nodeToolbarRef = useRef<HTMLDivElement>(null);
  const linkTitleAbortRef = useRef<AbortController | null>(null);
  const safetyRef = useRef<ReturnType<typeof analyzeMarkdownEditSafety> | null>(null);
  if (safetyRef.current === null) safetyRef.current = analyzeMarkdownEditSafety(value);
  const editSafety = safetyRef.current;
  onChangeRef.current = onChange;
  onReadyRef.current = onReady;
  onReadyErrorRef.current = onReadyError;
  const lang = useLang();

  useImperativeHandle(handleRef, () => ({
    replaceAllMarkdown: (markdown) => {
      const crepe = crepeRef.current;
      if (!crepe) return false;
      let applied = false;
      try {
        crepe.editor.action((ctx) => {
          replaceAll(preparePortableImageMarkdown(markdown))(ctx);
          // Timeline actions close their dialog immediately. Restore focus to the live editor so
          // the first Cmd/Ctrl+Z (and its redo) applies to this one replacement transaction.
          ctx.get(editorViewCtx).focus();
          applied = true;
        });
      } catch {
        applied = false;
      }
      return applied;
    },
  }), []);

  const updateSlashInsertMenu = (
    update: SlashInsertMenuState | null | ((current: SlashInsertMenuState | null) => SlashInsertMenuState | null),
  ) => {
    const next = typeof update === "function" ? update(slashInsertMenuStateRef.current) : update;
    slashInsertMenuStateRef.current = next;
    setSlashInsertMenu(next);
  };
  const updateBrowseInsertMenu = (
    update: BrowseInsertMenuState | null | ((current: BrowseInsertMenuState | null) => BrowseInsertMenuState | null),
  ) => {
    const next = typeof update === "function" ? update(browseInsertMenuStateRef.current) : update;
    browseInsertMenuStateRef.current = next;
    setBrowseInsertMenu(next);
  };
  const updateTableSizePicker = (next: TableSizePickerState | null) => {
    tableSizePickerStateRef.current = next;
    setTableSizePicker(next);
  };

  const showNotice = (kind: "loading" | "success" | "error", text: string, duration = 1600) => {
    if (noticeTimerRef.current != null) window.clearTimeout(noticeTimerRef.current);
    setNotice({ kind, text });
    if (duration > 0) noticeTimerRef.current = window.setTimeout(() => setNotice(null), duration);
  };

  const closeNodeToolbar = (restoreFocus = false) => {
    setNodeToolbar((current) => {
      if (current) {
        applyPortableNodeSelection(current.target, false, "");
        if (current.kind === "table" && current.tableRow != null && current.tableColumn != null) {
          if (current.tableAdvanced) applyAdvancedTableCellSelection(current.target, current.tableSelection ?? [], false);
          else applyTableCellSelection(current.target, current.tableRow, current.tableColumn, false, "");
        }
      }
      return null;
    });
    if (restoreFocus) restoreEditorFocus();
  };

  const closeBlockMenu = () => {
    if (tableSizePickerStateRef.current?.source === "below") updateTableSizePicker(null);
    setBlockMenuQuery("");
    setBlockMenu((current) => {
      if (current) {
        const status = ref.current?.parentElement?.querySelector<HTMLElement>("#omia-block-state-status");
        clearBlockVisualState(current.target, "menu-target", status ?? "omia-block-state-status");
        current.overlay.remove();
      }
      return null;
    });
  };
  const restoreEditorFocus = () => {
    const focus = () => {
      ref.current?.querySelector<HTMLElement>(".ProseMirror")?.focus({ preventScroll: true });
      crepeRef.current?.editor.action((ctx) => ctx.get(editorViewCtx).focus());
    };
    // React 移除菜单按钮与浏览器恢复旧焦点不是同一拍；末尾再确认一次，避免焦点回到六点手柄。
    window.setTimeout(focus, 0);
    window.setTimeout(focus, 80);
  };
  const restoreBlockFocus = (pos: number) => {
    const focus = () => {
      crepeRef.current?.editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const safePos = Math.max(0, Math.min(pos + 1, view.state.doc.content.size));
        view.dispatch(view.state.tr.setSelection(Selection.near(view.state.doc.resolve(safePos))).scrollIntoView());
        view.focus();
      });
    };
    window.setTimeout(focus, 0);
    window.setTimeout(focus, 80);
  };

  useEffect(() => {
    if (!blockMenu) return;
    // 指针松开后 ProseMirror 还会在下一帧恢复正文焦点；菜单晚一帧落焦，
    // 否则视觉上菜单已开，Delete/方向键却仍作用在正文光标上。
    let focusFrame = 0;
    const frame = requestAnimationFrame(() => {
      focusFrame = requestAnimationFrame(() => {
        const menu = blockMenuRef.current;
        const target = menu?.querySelector<HTMLInputElement>('input[type="search"]')
          ?? menu?.querySelector<HTMLButtonElement>("button:not(:disabled)");
        target?.focus({ preventScroll: true });
      });
    });
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        const originalPos = blockMenu.pos;
        closeBlockMenu();
        clearBlockSelectionRef.current();
        restoreBlockFocus(originalPos);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      cancelAnimationFrame(frame);
      if (focusFrame) cancelAnimationFrame(focusFrame);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [blockMenu]);

  useEffect(() => {
    if (!autoFocus || !crepeRef.current) return;
    const frame = requestAnimationFrame(() => {
      crepeRef.current?.editor.action((ctx) => ctx.get(editorViewCtx).focus());
    });
    return () => cancelAnimationFrame(frame);
  }, [autoFocus]);

  useEffect(() => {
    if (!richLinkDialog) return;
    const frame = requestAnimationFrame(() => richLinkUrlRef.current?.focus({ preventScroll: true }));
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setRichLinkDialog(null);
      restoreEditorFocus();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [richLinkDialog?.kind]);

  useEffect(() => {
    if (!linkDisplayPicker) return;
    const frame = requestAnimationFrame(() => {
      linkDisplayPickerRef.current?.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
    });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      linkTitleAbortRef.current?.abort();
      setLinkDisplayPicker(null);
      restoreEditorFocus();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [linkDisplayPicker?.from, linkDisplayPicker?.href]);

  useEffect(() => {
    if (!nodeToolbar) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closeNodeToolbar(true);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [nodeToolbar?.pos, nodeToolbar?.kind]);

  useEffect(() => {
    const active = slashInsertMenuRef.current?.querySelector<HTMLElement>('[role="option"][aria-selected="true"]');
    active?.scrollIntoView({ block: "nearest" });
  }, [slashInsertMenu?.activeIndex, slashInsertMenu?.query]);

  useEffect(() => {
    const active = browseInsertMenuRef.current?.querySelector<HTMLElement>('[role="menuitem"][aria-current="true"]');
    active?.scrollIntoView({ block: "nearest" });
    if (browseInsertMenu) active?.focus({ preventScroll: true });
  }, [browseInsertMenu?.activeIndex]);

  useEffect(() => {
    if (sourceMode) return;
    const M = menuLabels(lang);
    const en = lang === "en";
    if (!ref.current) return;
    const host = ref.current;
    // Front Matter 编辑器不碰：只把正文喂给 Crepe；guard 拿的是全文，保存时由分块保真把 Front Matter 原样接回。
    const editorBody = extractFrontMatter(value).body;
    const initialValue = preparePortableImageMarkdown(initialEditorValue(editorBody, newDocument));
    const initialChangeGuard = createInitialMarkdownChangeGuard(value);
    const initialStructure = inspectNewDocument(initialValue);
    documentRevisionRef.current = 0;
    serializedDocumentRef.current = null;
    exactMarkdownRef.current = value;
    pendingExactMarkdownRef.current = null;
    host.classList.toggle("is-new-document", newDocument);
    host.classList.toggle("is-pristine", newDocument && isBlankNewDocument(value));
    host.classList.toggle("is-title-empty", newDocument && initialStructure.titleEmpty);
    host.classList.toggle("is-body-empty", newDocument && initialStructure.bodyEmpty);
    const editorSurfaceRoot = host.closest(".editor-canvas") ?? host;
    const blockStateStatus = editorSurfaceRoot.querySelector<HTMLElement>("#omia-block-state-status");

    // Crepe 继续负责工具条的定位与格式事务；这里只把显隐收敛到稳定选区事件：
    // 指针拖选时始终隐藏，松开或键盘扩选后的下一帧出现，不再固定等待 420ms。
    let imeComposing = false;
    const currentTextSelectionRangeInside = () => {
      if (imeComposing) return null;
      const selection = host.ownerDocument.getSelection();
      if (!selection || selection.isCollapsed || selection.rangeCount === 0 || !selection.toString().trim()) return null;
      const range = selection.getRangeAt(0);
      if (!host.contains(range.commonAncestorContainer)) return null;
      return range;
    };
    const hasTextSelectionInside = () => {
      const range = currentTextSelectionRangeInside();
      if (!range) return false;
      const selectionElement = range.commonAncestorContainer instanceof Element
        ? range.commonAncestorContainer
        : range.commonAncestorContainer.parentElement;
      const insideCode = Boolean(selectionElement?.closest(".milkdown-code-block"));
      if (resolveCodeSurfaceIntent({ insideCode, hasTextSelection: true }) === "selection-toolbar") return true;
      const blockingSurface = findBlockingEditorSurface(editorSurfaceRoot, range.commonAncestorContainer);
      // A stale or hover-triggered link surface must never take ownership from a
      // real range selection.  It is closed by `onSelectionChange`; allowing the
      // selection toolbar here also avoids a React-render timing gap.
      return canTextSelectionOwnSurface(blockingSurface);
    };
    let selectionToolbarShell: SelectionToolbarShell | null = null;
    let selectionToolbarStoredSelection: { from: number; to: number } | null = null;
    let selectionToolbarEditorView: EditorView | null = null;
    let selectionToolbarFallbackTimer: number | undefined;
    const clearSelectionToolbarFallback = (toolbar?: HTMLElement | null) => {
      if (selectionToolbarFallbackTimer != null) window.clearTimeout(selectionToolbarFallbackTimer);
      selectionToolbarFallbackTimer = undefined;
      const current = toolbar ?? host.querySelector<HTMLElement>(".milkdown-toolbar");
      if (current?.dataset.omiaFallbackPosition === "true") {
        current.dataset.show = "false";
        delete current.dataset.omiaFallbackPosition;
        current.style.removeProperty("left");
        current.style.removeProperty("top");
      }
    };
    const reconcileDirectionalDomSelection = () => {
      const view = selectionToolbarEditorView;
      const selection = host.ownerDocument.getSelection();
      if (!view || !selection || selection.isCollapsed || !selection.anchorNode || !selection.focusNode
        || !view.dom.contains(selection.anchorNode) || !view.dom.contains(selection.focusNode)) {
        return false;
      }
      try {
        const anchor = view.posAtDOM(selection.anchorNode, selection.anchorOffset, 1);
        const head = view.posAtDOM(selection.focusNode, selection.focusOffset, -1);
        const transaction = createDirectionalTextSelectionTransaction(view.state, anchor, head);
        if (!transaction) return false;
        view.dispatch(transaction);
        return true;
      } catch {
        return false;
      }
    };
    const armSelectionToolbarFallback = () => {
      if (selectionToolbarFallbackTimer != null) window.clearTimeout(selectionToolbarFallbackTimer);
      selectionToolbarFallbackTimer = window.setTimeout(() => {
        selectionToolbarFallbackTimer = undefined;
        const current = host.querySelector<HTMLElement>(".milkdown-toolbar");
        const view = selectionToolbarEditorView;
        const range = currentTextSelectionRangeInside();
        if (!current || !view || !range) return;
        if (!shouldApplySelectionToolbarFallback({
          dataShow: current.dataset.show === "true",
          hostReady: host.classList.contains("selection-toolbar-ready"),
          selectionHidden: current.hasAttribute("data-omia-selection-hidden"),
          ariaHidden: current.getAttribute("aria-hidden") === "true",
          inert: current.inert,
        })) return;
        reconcileDirectionalDomSelection();
        if (view.state.selection.empty) return;
        const head = view.coordsAtPos(view.state.selection.head);
        current.inert = false;
        current.setAttribute("aria-hidden", "false");
        current.removeAttribute("data-omia-selection-hidden");
        current.dataset.show = "true";
        current.dataset.omiaFallbackPosition = "true";
        host.classList.add("selection-toolbar-ready");
        const parent = current.offsetParent instanceof HTMLElement ? current.offsetParent : host;
        const parentRect = parent.getBoundingClientRect();
        const toolbarRect = current.getBoundingClientRect();
        const position = selectionToolbarFallbackPosition({
          anchor: { left: head.left, top: head.top, bottom: head.bottom },
          parent: { left: parentRect.left, top: parentRect.top },
          toolbar: { width: toolbarRect.width, height: toolbarRect.height },
          viewport: { width: window.innerWidth, height: window.innerHeight },
        });
        current.style.left = `${position.left}px`;
        current.style.top = `${position.top}px`;
        selectionToolbarShell?.refresh();
      }, 80);
    };
    const selectionToolbar = createSelectionToolbarController({
      isEligible: hasTextSelectionInside,
      setReady: (ready) => {
        const toolbar = host.querySelector<HTMLElement>(".milkdown-toolbar");
        clearSelectionToolbarFallback(toolbar);
        if (toolbar) {
          toolbar.inert = !ready;
          toolbar.setAttribute("aria-hidden", String(!ready));
          toolbar.toggleAttribute("data-omia-selection-hidden", !ready);
        }
        if (ready) {
          selectionToolbarShell?.refresh();
          // Crepe's floating provider occasionally leaves data-show=false for
          // a native reverse drag ending in the page title. After its own
          // debounce has had first refusal, expose the same actionable toolbar
          // at the preserved directional head; normal selections never enter
          // this branch.
          armSelectionToolbarFallback();
        } else selectionToolbarShell?.closeMenus();
        host.classList.toggle("selection-toolbar-ready", ready);
      },
    });
    const hideSelectionToolbar = () => selectionToolbar.dismiss();
    const scheduleSelectionToolbar = () => selectionToolbar.selectionChanged();
    const syncTextSelectionSurface = () => {
      host.classList.toggle("selection-toolbar-has-text", hasTextSelectionInside());
    };
    let selectionPointerOrigin: { x: number; y: number } | null = null;
    let nativePointerSequenceObserved = false;
    const onSelectionChange = () => {
      const toolbar = host.querySelector<HTMLElement>(".milkdown-toolbar");
      if (toolbar?.contains(host.ownerDocument.activeElement)) return;
      const textSelectionOwnsSurface = hasTextSelectionInside();
      host.classList.toggle("selection-toolbar-has-text", textSelectionOwnsSurface);
      if (textSelectionOwnsSurface) {
        setLinkToolbar(null);
        closeNodeToolbar();
      }
      selectionToolbar.selectionChanged();
    };
    const completeSelectionPointer = () => {
      selectionPointerOrigin = null;
      nativePointerSequenceObserved = false;
      syncTextSelectionSurface();
      host.classList.remove("selection-toolbar-pointer-selecting");
      selectionToolbar.pointerUp();
      requestAnimationFrame(() => {
        if (destroyed || !currentTextSelectionRangeInside()) return;
        reconcileDirectionalDomSelection();
        selectionToolbar.keyboardSelection();
        requestAnimationFrame(() => { if (!destroyed) armSelectionToolbarFallback(); });
      });
    };
    const finishSelectionPointer = (event: MouseEvent | PointerEvent) => {
      const origin = selectionPointerOrigin;
      const targetIsToolbar = event.target instanceof Element
        && Boolean(event.target.closest(".milkdown-toolbar"));
      if (!shouldFinishSelectionPointer({ targetIsToolbar, hasEditorOrigin: Boolean(origin) })) return;
      if (!origin || Math.hypot(event.clientX - origin.x, event.clientY - origin.y) < 3) {
        selectionPointerOrigin = null;
        syncTextSelectionSurface();
        host.classList.remove("selection-toolbar-pointer-selecting");
        hideSelectionToolbar();
        return;
      }
      // The browser owns drag direction. Reconcile after pointer-up so a
      // reverse body→title drag is not left as a copyable DOM-only range with
      // no actionable formatting toolbar in native WebViews.
      completeSelectionPointer();
    };
    const onPointerUp = (event: PointerEvent) => finishSelectionPointer(event);
    const onMouseDownFallback = (event: MouseEvent) => {
      if (nativePointerSequenceObserved || (event.target as Element | null)?.closest?.(".milkdown-toolbar")) return;
      selectionPointerOrigin = { x: event.clientX, y: event.clientY };
      host.classList.add("selection-toolbar-pointer-selecting");
      selectionToolbar.pointerDown();
    };
    const onMouseUpFallback = (event: MouseEvent) => {
      if (nativePointerSequenceObserved) {
        nativePointerSequenceObserved = false;
        // WebView2 can emit pointerdown but omit the matching pointerup while
        // still delivering mouseup for a reverse drag ending in the title.
        // If pointerup already finished, the origin is null; otherwise mouseup
        // must close the same gesture instead of leaving the toolbar gated.
        if (selectionPointerOrigin) finishSelectionPointer(event);
        return;
      }
      finishSelectionPointer(event);
    };
    const onPointerCancel = () => {
      nativePointerSequenceObserved = false;
      selectionPointerOrigin = null;
      host.classList.remove("selection-toolbar-pointer-selecting");
      syncTextSelectionSurface();
      hideSelectionToolbar();
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.shiftKey || event.key.startsWith("Arrow")) selectionToolbar.keyboardSelection();
    };
    const onSelectionEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if ((event.target as Element | null)?.closest?.(".milkdown-toolbar [role='menu']")) return;
      hideSelectionToolbar();
    };
    host.ownerDocument.addEventListener("selectionchange", onSelectionChange);
    host.ownerDocument.addEventListener("pointerup", onPointerUp, true);
    host.ownerDocument.addEventListener("pointercancel", onPointerCancel, true);
    host.addEventListener("mousedown", onMouseDownFallback, true);
    host.ownerDocument.addEventListener("mouseup", onMouseUpFallback, true);
    host.addEventListener("keyup", onKeyUp);
    host.ownerDocument.addEventListener("keydown", onSelectionEscape, true);

    // 点击「块级容器的留白」(引用块灰底空白/列表项空白/表格单元格空白)时主动聚焦+落光标。
    // Chromium 会自动把光标吸附到最近文字,但 WKWebView(Safari 内核)点 padding 留白不放光标→
    // 用户以为「不能编辑」。只在 target 是块容器(非内层 <p>/文字)时介入,正常点文字完全不干预。
    const CONTAINERS = /^(BLOCKQUOTE|LI|UL|OL|TD|TH)$/;
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t) return;
      // 工具条自己的按钮必须保留当前文字选区，交给 Crepe 原格式事务处理。
      if (t.closest(".milkdown-toolbar")) return;
      nativePointerSequenceObserved = true;
      selectionPointerOrigin = { x: e.clientX, y: e.clientY };
      host.classList.add("selection-toolbar-pointer-selecting");
      selectionToolbar.pointerDown();
      if (!t.closest(".milkdown-block-handle") && (selectedBlocks.size > 0 || selectedListItems.size > 0)) clearSelectedBlocks();
      if (t.closest(".cm-editor")) return; // 代码块归 CodeMirror 管
      const isContainerPadding = CONTAINERS.test(t.tagName) || t.classList.contains("ProseMirror");
      if (!isContainerPadding) return; // 点在文字(<p> 等)上 → 让 ProseMirror 自己处理
      const docu = t.ownerDocument;
      const range = docu.caretRangeFromPoint?.(e.clientX, e.clientY);
      if (!range) return;
      const pm = host.querySelector<HTMLElement>(".ProseMirror");
      pm?.focus();
      const sel = docu.getSelection();
      if (sel) { sel.removeAllRanges(); sel.addRange(range); }
    };
    host.addEventListener("pointerdown", onPointerDown, true); // 捕获阶段,先于 PM 自己的处理
    const closeSelectionToolbarOutside = (event: PointerEvent) => {
      if (!host.contains(event.target as Node)) hideSelectionToolbar();
    };
    host.ownerDocument.addEventListener("pointerdown", closeSelectionToolbarOutside, true);

    // Omia 自己呈现确定性 Slash 结果；Crepe 仍保留块手柄 provider，但其包含式菜单在
    // Slash 意图期间被抑制，避免两个浮层与两套键盘索引同时运行。
    let slashMenuSyncFrame: number | undefined;
    let lastImeCompositionEndAt = Number.NEGATIVE_INFINITY;
    const isCurrentImeEnter = (event: KeyboardEvent) => event.key === "Enter" && isImeEnter({
      isComposing: event.isComposing,
      composing: imeComposing,
      sinceEndMs: performance.now() - lastImeCompositionEndAt,
    });
    const setNativeSlashSuppressed = (suppressed: boolean) => {
      const nativeMenu = host.querySelector<HTMLElement>(".milkdown-slash-menu");
      if (nativeMenu) nativeMenu.toggleAttribute("data-omia-suppressed", suppressed);
    };
    const closeSlashInsertMenu = (reason: SlashMenuCloseReason = "dismiss") => {
      if (tableSizePickerStateRef.current?.source === "slash") updateTableSizePicker(null);
      updateSlashInsertMenu(null);
      host.classList.remove("has-slash-insert-menu");
      if (shouldReleaseNativeSlashMenu(reason)) setNativeSlashSuppressed(false);
      const editor = host.querySelector<HTMLElement>(".ProseMirror");
      editor?.setAttribute("aria-expanded", "false");
      editor?.removeAttribute("aria-activedescendant");
    };
    const readSlashIntent = () => {
      try {
        return crepe.editor.action((ctx) => {
          const view = ctx.get(editorViewCtx);
          const selection = view.state.selection;
          if (!(selection instanceof TextSelection) || !selection.empty) return null;
          const $from = selection.$from;
          if (newDocument && $from.depth > 0 && $from.before(1) === 0) return null;
          const ancestorNames = Array.from({ length: $from.depth + 1 }, (_unused, depth) => $from.node(depth).type.name);
          const invocation = parseSlashInvocation($from.parent.textContent, {
            selectionAtEnd: $from.parentOffset === $from.parent.content.size,
            inCode: ancestorNames.some((name) => name.includes("code")),
            inList: ancestorNames.some((name) => name.includes("list")),
            composing: imeComposing,
          });
          if (!invocation) return null;
          const coords = view.coordsAtPos(selection.from);
          const hostRect = host.getBoundingClientRect();
          const width = Math.min(344, Math.max(232, hostRect.width - 16));
          const layout = resolveSlashMenuLayout({
            viewportTop: Math.max(8, hostRect.top + 8),
            viewportBottom: Math.min(window.innerHeight - 8, hostRect.bottom - 8),
            anchorTop: coords.top,
            anchorBottom: coords.bottom,
            preferredMenuHeight: 430,
            fixedChromeHeight: 78,
            maxGroupHeight: 352,
          });
          return {
            query: invocation.query,
            left: Math.round(Math.max(hostRect.left + 8, Math.min(hostRect.right - width - 8, coords.left))),
            top: Math.round(layout.top),
            placement: layout.placement,
          };
        });
      } catch {
        return null;
      }
    };
    const syncSlashInsertMenu = () => {
      slashMenuSyncFrame = undefined;
      const next = readSlashIntent();
      const blockingSurface = findBlockingEditorSurface(editorSurfaceRoot);
      if (!next || !canOwnSlashInsertMenu(blockingSurface)) {
        closeSlashInsertMenu();
        return;
      }
      host.classList.add("has-slash-insert-menu");
      hideSelectionToolbar();
      selectionToolbarShell?.closeMenus();
      closeBlockMenu();
      closeNodeToolbar();
      setRichLinkDialog(null);
      setLinkDisplayPicker(null);
      setLinkToolbar(null);
      updateBrowseInsertMenu(null);
      setNativeSlashSuppressed(true);
      const results = searchInsertCommands(next.query, lang);
      updateSlashInsertMenu((current) => ({
        ...next,
        activeIndex: current?.query === next.query
          ? Math.min(current.activeIndex, Math.max(0, results.length - 1))
          : 0,
      }));
      const editor = host.querySelector<HTMLElement>(".ProseMirror");
      editor?.setAttribute("aria-haspopup", "listbox");
      editor?.setAttribute("aria-controls", "omia-slash-command-menu");
      editor?.setAttribute("aria-expanded", "true");
      if (results.length > 0) editor?.setAttribute("aria-activedescendant", `omia-slash-command-${results[Math.min(slashInsertMenuStateRef.current?.activeIndex ?? 0, results.length - 1)]?.id}`);
      else editor?.removeAttribute("aria-activedescendant");
    };
    const scheduleSlashInsertMenuSync = () => {
      if (slashMenuSyncFrame != null) return;
      slashMenuSyncFrame = requestAnimationFrame(syncSlashInsertMenu);
    };
    const onSlashMenuKeyDown = (event: KeyboardEvent) => {
      const tablePicker = tableSizePickerStateRef.current;
      if (tablePicker?.source === "slash") {
        const pickerAction = resolveSlashTableSizePickerCaptureAction(tablePicker.source, event.key);
        if (pickerAction === "move") {
          event.preventDefault();
          event.stopImmediatePropagation();
          updateTableSizePicker({
            ...tablePicker,
            value: moveTableSize(tablePicker.value, event.key as TableSizeNavigationKey),
          });
          return;
        }
        if (pickerAction === "select") {
          event.preventDefault();
          event.stopImmediatePropagation();
          executeInsertCommandRef.current("table", "slash", tablePicker.pos, tablePicker.value);
          return;
        }
        if (pickerAction === "cancel") {
          event.preventDefault();
          event.stopImmediatePropagation();
          updateTableSizePicker(null);
          window.setTimeout(() => {
            slashInsertMenuRef.current?.querySelector<HTMLElement>('[data-insert-command="table"]')?.focus({ preventScroll: true });
          }, 0);
          return;
        }
        return;
      }
      const menu = slashInsertMenuStateRef.current;
      if (!menu) return;
      if (!shouldSlashMenuOwnKeyEvent(
        tableSizePickerStateRef.current?.source ?? null,
        Boolean((event.target as Element | null)?.closest(".editor-table-size-picker")),
      )) return;
      const results = searchInsertCommands(menu.query, lang);
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        closeSlashInsertMenu();
        return;
      }
      if (event.key === "ArrowUp" || event.key === "ArrowDown" || event.key === "Home" || event.key === "End") {
        event.preventDefault();
        event.stopImmediatePropagation();
        updateSlashInsertMenu({
          ...menu,
          activeIndex: moveInsertMenuActiveIndex(menu.activeIndex, event.key, results.length),
        });
        return;
      }
      const imeEnter = isCurrentImeEnter(event);
      if (!shouldExecuteInsertMenuCommand({ key: event.key, resultCount: results.length, imeEnter })) {
        if (event.key === "Enter" && imeEnter) {
          event.preventDefault();
          event.stopImmediatePropagation();
        }
        return;
      }
      const selected = results[Math.min(menu.activeIndex, results.length - 1)];
      if (!selected) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      executeInsertCommandRef.current(selected.id, "slash");
    };
    const beginImeComposition = () => {
      imeComposing = true;
      imeComposingRef.current = true;
      selectionToolbarStoredSelection = null;
      hideSelectionToolbar();
      closeSlashInsertMenu("composition");
    };
    const onSlashMenuCompositionStart = () => beginImeComposition();
    const onEditorBeforeInput = (event: InputEvent) => {
      if (event.isComposing || event.inputType === "insertCompositionText") beginImeComposition();
    };
    const onEditorCompositionEnd = () => {
      imeComposing = false;
      lastImeCompositionEndAt = performance.now();
      imeComposingRef.current = false;
      lastImeCompositionEndAtRef.current = lastImeCompositionEndAt;
      scheduleSlashInsertMenuSync();
    };
    const closeSlashAssistanceOutside = (event: PointerEvent) => {
      if (host.contains(event.target as Node) || slashInsertMenuRef.current?.contains(event.target as Node)) return;
      closeSlashInsertMenu();
    };
    window.addEventListener("keydown", onSlashMenuKeyDown, true);
    host.addEventListener("compositionstart", onSlashMenuCompositionStart, true);
    host.addEventListener("beforeinput", onEditorBeforeInput, true);
    host.addEventListener("compositionend", onEditorCompositionEnd, true);
    host.addEventListener("input", scheduleSlashInsertMenuSync, true);
    host.addEventListener("keyup", scheduleSlashInsertMenuSync, true);
    host.ownerDocument.addEventListener("selectionchange", scheduleSlashInsertMenuSync);
    host.addEventListener("scroll", scheduleSlashInsertMenuSync, { passive: true });
    window.addEventListener("resize", scheduleSlashInsertMenuSync);
    window.addEventListener("pointerdown", closeSlashAssistanceOutside, true);

    const uploadImage = async (file: File) => {
      showNotice("loading", en ? "Preparing image…" : "正在处理图片…", 0);
      try {
        const result = await imageFileToDataUrl(file);
        showNotice("success", en ? "Image inserted" : "图片已插入");
        return result;
      } catch (error) {
        showNotice("error", en ? "Couldn't insert this image" : "这张图片没有插入成功", 2800);
        throw error;
      }
    };

    const openRichLinkInsert = (ctx: Ctx, kind: RichLinkKind) => {
      hideSelectionToolbar();
      closeBlockMenu();
      // 自定义 Slash 命令打开自己的对话框前，显式收起 Crepe 命令面板。
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      const view = ctx.get(editorViewCtx);
      const $from = view.state.selection.$from;
      const pos = $from.depth > 0 ? $from.before(1) : 0;
      // 新建页的首块是页面标题，富媒体命令不能吞掉标题；回车进正文后再插入。
      if (isPageTitlePosition(view.state.doc, pos)) {
        showNotice("error", en ? "Insert media below the page title" : "请在页面标题下方插入媒体", 2200);
        return;
      }
      const target = view.state.doc.nodeAt(pos);
      if (!target?.isTextblock) {
        showNotice("error", en ? "Insert this block from a text line" : "请从正文空行插入这个区块", 2200);
        return;
      }
      // Crepe 的自定义命令不会像内置命令那样自动清掉 `/关键词`；在打开面板时归一为空正文，
      // 因此取消不会把斜杠查询残留进文档，提交时也能精确替换同一个块。
      const cleared = view.state.tr.replaceWith(pos, pos + target.nodeSize, paragraphSchema.type(ctx).create());
      view.dispatch(cleared.setSelection(TextSelection.create(cleared.doc, pos + 1)));
      setRichLinkDialog({ kind, pos, replaceNodeSize: target.nodeSize, url: "", label: "", error: "" });
    };

    const crepe = new Crepe({
      root: ref.current,
      defaultValue: initialValue,
      featureConfigs: {
        // Crepe 的「虚拟光标」会在块边界先闪出一个跟随小框；真实文本光标已经足够，关掉更安静。
        [CrepeFeature.Cursor]: { virtual: false },
        // 代码块用 oneDark(=atom-one-dark)黑底主题，与阅读视图一致；语言选择器/复制/预览文案随语言
        [CrepeFeature.CodeMirror]: {
          theme: oneDark,
          searchPlaceholder: M.cbSearch,
          noResultText: M.cbNoResult,
          copyText: M.cbCopy,
          previewLabel: M.cbPreview,
          previewLoading: M.cbLoading,
        },
        // 空文档占位符
        [CrepeFeature.Placeholder]: { text: M.ph },
        // 图片块：上传按钮 / 占位 / 说明文字随语言（*Icon/确认勾是 SVG，保留默认）
        [CrepeFeature.ImageBlock]: {
          onUpload: uploadImage,
          inlineUploadButton: M.imgUpload,
          inlineUploadPlaceholderText: M.imgPaste,
          blockUploadButton: M.imgUploadFile,
          blockConfirmButton: M.imgConfirm,
          blockCaptionPlaceholderText: M.imgCaption,
          blockUploadPlaceholderText: M.imgPaste,
        },
        // 链接气泡：输入框占位随语言（编辑/删除/确认是 SVG 图标，保留默认）
        [CrepeFeature.LinkTooltip]: { inputPlaceholder: M.linkPaste },
        // 斜杠「/」插入菜单 + 拖拽手柄菜单文案：跟随 app 语言（见 menuLabels）。
        // 只覆盖 label，图标走 Crepe 默认（合并是逐字段兜底 config?.x?.label ?? 默认，零风险）。
        [CrepeFeature.BlockEdit]: {
          // Slash 与块左侧 `+` 从同一个 Omia 注册表构建，ID、文案、别名、可用性和事务不再分叉。
          textGroup: null,
          listGroup: null,
          advancedGroup: null,
          buildMenu: (builder) => {
            const categoryLabels: Record<InsertCommandBrowseCategory, string> = en
              ? { basic: "Basics", list: "Lists", media: "Media & attachments", structure: "Structure & data", callout: "Callouts" }
              : { basic: "基础", list: "列表", media: "媒体与附件", structure: "结构与数据", callout: "提示" };
            const groups = new Map<InsertCommandBrowseCategory, ReturnType<typeof builder.addGroup>>();
            for (const category of ["basic", "list", "media", "structure", "callout"] as const) {
              groups.set(category, builder.addGroup(category, categoryLabels[category]));
            }
            const capabilities = { image: true, table: true, math: true };
            for (const command of getInsertCommandRegistry("slash")) {
              if (!isInsertCommandAvailable(command, capabilities)) continue;
              const aliases = [
                command.label[en ? "zh" : "en"],
                command.search.fullPinyin,
                command.search.initials,
                ...command.search.abbreviations,
                command.id,
              ];
              groups.get(command.category)?.addItem(command.id, {
                label: slashCommandLabel(command.label[lang], ...aliases),
                icon: insertCommandIcon(command),
                onRun: (ctx) => executeInsertCommand(ctx, command.execute, {
                  capabilities,
                  openRichLink: openRichLinkInsert,
                }),
              });
            }
          },
        },
      },
    });
    crepeRef.current = crepe;
    executeInsertCommandRef.current = (id, source, pos, tableSize) => {
      if (id === "table" && !tableSize) {
        updateTableSizePicker({ source, pos, value: DEFAULT_TABLE_SIZE });
        return true;
      }
      try {
        const executed = crepe.editor.action((ctx) => {
          const view = ctx.get(editorViewCtx);
          if (source === "slash") {
            const selection = view.state.selection;
            if (!(selection instanceof TextSelection) || !selection.empty) return false;
            const $from = selection.$from;
            const ancestorNames = Array.from({ length: $from.depth + 1 }, (_unused, depth) => $from.node(depth).type.name);
            const intent = parseSlashInvocation($from.parent.textContent, {
              selectionAtEnd: $from.parentOffset === $from.parent.content.size,
              inCode: ancestorNames.some((name) => name.includes("code")),
              inList: ancestorNames.some((name) => name.includes("list")),
              composing: imeComposing,
            });
            if (!intent || (newDocument && $from.depth > 0 && $from.before(1) === 0)) return false;
          } else if (!(source === "below" && ((id === "table" && tableSize) || id === "columns") && typeof pos === "number")) {
            if (typeof pos !== "number") return false;
            const node = view.state.doc.nodeAt(pos);
            if (!node?.isTextblock || node.content.size !== 0 || isPageTitlePosition(view.state.doc, pos)) return false;
            view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos + 1)));
          }
          closeSlashInsertMenu();
          updateBrowseInsertMenu(null);
          const done = executeInsertCommand(ctx, id, {
            capabilities: { image: true, table: true, math: true },
            openRichLink: openRichLinkInsert,
          }, tableSize
            ? { tableSize, insertAt: source === "below" ? pos : undefined }
            : id === "columns" ? { layoutColumns: 2, insertAt: source === "below" ? pos : undefined } : undefined);
          if (done) view.focus();
          return done;
        });
        if (executed) updateTableSizePicker(null);
        if (!executed) showNotice("error", en ? "This block couldn't be inserted" : "这个区块没有插入成功", 2400);
        return executed;
      } catch {
        showNotice("error", en ? "This block couldn't be inserted" : "这个区块没有插入成功", 2400);
        return false;
      }
    };

    const insertExternalImageSources = (sources: string[], clientX: number, clientY: number) => {
      const safeSources = sources.filter((source) => /^data:image\//i.test(source));
      if (safeSources.length !== sources.length || safeSources.length === 0) {
        throw new Error("unsupported image source");
      }
      crepe.editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const imageType = imageBlockSchema.type(ctx);
        const paragraphType = paragraphSchema.type(ctx);
        const blocks: Array<{
          pos: number;
          index: number;
          node: NonNullable<typeof view.state.doc.firstChild>;
          target: HTMLElement | null;
        }> = [];
        view.state.doc.forEach((node, pos, index) => {
          const target = view.nodeDOM(pos);
          blocks.push({ pos, index, node, target: target instanceof HTMLElement ? target : null });
        });

        const hit = view.posAtCoords({ left: clientX, top: clientY });
        const hitTopLevelPos = hit
          ? (() => {
              const $hit = view.state.doc.resolve(hit.pos);
              return $hit.depth > 0 ? $hit.before(1) : Math.min(hit.pos, view.state.doc.content.size);
            })()
          : null;
        // Atom 图片块上的 posAtCoords 可能返回“图片之后”的边界，从而误命中下一段；
        // 先按真实块矩形找落点，才能稳定填充用户刚选中的空图片占位。
        const target = blocks.find((block) => {
            const rect = block.target?.getBoundingClientRect();
            return rect ? clientY >= rect.top && clientY <= rect.bottom : false;
          })
          ?? blocks.find((block) => block.pos === hitTopLevelPos)
          ?? blocks[blocks.length - 1];

        const protectedTitleEnd = newDocument ? (view.state.doc.firstChild?.nodeSize ?? 0) : 0;
        const insertion = resolveEditorImageInsertion({
          target: target ? {
            pos: target.pos,
            index: target.index,
            nodeSize: target.node.nodeSize,
            blankImage: target.node.type === imageType && !String(target.node.attrs.src ?? "").trim(),
            emptyText: target.node.isTextblock && target.node.content.size === 0,
            dropAfter: target.target
              ? clientY >= target.target.getBoundingClientRect().top + target.target.getBoundingClientRect().height / 2
              : true,
          } : null,
          documentSize: view.state.doc.content.size,
          protectFirst: newDocument,
          protectedFirstEnd: protectedTitleEnd,
        });
        const { from, to } = insertion;
        const images = safeSources.map((src) => imageType.create({ src, caption: "", ratio: 1 }));
        const inserted = insertion.appendParagraph ? [...images, paragraphType.create()] : images;
        let tr = view.state.tr.replaceWith(from, to, inserted);
        const afterImages = from + images.reduce((size, node) => size + node.nodeSize, 0);
        const selectionPos = insertion.appendParagraph
          ? Math.min(afterImages + 1, tr.doc.content.size)
          : Math.min(afterImages, tr.doc.content.size);
        tr = tr.setSelection(Selection.near(tr.doc.resolve(selectionPos))).scrollIntoView();
        view.dispatch(tr);
        view.focus();
      });
      clearSelectedBlocks();
      closeBlockMenu();
    };

    const insertImageFiles = async (files: File[], clientX: number, clientY: number) => {
      showNotice("loading", en ? "Preparing image…" : "正在处理图片…", 0);
      try {
        const sources = await Promise.all(files.map(imageFileToDataUrl));
        insertExternalImageSources(sources, clientX, clientY);
        showNotice("success", en
          ? `${files.length === 1 ? "Image" : `${files.length} images`} inserted`
          : `已插入${files.length === 1 ? "图片" : ` ${files.length} 张图片`}`);
      } catch {
        showNotice("error", en ? "Couldn't insert this image" : "图片没有插入成功", 2800);
      }
    };

    const onNativeEditorImageDrop = (event: Event) => {
      const detail = (event as CustomEvent<EditorImageDropDetail>).detail;
      if (!detail?.paths.length) return;
      showNotice("loading", en ? "Preparing image…" : "正在处理图片…", 0);
      void Promise.all(detail.paths.map((path) => invoke<string>("file_to_data_uri", { path })))
        .then((sources) => {
          insertExternalImageSources(sources, detail.clientX, detail.clientY);
          showNotice("success", en
            ? `${sources.length === 1 ? "Image" : `${sources.length} images`} inserted`
            : `已插入${sources.length === 1 ? "图片" : ` ${sources.length} 张图片`}`);
        })
        .catch(() => showNotice("error", en ? "Couldn't insert this image" : "图片没有插入成功", 2800));
    };
    const externalImageFiles = (transfer: DataTransfer | null) => {
      if (!transfer) return [];
      const files = Array.from(transfer.files);
      return files.length > 0 && files.every(isSupportedEditorImageFile) ? files : [];
    };
    const transferContainsOnlyImages = (transfer: DataTransfer | null) => {
      if (!transfer) return false;
      const files = externalImageFiles(transfer);
      if (files.length > 0) return true;
      const fileItems = Array.from(transfer.items).filter((item) => item.kind === "file");
      return fileItems.length > 0 && fileItems.every((item) => item.type.toLocaleLowerCase().startsWith("image/"));
    };
    const onExternalImageDragOver = (event: DragEvent) => {
      if (!transferContainsOnlyImages(event.dataTransfer)) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
      host.classList.add("is-external-image-drag");
    };
    const onExternalImageDragLeave = (event: DragEvent) => {
      const next = event.relatedTarget as Node | null;
      if (!next || !host.contains(next)) host.classList.remove("is-external-image-drag");
    };
    const onExternalImageDrop = (event: DragEvent) => {
      const files = externalImageFiles(event.dataTransfer);
      if (files.length === 0) return;
      event.preventDefault();
      event.stopPropagation();
      host.classList.remove("is-external-image-drag");
      void insertImageFiles(files, event.clientX, event.clientY);
    };
    window.addEventListener(EDITOR_IMAGE_DROP_EVENT, onNativeEditorImageDrop);
    host.addEventListener("dragover", onExternalImageDragOver, true);
    host.addEventListener("dragleave", onExternalImageDragLeave, true);
    host.addEventListener("drop", onExternalImageDrop, true);

    // 六点既是排序手柄也是菜单入口。排序只走 Pointer Events，不走 HTML5 drag：
    // 后者在 Windows 会与 Tauri 的原生文件拖入互斥，曾导致“块能拖”和“文件能拖入”只能保一个。
    type ListItemHit = {
      id: string;
      pos: number;
      listPos: number;
      depth: number;
      target: HTMLElement;
      snapshot: ListDragTreeSnapshot;
    };
    type BlockPress = {
      x: number;
      y: number;
      at: number;
      pointerId: number;
      operation: HTMLElement;
      source: ReturnType<typeof blockAtViewportY>;
      listSource: ListItemHit | null;
      listSourceIds: string[];
      listRootX: number;
      listDropInput: ListDragTransactionInput | null;
      sourceIndices: number[];
      sourceTargets: HTMLElement[];
      destinationIndex: number;
      dropActive: boolean;
      dragging: boolean;
      dropLine: HTMLElement | null;
      ghost: HTMLElement | null;
      dropTarget: HTMLElement | null;
    };
    let blockPress: BlockPress | null = null;
    let blockAutoScrollFrame: number | null = null;
    let blockAutoScrollVelocity = 0;
    let blockPointerViewportX = 0;
    let blockPointerViewportY = 0;
    const selectedBlocks = new Map<number, HTMLElement>();
    const selectedListItems = new Map<string, ListItemHit>();
    let selectedListAnchor: string | null = null;
    const selectedBlockOverlays = new Map<number, HTMLElement>();
    let selectedBlockAnchor: number | null = null;
    let markdownAtLastBlockSelectionUpdate = serializePortableImageMarkdown(initialValue);
    const getDragOperation = (target: EventTarget | null) => {
      const operation = target instanceof Element
        ? target.closest<HTMLElement>(".milkdown-block-handle .operation-item")
        : null;
      if (!operation || operation.parentElement?.children[1] !== operation) return null;
      return operation;
    };
    const getAddOperation = (target: EventTarget | null) => {
      const operation = target instanceof Element
        ? target.closest<HTMLElement>(".milkdown-block-handle .operation-item")
        : null;
      if (!operation || operation.parentElement?.children[0] !== operation) return null;
      return operation;
    };
    const blockAtViewportY = (clientY: number) => {
      try {
        return crepe.editor.action((ctx) => {
          const view = ctx.get(editorViewCtx);
          const rect = view.dom.getBoundingClientRect();
          const paddingLeft = Number.parseFloat(getComputedStyle(view.dom).paddingLeft) || 72;
          const hit = view.posAtCoords({ left: Math.min(rect.right - 8, rect.left + paddingLeft + 12), top: clientY });
          if (!hit) return null;
          const $pos = view.state.doc.resolve(hit.pos);
          const pos = $pos.depth > 0 ? $pos.before(1) : Math.min(hit.pos, view.state.doc.content.size);
          const node = view.state.doc.nodeAt(pos);
          if (!node) return null;
          const blocks: Array<{ pos: number; nodeSize: number }> = [];
          view.state.doc.forEach((child, offset) => blocks.push({ pos: offset, nodeSize: child.nodeSize }));
          const index = blocks.findIndex((block) => block.pos === pos);
          if (index < 0) return null;
          const target = view.nodeDOM(pos);
          if (!(target instanceof HTMLElement)) return null;
          return {
            pos,
            target,
            index,
            count: blocks.length,
            isTextblock: node.isTextblock,
            contentSize: node.content.size,
            canConvert: node.isTextblock || node.type.name.includes("list") || node.type.name === "blockquote",
            pageTitle: bindVisualTitleToFirstH1(view.state.doc)?.pos === pos,
            entry: resolveBlockEntryDescriptor({
              nodeName: node.type.name,
              headingLevel: Number(node.attrs.level),
              textContent: node.textContent,
              className: target.className,
            }, lang),
          };
        });
      } catch {
        return null;
      }
    };
    const listItemRowRect = (target: HTMLElement) => {
      const firstContentRow = target.querySelector<HTMLElement>(
        ":scope > .list-item > .children > [data-content-dom] > :first-child",
      );
      return (firstContentRow ?? target).getBoundingClientRect();
    };
    const listItemAtViewportY = (clientY: number): ListItemHit | null => {
      try {
        return crepe.editor.action((ctx) => {
          const view = ctx.get(editorViewCtx);
          const listRoots: Array<{ listPos: number; distance: number }> = [];
          view.state.doc.forEach((node, listPos) => {
            if (node.type.name !== "bullet_list" && node.type.name !== "ordered_list") return;
            const target = view.nodeDOM(listPos);
            if (!(target instanceof HTMLElement)) return;
            const rect = target.getBoundingClientRect();
            const distance = clientY < rect.top ? rect.top - clientY : clientY > rect.bottom ? clientY - rect.bottom : 0;
            if (distance <= 2) listRoots.push({ listPos, distance });
          });
          const root = listRoots.sort((a, b) => a.distance - b.distance)[0];
          if (!root) return null;
          const { listPos } = root;
          const snapshot = inspectListDragTree(view.state.doc, listPos);
          if (!snapshot) return null;
          const rows = snapshot.entries.flatMap((entry) => {
            const target = view.nodeDOM(entry.pos);
            if (!(target instanceof HTMLElement)) return [];
            const rect = listItemRowRect(target);
            if (clientY < rect.top - 1 || clientY > rect.bottom + 1) return [];
            return [{ entry, target, rect }];
          });
          // 父列表项的 DOM 矩形可能包住整个子列表；最小矩形对应用户实际指向的行。
          const row = rows.sort((a, b) => {
            const heightDifference = a.rect.height - b.rect.height;
            return heightDifference || Math.abs(clientY - (a.rect.top + a.rect.bottom) / 2)
              - Math.abs(clientY - (b.rect.top + b.rect.bottom) / 2);
          })[0];
          if (!row) return null;
          return {
            id: row.entry.id,
            pos: row.entry.pos,
            listPos,
            depth: row.entry.depth,
            target: row.target,
            snapshot,
          };
        });
      } catch {
        return null;
      }
    };
    const blockAtSelection = () => {
      try {
        return crepe.editor.action((ctx) => {
          const view = ctx.get(editorViewCtx);
          const $from = view.state.selection.$from;
          const pos = $from.depth > 0 ? $from.before(1) : 0;
          const node = view.state.doc.nodeAt(pos);
          const target = view.nodeDOM(pos);
          if (!node || !(target instanceof HTMLElement)) return null;
          const blocks: Array<{ pos: number; nodeSize: number }> = [];
          view.state.doc.forEach((child, offset) => blocks.push({ pos: offset, nodeSize: child.nodeSize }));
          const index = blocks.findIndex((block) => block.pos === pos);
          if (index < 0) return null;
          return {
            pos,
            target,
            index,
            count: blocks.length,
            isTextblock: node.isTextblock,
            contentSize: node.content.size,
            canConvert: node.isTextblock || node.type.name.includes("list") || node.type.name === "blockquote",
            pageTitle: bindVisualTitleToFirstH1(view.state.doc)?.pos === pos,
            entry: resolveBlockEntryDescriptor({
              nodeName: node.type.name,
              headingLevel: Number(node.attrs.level),
              textContent: node.textContent,
              className: target.className,
            }, lang),
          };
        });
      } catch {
        return null;
      }
    };
    const blockAtIndex = (wantedIndex: number) => {
      try {
        return crepe.editor.action((ctx) => {
          const view = ctx.get(editorViewCtx);
          const blocks: Array<{ pos: number; node: NonNullable<typeof view.state.doc.firstChild> }> = [];
          view.state.doc.forEach((node, offset) => blocks.push({ pos: offset, node }));
          const found = blocks[wantedIndex];
          if (!found) return null;
          const target = view.nodeDOM(found.pos);
          if (!(target instanceof HTMLElement)) return null;
          return {
            pos: found.pos,
            target,
            index: wantedIndex,
            count: view.state.doc.childCount,
            isTextblock: found.node.isTextblock,
            contentSize: found.node.content.size,
            canConvert: found.node.isTextblock || found.node.type.name.includes("list") || found.node.type.name === "blockquote",
            pageTitle: bindVisualTitleToFirstH1(view.state.doc)?.pos === found.pos,
            entry: resolveBlockEntryDescriptor({
              nodeName: found.node.type.name,
              headingLevel: Number(found.node.attrs.level),
              textContent: found.node.textContent,
              className: target.className,
            }, lang),
          };
        });
      } catch {
        return null;
      }
    };
    const topLevelBlockTargets = () => {
      try {
        return crepe.editor.action((ctx) => {
          const view = ctx.get(editorViewCtx);
          const blocks: Array<{ index: number; target: HTMLElement }> = [];
          view.state.doc.forEach((_child, offset, index) => {
            const target = view.nodeDOM(offset);
            if (target instanceof HTMLElement) blocks.push({ index, target });
          });
          return blocks;
        });
      } catch {
        return [];
      }
    };
    const clearSelectedBlocks = () => {
      selectedBlocks.forEach((target) => {
        clearBlockVisualState(target, "selected-single", blockStateStatus ?? "omia-block-state-status");
        clearBlockVisualState(target, "selected-multi", blockStateStatus ?? "omia-block-state-status");
      });
      selectedBlockOverlays.forEach((overlay) => overlay.remove());
      selectedBlockOverlays.clear();
      selectedBlocks.clear();
      selectedBlockAnchor = null;
      selectedListItems.forEach(({ target }) => {
        clearBlockVisualState(target, "selected-single", blockStateStatus ?? "omia-block-state-status");
        clearBlockVisualState(target, "selected-multi", blockStateStatus ?? "omia-block-state-status");
      });
      selectedListItems.clear();
      selectedListAnchor = null;
    };
    clearBlockSelectionRef.current = clearSelectedBlocks;
    const refreshSelectedBlockVisualStates = () => {
      if (!blockStateStatus) return;
      const state = selectedBlocks.size > 1 ? "selected-multi" : "selected-single";
      selectedBlocks.forEach((target) => {
        clearBlockVisualState(target, "selected-single", blockStateStatus);
        clearBlockVisualState(target, "selected-multi", blockStateStatus);
        applyBlockVisualState(target, state, blockStateStatus, lang, selectedBlocks.size);
      });
      selectedBlockOverlays.forEach((overlay) => {
        applyBlockSelectionOverlayState(overlay, selectedBlocks.size, lang);
      });
    };
    const positionSelectedBlockOverlays = () => {
      const hostRect = host.getBoundingClientRect();
      const currentTargets = new Map(topLevelBlockTargets().map(({ index, target }) => [index, target]));
      selectedBlocks.forEach((_previousTarget, index) => {
        const overlay = selectedBlockOverlays.get(index);
        if (!overlay) return;
        const target = currentTargets.get(index);
        if (!target) {
          overlay.hidden = true;
          return;
        }
        if (selectedBlocks.get(index) !== target) {
          const oldTarget = selectedBlocks.get(index);
          if (oldTarget) {
            clearBlockVisualState(oldTarget, "selected-single", blockStateStatus ?? "omia-block-state-status");
            clearBlockVisualState(oldTarget, "selected-multi", blockStateStatus ?? "omia-block-state-status");
          }
        }
        selectedBlocks.set(index, target);
        const rect = target.getBoundingClientRect();
        const left = Math.max(hostRect.left, rect.left - 4);
        const right = Math.min(hostRect.right, rect.right + 4);
        const top = Math.max(hostRect.top, rect.top - 2);
        const bottom = Math.min(hostRect.bottom, rect.bottom + 2);
        overlay.hidden = right <= left || bottom <= top;
        if (overlay.hidden) return;
        overlay.style.left = `${Math.round(left)}px`;
        overlay.style.top = `${Math.round(top)}px`;
        overlay.style.width = `${Math.round(right - left)}px`;
        overlay.style.height = `${Math.round(bottom - top)}px`;
      });
      refreshSelectedBlockVisualStates();
    };
    const selectBlock = (index: number, target: HTMLElement) => {
      if (blockAtIndex(index)?.pageTitle) return;
      selectedBlocks.set(index, target);
      if (!selectedBlockOverlays.has(index)) {
        const overlay = document.createElement("div");
        overlay.className = "editor-block-selection-overlay";
        document.body.appendChild(overlay);
        selectedBlockOverlays.set(index, overlay);
      }
      refreshSelectedBlockVisualStates();
      requestAnimationFrame(positionSelectedBlockOverlays);
    };
    const updateBlockSelection = (
      block: NonNullable<ReturnType<typeof blockAtViewportY>>,
      event: Pick<PointerEvent, "metaKey" | "ctrlKey" | "shiftKey">,
    ) => {
      // Listener 的 docChanged 回调可能比最后一次键入晚到；开始多选时先同步当前文档，
      // 避免旧回调把刚加上的选择态误当成“正文又变了”而清掉。
      try {
        markdownAtLastBlockSelectionUpdate = crepe.editor.action((ctx) => {
          const view = ctx.get(editorViewCtx);
          return serializePortableImageMarkdown(ctx.get(serializerCtx)(view.state.doc).replace(
            /^(\s*>\s*)\\(\[!(?:note|tip|important|warning|caution)\])/gim,
            "$1$2",
          ));
        });
      } catch { /* 下一次真实 docChanged 仍会负责清理 */ }
      const additive = event.metaKey || event.ctrlKey;
      if (event.shiftKey) {
        const anchor = selectedBlockAnchor ?? block.index;
        if (!additive) clearSelectedBlocks();
        const from = Math.min(anchor, block.index);
        const to = Math.max(anchor, block.index);
        topLevelBlockTargets().forEach(({ index, target }) => {
          if (index >= from && index <= to) selectBlock(index, target);
        });
        selectedBlockAnchor = anchor;
        return;
      }
      if (!additive) return;
      const existing = selectedBlocks.get(block.index);
      if (existing) {
        selectedBlocks.delete(block.index);
        selectedBlockOverlays.get(block.index)?.remove();
        selectedBlockOverlays.delete(block.index);
        refreshSelectedBlockVisualStates();
      } else {
        selectBlock(block.index, block.target);
      }
      selectedBlockAnchor = block.index;
    };
    const selectedBlockIndices = () => [...selectedBlocks.keys()].sort((a, b) => a - b);
    const expandCollapsedSectionIndices = (indices: readonly number[]) => {
      try {
        return crepe.editor.action((ctx) => {
          const view = ctx.get(editorViewCtx);
          return [...expandCollapsedSectionBlockIndices(
            view.state.doc,
            indices,
            foldedHeadingPositions(view.state),
          )];
        });
      } catch {
        return [...indices];
      }
    };
    const refreshSelectedListVisualStates = () => {
      if (!blockStateStatus) return;
      const state = selectedListItems.size > 1 ? "selected-multi" : "selected-single";
      selectedListItems.forEach(({ target }) => {
        clearBlockVisualState(target, "selected-single", blockStateStatus);
        clearBlockVisualState(target, "selected-multi", blockStateStatus);
        applyBlockVisualState(target, state, blockStateStatus, lang, selectedListItems.size);
      });
    };
    const updateListSelection = (
      item: ListItemHit,
      event: Pick<PointerEvent, "metaKey" | "ctrlKey" | "shiftKey">,
    ) => {
      const additive = event.metaKey || event.ctrlKey;
      const compatibleEntries = item.snapshot.entries;
      if (event.shiftKey) {
        const anchor = selectedListAnchor && compatibleEntries.some(({ id }) => id === selectedListAnchor)
          ? selectedListAnchor
          : item.id;
        if (!additive) clearSelectedBlocks();
        const anchorIndex = compatibleEntries.findIndex(({ id }) => id === anchor);
        const itemIndex = compatibleEntries.findIndex(({ id }) => id === item.id);
        const from = Math.min(anchorIndex, itemIndex);
        const to = Math.max(anchorIndex, itemIndex);
        compatibleEntries.slice(from, to + 1).forEach((entry) => {
          const target = crepe.editor.action((ctx) => ctx.get(editorViewCtx).nodeDOM(entry.pos));
          if (target instanceof HTMLElement) {
            selectedListItems.set(entry.id, { ...item, id: entry.id, pos: entry.pos, depth: entry.depth, target });
          }
        });
        selectedListAnchor = anchor;
        refreshSelectedListVisualStates();
        return;
      }
      if (!additive) return;
      if (selectedBlocks.size > 0) clearSelectedBlocks();
      const existing = selectedListItems.get(item.id);
      if (existing) {
        clearBlockVisualState(existing.target, "selected-single", blockStateStatus ?? "omia-block-state-status");
        clearBlockVisualState(existing.target, "selected-multi", blockStateStatus ?? "omia-block-state-status");
        selectedListItems.delete(item.id);
      } else {
        selectedListItems.set(item.id, item);
      }
      selectedListAnchor = item.id;
      refreshSelectedListVisualStates();
    };
    const copySelectedBlocks = () => {
      const selectedIndices = selectedBlockIndices();
      const indices = expandCollapsedSectionIndices(selectedIndices);
      const includesCollapsedSection = indices.length > selectedIndices.length;
      if (indices.length === 0) return;
      let markdown = "";
      try {
        markdown = crepe.editor.action((ctx) => {
          const view = ctx.get(editorViewCtx);
          const nodes: Array<NonNullable<typeof view.state.doc.firstChild>> = [];
          view.state.doc.forEach((node, _offset, index) => {
            if (indices.includes(index)) nodes.push(node);
          });
          if (nodes.length !== indices.length) return "";
          const serializer = ctx.get(serializerCtx);
          if (includesCollapsedSection) {
            try {
              const groupedDocument = view.state.doc.type.create(view.state.doc.attrs, nodes);
              return serializePortableImageMarkdown(serializer(groupedDocument)).trimEnd();
            } catch { /* 单节点序列化兜底仍会保证文字不丢 */ }
          }
          return nodes.map((node) => {
            try { return serializePortableImageMarkdown(serializer(node)).trimEnd(); }
            catch { return node.textContent; }
          }).join("\n\n");
        });
      } catch { /* 下面统一反馈复制失败 */ }
      void copyEditorText(markdown).then((copied) => {
        showNotice(
          copied ? "success" : "error",
          copied
            ? (en ? `${indices.length} blocks copied` : `已复制 ${indices.length} 个区块`)
            : (en ? "Couldn't copy selected blocks" : "所选区块复制失败"),
          copied ? 1500 : 2600,
        );
      });
    };
    const deleteSelectedBlocks = () => {
      const indices = selectedBlockIndices();
      const liveTitleIndex = crepe.editor.action((ctx) => pageTitleIndex(ctx.get(editorViewCtx).state.doc));
      if (indices.length === 0 || indices.includes(liveTitleIndex ?? -1)) return;
      try {
        crepe.editor.action((ctx) => {
          const view = ctx.get(editorViewCtx);
          const blocks: Array<{ pos: number; nodeSize: number }> = [];
          view.state.doc.forEach((node, offset) => blocks.push({ pos: offset, nodeSize: node.nodeSize }));
          const sources = indices.map((index) => blocks[index]).filter((source): source is NonNullable<typeof source> => Boolean(source));
          if (sources.length !== indices.length) return;
          let tr = view.state.tr;
          [...sources].reverse().forEach((source) => {
            tr = tr.delete(source.pos, source.pos + source.nodeSize);
          });
          if (tr.doc.childCount === 0) tr = tr.insert(0, paragraphSchema.type(ctx).create());
          const selectionAt = Math.min(sources[0]?.pos ?? 0, tr.doc.content.size);
          view.dispatch(tr.setSelection(Selection.near(tr.doc.resolve(selectionAt))).scrollIntoView());
          view.focus();
        });
        clearSelectedBlocks();
        closeBlockMenu();
        showNotice("success", en ? `${indices.length} blocks deleted` : `已删除 ${indices.length} 个区块`);
      } catch {
        showNotice("error", en ? "Couldn't delete selected blocks" : "所选区块删除失败", 2600);
      }
    };
    const onSelectedBlocksKeyDown = (event: KeyboardEvent) => {
      if (selectedBlocks.size === 0) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        clearSelectedBlocks();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "c") {
        event.preventDefault();
        event.stopPropagation();
        copySelectedBlocks();
        return;
      }
      if (event.key !== "Backspace" && event.key !== "Delete") return;
      event.preventDefault();
      event.stopPropagation();
      deleteSelectedBlocks();
    };
    const onSelectAllKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || (event.target as HTMLElement | null)?.closest(".cm-editor")) return;
      try {
        const handled = crepe.editor.action((ctx) => {
          const view = ctx.get(editorViewCtx);
          const selection = view.state.selection;
          const sameTextblock = selection.$from.sameParent(selection.$to) && selection.$from.parent.isTextblock;
          const blockStart = sameTextblock ? selection.$from.start() : -1;
          const blockEnd = sameTextblock ? selection.$from.end() : -1;
          const stage = shouldStageSelectAll({
            key: event.key,
            commandModifier: event.metaKey || event.ctrlKey,
            shiftKey: event.shiftKey,
            altKey: event.altKey,
            isComposing: event.isComposing || imeComposing,
            hasBlockSelection: selectedBlocks.size > 0,
            isTextSelection: selection instanceof TextSelection,
            sameTextblock,
            textblockEmpty: !sameTextblock || selection.$from.parent.content.size === 0,
            selectionCoversTextblock: sameTextblock && selection.from === blockStart && selection.to === blockEnd,
          });
          if (!stage) return false;
          view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, blockStart, blockEnd)));
          view.focus();
          return true;
        });
        if (!handled) return;
        event.preventDefault();
        event.stopPropagation();
        scheduleSelectionToolbar();
      } catch { /* 编辑器尚未 ready 时交还原生全选 */ }
    };
    const onNewDocumentBoundaryKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || imeComposing) return;
      if (event.key !== "Backspace" && event.key !== "Delete" && event.key !== "Enter") return;
      if (!host.querySelector('[data-omia-page-title="1"]')) return;
      // WKWebView 的 compositionend 早于 keydown；50ms 内的 Enter 是确认候选词的尾波。
      if (isCurrentImeEnter(event)) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      try {
        const result = crepe.editor.action((ctx) => {
          const view = ctx.get(editorViewCtx);
          const { doc, selection } = view.state;
          const binding = bindVisualTitleToFirstH1(doc);
          if (!binding) return false;
          const title = doc.nodeAt(binding.pos);
          const bodyIndex = doc.childCount > 1 ? (binding.index === 0 ? 1 : 0) : -1;
          const body = bodyIndex >= 0 ? doc.child(bodyIndex) : null;
          let bodyPos = binding.pos + (title?.nodeSize ?? 0);
          if (bodyIndex >= 0) {
            doc.forEach((_node, offset, index) => { if (index === bodyIndex) bodyPos = offset; });
          } else if (binding.index > 0) bodyPos = 0;
          const topLevelPos = selection.$from.depth > 0 ? selection.$from.before(1) : -1;
          let topLevelIndex = -1;
          doc.forEach((_node, offset, index) => {
            if (offset === topLevelPos) topLevelIndex = index;
          });
          const action = resolvePageTitleBoundaryAction({
            key: event.key,
            selectionCollapsed: selection.empty,
            selectionCoversDocument: selection.from === 0 && selection.to === doc.content.size,
            hasCommandModifier: event.metaKey || event.ctrlKey || event.altKey,
            hasBlockSelection: selectedBlocks.size > 0,
            titleIndex: binding.index,
            bodyIndex,
            bodyIsTextblock: Boolean(body?.isTextblock),
            topLevelIndex,
            offsetInTextblock: selection.$from.parentOffset,
            textblockSize: selection.$from.parent.content.size,
          });
          if (action === "none") return false;
          if (action === "clear-page") {
            const emptyTitle = headingSchema.type(ctx).create({ level: 1 });
            const emptyBody = paragraphSchema.type(ctx).create();
            const tr = view.state.tr.replaceWith(0, doc.content.size, [emptyTitle, emptyBody]);
            view.dispatch(tr.setSelection(TextSelection.near(tr.doc.resolve(1))).scrollIntoView());
          } else if (action === "enter-body" && title) {
            let tr = view.state.tr;
            if (!body?.isTextblock) tr = tr.insert(bodyPos, paragraphSchema.type(ctx).create());
            view.dispatch(
              tr.setSelection(TextSelection.near(tr.doc.resolve(bodyPos + 1))).scrollIntoView(),
            );
          } else if (action === "focus-title-end" && title) {
            view.dispatch(view.state.tr.setSelection(TextSelection.near(doc.resolve(binding.pos + title.nodeSize - 1))));
          } else if (action === "focus-body-start" && title && body) {
            view.dispatch(view.state.tr.setSelection(TextSelection.near(doc.resolve(bodyPos + 1))));
          }
          view.focus();
          return true;
        });
        if (!result) return;
        event.preventDefault();
        event.stopPropagation();
      } catch { /* 编辑器尚未 ready 时交还原生键盘行为 */ }
    };
    const onNewDocumentCut = (event: ClipboardEvent) => {
      if (event.defaultPrevented || selectedBlocks.size > 0) return;
      try {
        const cleared = crepe.editor.action((ctx) => {
          const view = ctx.get(editorViewCtx);
          const { doc, selection } = view.state;
          const titleBinding = bindVisualTitleToFirstH1(doc);
          const cutsWholePage = selection.from === 0 && selection.to === doc.content.size;
          const hasPageTitle = Boolean(titleBinding);
          if (!cutsWholePage || !hasPageTitle) return false;

          const selectedText = host.ownerDocument.getSelection()?.toString() ?? doc.textBetween(0, doc.content.size, "\n\n");
          if (event.clipboardData) event.clipboardData.setData("text/plain", selectedText);
          else void copyEditorText(selectedText);

          const emptyTitle = headingSchema.type(ctx).create({ level: 1 });
          const emptyBody = paragraphSchema.type(ctx).create();
          const tr = view.state.tr.replaceWith(0, doc.content.size, [emptyTitle, emptyBody]);
          view.dispatch(tr.setSelection(TextSelection.near(tr.doc.resolve(1))).scrollIntoView());
          view.focus();
          return true;
        });
        if (!cleared) return;
        event.preventDefault();
        event.stopPropagation();
      } catch { /* 剪切板事件异常时交还编辑器原行为 */ }
    };
    const onUrlPaste = (event: ClipboardEvent) => {
      if (event.defaultPrevented || !event.clipboardData) return;
      const transfer = event.clipboardData;
      let selectionEmpty = true;
      try {
        selectionEmpty = crepe.editor.action((ctx) => ctx.get(editorViewCtx).state.selection.empty);
      } catch {
        return;
      }
      const intent = classifyUrlPasteIntent({
        plainText: transfer.getData("text/plain"),
        htmlText: transfer.getData("text/html"),
        fileCount: transfer.files.length,
        hasFileItems: Array.from(transfer.items).some((item) => item.kind === "file"),
        selectionEmpty,
      });
      if (intent.kind === "pass-through") return;

      event.preventDefault();
      event.stopImmediatePropagation();
      hideSelectionToolbar();
      closeSlashInsertMenu();
      closeBlockMenu();
      updateBrowseInsertMenu(null);
      if (intent.kind === "blocked-url") {
        showNotice("error", en ? "Unsafe link blocked" : "已阻止不安全链接", 2600);
        return;
      }

      let inserted = false;
      try {
        crepe.editor.action((ctx) => {
          const view = ctx.get(editorViewCtx);
          const result = insertUrlPaste(view.state, intent.href);
          if (!result) return;
          view.dispatch(result.transaction.scrollIntoView());
          const $from = view.state.doc.resolve(result.from);
          const $to = view.state.doc.resolve(result.to);
          const coords = view.coordsAtPos(result.to);
          const hostRect = host.getBoundingClientRect();
          const pickerWidth = Math.min(360, Math.max(264, hostRect.width - 16));
          setLinkDisplayPicker({
            from: result.from,
            to: result.to,
            href: intent.href,
            label: view.state.doc.textBetween(result.from, result.to, ""),
            canBookmark: $from.sameParent($to)
              && $from.parent.type.name === "paragraph"
              && result.from === $from.start()
              && result.to === $from.end(),
            left: Math.round(Math.max(hostRect.left + 8, Math.min(hostRect.right - pickerWidth - 8, coords.left))),
            top: Math.round(Math.min(window.innerHeight - 188, coords.bottom + 8)),
            loading: false,
          });
          view.focus();
          inserted = true;
        });
      } catch {
        inserted = false;
      }
      showNotice(
        inserted ? "success" : "error",
        inserted
          ? (en ? "Link pasted" : "链接已粘贴")
          : (en ? "Couldn't paste this link" : "这个链接没有粘贴成功"),
        inserted ? 1500 : 2600,
      );
    };
    const onExternalHtmlPasteNotice = (event: ClipboardEvent) => {
      if (event.defaultPrevented || !event.clipboardData || event.clipboardData.files.length > 0) return;
      const html = event.clipboardData.getData("text/html");
      if (!html) return;
      const result = sanitizeUnknownClipboardHtmlWithReport(html);
      if (!result.degraded) return;
      showNotice(
        "success",
        en
          ? "Unsupported external styles were removed; the text was kept"
          : "已移除不支持的外部样式，正文已保留",
        2600,
      );
    };
    let linkHoverTimer: number | undefined;
    let linkLeaveTimer: number | undefined;
    const clearLinkTimers = () => {
      if (linkHoverTimer != null) window.clearTimeout(linkHoverTimer);
      if (linkLeaveTimer != null) window.clearTimeout(linkLeaveTimer);
      linkHoverTimer = undefined;
      linkLeaveTimer = undefined;
    };
    const closeLinkToolbar = () => {
      if (linkLeaveTimer != null) window.clearTimeout(linkLeaveTimer);
      linkLeaveTimer = undefined;
      setLinkToolbar(null);
    };
    const scheduleLinkToolbarClose = () => {
      if (linkLeaveTimer != null) window.clearTimeout(linkLeaveTimer);
      linkLeaveTimer = window.setTimeout(closeLinkToolbar, 180);
    };
    const showLinkToolbarForAnchor = (anchor: HTMLAnchorElement) => {
      if (selectionPointerOrigin || currentTextSelectionRangeInside()) {
        closeLinkToolbar();
        return;
      }
      try {
        crepe.editor.action((ctx) => {
          const view = ctx.get(editorViewCtx);
          const pos = view.posAtDOM(anchor, 0);
          const range = findLinkRangeAtPos(view.state, pos);
          if (!range || range.title) return;
          const rect = anchor.getBoundingClientRect();
          const hostRect = host.getBoundingClientRect();
          const width = Math.min(420, Math.max(300, hostRect.width - 16));
          hideSelectionToolbar();
          closeSlashInsertMenu();
          closeBlockMenu();
          updateBrowseInsertMenu(null);
          setLinkDisplayPicker(null);
          setLinkToolbar({
            from: range.from,
            to: range.to,
            href: range.href,
            label: range.label,
            left: Math.round(Math.max(hostRect.left + 8, Math.min(hostRect.right - width - 8, rect.left))),
            top: Math.round(Math.min(window.innerHeight - 54, rect.bottom + 7)),
            editing: false,
            draft: range.href,
          });
        });
      } catch { /* 链接已被事务移除时保持关闭 */ }
    };
    const anchorFromEvent = (event: Event) => event.target instanceof Element
      ? event.target.closest<HTMLAnchorElement>(".ProseMirror a[href]")
      : null;
    const onLinkMouseOver = (event: MouseEvent) => {
      const anchor = anchorFromEvent(event);
      if (!anchor || (event.relatedTarget instanceof Node && anchor.contains(event.relatedTarget))) return;
      clearLinkTimers();
      linkHoverTimer = window.setTimeout(() => showLinkToolbarForAnchor(anchor), 300);
    };
    const onLinkMouseOut = (event: MouseEvent) => {
      const anchor = anchorFromEvent(event);
      if (!anchor) return;
      if (event.relatedTarget instanceof Node && (anchor.contains(event.relatedTarget) || linkToolbarRef.current?.contains(event.relatedTarget))) return;
      if (linkHoverTimer != null) window.clearTimeout(linkHoverTimer);
      linkHoverTimer = undefined;
      scheduleLinkToolbarClose();
    };
    const onLinkFocusIn = (event: FocusEvent) => {
      const anchor = anchorFromEvent(event);
      if (!anchor) return;
      clearLinkTimers();
      showLinkToolbarForAnchor(anchor);
    };
    const closeLinkToolbarOutside = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target || linkToolbarRef.current?.contains(target) || (target instanceof Element && target.closest(".ProseMirror a[href]"))) return;
      closeLinkToolbar();
    };
    host.addEventListener("mouseover", onLinkMouseOver, true);
    host.addEventListener("mouseout", onLinkMouseOut, true);
    host.addEventListener("focusin", onLinkFocusIn, true);
    window.addEventListener("pointerdown", closeLinkToolbarOutside, true);
    let advancedCellPress: {
      pointerId: number;
      root: HTMLElement;
      anchor: AdvancedTableCellCoordinate;
      focus: AdvancedTableCellCoordinate;
    } | null = null;
    let pendingAdvancedCellSelection: {
      root: HTMLElement;
      anchor: AdvancedTableCellCoordinate;
      focus: AdvancedTableCellCoordinate;
    } | null = null;
    let suppressAdvancedCompatibilityClickRoot: HTMLElement | null = null;
    let advancedCompatibilityClickTimer: number | null = null;
    const nodeRootFromTarget = (target: Element, kind: NodeToolbarKind) => {
      if (kind === "code") return target.closest<HTMLElement>(".milkdown-code-block");
      if (kind === "layout") return target.closest<HTMLElement>("[data-omia-layout-view='1']");
      if (kind === "bookmark" || kind === "audio" || kind === "video" || kind === "file") return target.closest<HTMLElement>("[data-omia-rich-link]");
      if (kind === "image") return target.closest<HTMLElement>(".milkdown-image-block");
      if (kind === "table") return target.closest<HTMLElement>(".milkdown-table-block") ?? target.closest<HTMLElement>("table");
      return target.closest<HTMLElement>("[data-type='math_block'], [data-type='math_inline'], .milkdown-latex-block, .milkdown-latex-inline");
    };
    const richKindOfNode = (node: ProseNode | null) => {
      if (!node || node.type.name !== "paragraph" || !node.content.size) return null;
      let kind: PortableNodeKind | null = null;
      let valid = true;
      node.forEach((child) => {
        const title = child.marks.find((mark) => mark.type.name === "link")?.attrs.title;
        const match = typeof title === "string" ? title.match(/^omia:(bookmark|audio|video|file)$/) : null;
        if (!match || (kind && kind !== match[1])) valid = false;
        else kind = match[1] as PortableNodeKind;
      });
      return valid ? kind : null;
    };
    const onPortableNodeClick = (event: MouseEvent | PointerEvent) => {
      const target = event.target as Element | null;
      if (suppressAdvancedCompatibilityClickRoot && event.isTrusted) {
        const suppressThisClick = shouldSuppressAdvancedCompatibilityClick(suppressAdvancedCompatibilityClickRoot, target);
        suppressAdvancedCompatibilityClickRoot = null;
        if (advancedCompatibilityClickTimer != null) window.clearTimeout(advancedCompatibilityClickTimer);
        advancedCompatibilityClickTimer = null;
        if (suppressThisClick) {
          event.preventDefault();
          event.stopImmediatePropagation();
          return;
        }
      }
      // The toolbar lives inside `host`, so this capture listener sees its physical clicks
      // before React dispatches the button's `onClick`.  WebView2 may flush the close update
      // immediately and unmount the button; explicitly leave toolbar-owned events alone.
      if (target && nodeToolbarRef.current?.contains(target)) return;
      const kind = resolveNodeToolbarKind(target);
      if (kind && kind !== "code") claimPortableNodeActivation(event, target);
      const root = target && kind ? nodeRootFromTarget(target, kind) : null;
      if (!target || !kind || !root) {
        if (target && host.contains(target)) closeNodeToolbar();
        return;
      }
      if (kind === "code") {
        const selection = host.ownerDocument.getSelection();
        const hasTextSelection = Boolean(selection && !selection.isCollapsed && selection.toString().trim());
        if (resolveCodeSurfaceIntent({ insideCode: true, hasTextSelection }) === "selection-toolbar") {
          closeNodeToolbar();
          scheduleSelectionToolbar();
          return;
        }
      }
      try {
        crepe.editor.action((ctx) => {
          const view = ctx.get(editorViewCtx);
          const hit = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos ?? -1;
          let selected: {
            pos: number;
            nodeSize: number;
            tableAdvanced?: boolean;
            tableModel?: AdvancedTableModel;
            layoutModel?: PersistentLayoutModel;
            href?: string;
            label?: string;
            src?: string;
            caption?: string;
            ratio?: number;
            language?: string;
            codeText?: string;
          } | null = null;
          let selectedDomMatch = false;
          view.state.doc.descendants((node, pos) => {
            const nodeKind = node.type.name === "code_block"
              ? "code"
              : node.type.name === "image-block"
              ? "image"
              : node.type.name === "table"
                ? "table"
                : node.type.name === ADVANCED_TABLE_NODE_NAME
                  ? "table"
                : node.type.name === PERSISTENT_LAYOUT_NODE_NAME
                  ? "layout"
                : /math|latex/.test(node.type.name)
                  ? "math"
                  : richKindOfNode(node);
            if (nodeKind !== kind) return;
            const nodeDom = view.nodeDOM(pos);
            const domMatches = nodeDom === root
              || (nodeDom instanceof Element && (nodeDom.contains(root) || root.contains(nodeDom)));
            const positionMatches = hit >= pos && hit <= pos + node.nodeSize;
            if (!domMatches && !positionMatches) return;
            if (selected) {
              if (selectedDomMatch && !domMatches) return;
              if (selectedDomMatch === domMatches && selected.nodeSize <= node.nodeSize) return;
            }
            const link = node.firstChild?.marks.find((mark) => mark.type.name === "link");
            selected = {
              pos,
              nodeSize: node.nodeSize,
              tableAdvanced: node.type.name === ADVANCED_TABLE_NODE_NAME,
              tableModel: node.type.name === ADVANCED_TABLE_NODE_NAME ? node.attrs.model as AdvancedTableModel : undefined,
              layoutModel: node.type.name === PERSISTENT_LAYOUT_NODE_NAME ? node.attrs.model as PersistentLayoutModel : undefined,
              href: typeof link?.attrs.href === "string" ? link.attrs.href : undefined,
              label: node.textContent || undefined,
              src: node.type.name === "image-block" ? String(node.attrs.src ?? "") : undefined,
              caption: node.type.name === "image-block" ? String(node.attrs.caption ?? "") : undefined,
              ratio: node.type.name === "image-block" ? Number(node.attrs.ratio ?? 1) : undefined,
              language: node.type.name === "code_block" ? String(node.attrs.language ?? "") : undefined,
              codeText: node.type.name === "code_block" ? node.textContent : undefined,
            };
            selectedDomMatch = domMatches;
          });
          if (!selected) return;
          const selectedNode = selected as {
            pos: number;
            nodeSize: number;
            tableAdvanced?: boolean;
            tableModel?: AdvancedTableModel;
            layoutModel?: PersistentLayoutModel;
            href?: string;
            label?: string;
            src?: string;
            caption?: string;
            ratio?: number;
            language?: string;
            codeText?: string;
          };
          if (kind === "layout" && !(view.state.selection instanceof NodeSelection && view.state.selection.from === selectedNode.pos)) {
            view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, selectedNode.pos)));
          }
          const clickedCell = kind === "table" ? target.closest<HTMLElement>("th, td") : null;
          const clickedRow = clickedCell?.closest<HTMLElement>("tr") ?? null;
          const tableRows = kind === "table" ? Array.from(root.querySelectorAll<HTMLElement>("tr")) : [];
          const tableSection = selectedNode.tableAdvanced && (clickedCell?.dataset.omiaTableSection === "head" || clickedCell?.dataset.omiaTableSection === "body")
            ? clickedCell.dataset.omiaTableSection as AdvancedTableSection
            : undefined;
          const tableRow = selectedNode.tableAdvanced
            ? Number(clickedCell?.dataset.omiaTableRow ?? -1)
            : clickedRow ? tableRows.indexOf(clickedRow) : -1;
          const tableColumn = selectedNode.tableAdvanced
            ? Number(clickedCell?.dataset.omiaTableColumn ?? -1)
            : clickedCell && clickedRow
              ? Array.from(clickedRow.querySelectorAll<HTMLElement>("th, td")).indexOf(clickedCell)
              : -1;
          const clickedCoordinate = tableSection && tableRow >= 0 && tableColumn >= 0
            ? { section: tableSection, row: tableRow, column: tableColumn } as AdvancedTableCellCoordinate
            : null;
          const clickedCellRect = clickedCell?.getBoundingClientRect();
          const rect = root.getBoundingClientRect();
          const hostRect = host.getBoundingClientRect();
          const width = Math.min(560, Math.max(300, hostRect.width - 16));
          const codeTarget = kind === "code"
            ? createCodeTargetToken(view.state, selectedNode.pos, documentRevisionRef.current)
            : null;
          if (kind === "code" && !codeTarget) return;
          const tableContext = kind === "table" && !selectedNode.tableAdvanced && tableRow >= 0 && tableColumn >= 0
            ? resolvePortableTableContext(view.state, {
              pos: selectedNode.pos,
              nodeSize: selectedNode.nodeSize,
              row: tableRow,
              column: tableColumn,
            })
            : null;
          hideSelectionToolbar();
          closeSlashInsertMenu();
          closeBlockMenu();
          updateBrowseInsertMenu(null);
          setLinkDisplayPicker(null);
          setLinkToolbar(null);
          setNodeToolbar((current) => {
            if (current?.target !== root) {
              applyPortableNodeSelection(current?.target ?? root, false, "");
              if (current?.kind === "table" && current.tableRow != null && current.tableColumn != null) {
                if (current.tableAdvanced) applyAdvancedTableCellSelection(current.target, current.tableSelection ?? [], false);
                else applyTableCellSelection(current.target, current.tableRow, current.tableColumn, false, "");
              }
            }
            applyPortableNodeSelection(root, true, `${nodeToolbarLabel(kind, lang)} ${en ? "selected" : "已选中"}`);
            const pendingSelection = clickedCoordinate && pendingAdvancedCellSelection?.root === root
              ? pendingAdvancedCellSelection
              : null;
            pendingAdvancedCellSelection = null;
            const selectionFocus = pendingSelection?.focus ?? clickedCoordinate;
            const tableAnchor = pendingSelection?.anchor
              ?? (clickedCoordinate && current?.target === root && current.tableAdvanced && event.shiftKey && current.tableAnchor?.section === clickedCoordinate.section
                ? current.tableAnchor
                : clickedCoordinate ?? undefined);
            const tableSelection = selectionFocus && tableAnchor
              ? advancedTableRectSelection(tableAnchor, selectionFocus)
              : [];
            const mergeAnalysis = selectedNode.tableModel && tableSelection.length
              ? analyzeAdvancedTableMerge(selectedNode.tableModel, tableSelection)
              : null;
            const selectedCell = selectedNode.tableModel && clickedCoordinate
              ? readAdvancedTableCell(selectedNode.tableModel, clickedCoordinate)
              : null;
            if (kind === "table" && tableRow >= 0 && tableColumn >= 0) {
              if (selectedNode.tableAdvanced) {
                applyAdvancedTableCellSelection(root, current?.tableSelection ?? [], false);
                applyAdvancedTableCellSelection(root, tableSelection, true);
              } else {
                applyTableCellSelection(
                  root,
                  tableRow,
                  tableColumn,
                  true,
                  en ? `Table cell ${tableRow + 1}, ${tableColumn + 1} selected` : `已选择表格第 ${tableRow + 1} 行第 ${tableColumn + 1} 列`,
                );
              }
            }
            return {
              kind,
              pos: selected!.pos,
              nodeSize: selected!.nodeSize,
              target: root,
              href: selected!.href,
              label: selected!.label,
              src: selected!.src,
              caption: selected!.caption,
              ratio: selected!.ratio,
              language: selected!.language,
              codeText: selected!.codeText,
              revision: codeTarget?.revision,
              wrap: root.classList.contains("omia-code-wrap"),
              query: "",
              tableRow: tableRow >= 0 ? tableRow : undefined,
              tableColumn: tableColumn >= 0 ? tableColumn : undefined,
              tableContext: tableContext ?? undefined,
              tableAdvanced: selected!.tableAdvanced,
              layoutModel: selected!.layoutModel,
              layoutLosses: selected!.layoutModel ? analyzePersistentLayoutDowngrade(selected!.layoutModel) ?? undefined : undefined,
              tableSection,
              tableAnchor,
              tableSelection,
              tableCanMerge: mergeAnalysis?.ok ?? false,
              tableCanSplit: selectedNode.tableModel && clickedCoordinate
                ? Boolean(splitAdvancedTableCell(selectedNode.tableModel, clickedCoordinate))
                : false,
              tableMergeReason: mergeAnalysis && !mergeAnalysis.ok ? mergeAnalysis.reason : undefined,
              tableCellBackground: selectedCell?.background,
              tableCellBlocks: selectedCell?.blocks,
              cellRect: clickedCellRect ? {
                left: Math.round(clickedCellRect.left),
                top: Math.round(clickedCellRect.top),
                width: Math.round(clickedCellRect.width),
                height: Math.round(clickedCellRect.height),
              } : undefined,
              mode: "actions",
              draft: selected!.href ?? selected!.src ?? "",
              left: Math.round(Math.max(hostRect.left + 8, Math.min(hostRect.right - width - 8, rect.left))),
              top: Math.round(kind === "code"
                ? Math.max(hostRect.top + 8, Math.min(window.innerHeight - 48, rect.top + 4))
                : Math.max(hostRect.top + 8, Math.min(window.innerHeight - 48, rect.top - 44))),
            };
          });
        });
      } catch { /* 节点在点击后被原生事务替换时不显示陈旧工具栏 */ }
    };
    const advancedCoordinateFromCell = (cell: HTMLElement | null): AdvancedTableCellCoordinate | null => {
      const section = cell?.dataset.omiaTableSection;
      const row = Number(cell?.dataset.omiaTableRow ?? -1);
      const column = Number(cell?.dataset.omiaTableColumn ?? -1);
      return (section === "head" || section === "body") && row >= 0 && column >= 0
        ? { section, row, column }
        : null;
    };
    const advancedCellAtPoint = (event: PointerEvent) => (
      host.ownerDocument.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("table[data-omia-table='1'] [data-omia-table-section]") ?? null
    );
    const onAdvancedTableCellPointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      const cell = event.target instanceof Element
        ? event.target.closest<HTMLElement>("table[data-omia-table='1'] [data-omia-table-section]")
        : null;
      const root = cell?.closest<HTMLElement>("table[data-omia-table='1']") ?? null;
      const coordinate = advancedCoordinateFromCell(cell);
      if (!root || !coordinate) return;
      event.preventDefault();
      advancedCellPress = { pointerId: event.pointerId, root, anchor: coordinate, focus: coordinate };
    };
    const onAdvancedTableCellPointerMove = (event: PointerEvent) => {
      const press = advancedCellPress;
      if (!press || press.pointerId !== event.pointerId) return;
      const cell = advancedCellAtPoint(event);
      const root = cell?.closest<HTMLElement>("table[data-omia-table='1']") ?? null;
      const coordinate = advancedCoordinateFromCell(cell);
      if (!root || root !== press.root || !coordinate || coordinate.section !== press.anchor.section) return;
      if (coordinate.row === press.focus.row && coordinate.column === press.focus.column) return;
      press.focus = coordinate;
      event.preventDefault();
      applyAdvancedTableCellSelection(press.root, advancedTableRectSelection(press.anchor, press.focus), true);
    };
    const onAdvancedTableCellPointerUp = (event: PointerEvent) => {
      const press = advancedCellPress;
      if (!press || press.pointerId !== event.pointerId) return;
      advancedCellPress = null;
      const focusCell = Array.from(press.root.querySelectorAll<HTMLElement>("[data-omia-table-section]"))
        .find((cell) => cell.dataset.omiaTableSection === press.focus.section
          && Number(cell.dataset.omiaTableRow) === press.focus.row
          && Number(cell.dataset.omiaTableColumn) === press.focus.column);
      if (!focusCell) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      pendingAdvancedCellSelection = { root: press.root, anchor: press.anchor, focus: press.focus };
      suppressAdvancedCompatibilityClickRoot = press.root;
      if (advancedCompatibilityClickTimer != null) window.clearTimeout(advancedCompatibilityClickTimer);
      advancedCompatibilityClickTimer = window.setTimeout(() => {
        suppressAdvancedCompatibilityClickRoot = null;
        advancedCompatibilityClickTimer = null;
      }, 400);
      focusCell.dispatchEvent(new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        clientX: event.clientX,
        clientY: event.clientY,
      }));
    };
    const onAdvancedTableCellPointerCancel = (event: PointerEvent) => {
      if (advancedCellPress?.pointerId !== event.pointerId) return;
      applyAdvancedTableCellSelection(advancedCellPress.root, [], false);
      advancedCellPress = null;
    };
    const onCodeNodePointerUp = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (resolveNodeToolbarKind(target) !== "code") return;
      onPortableNodeClick(event);
    };
    const closeNodeToolbarOutside = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target || nodeToolbarRef.current?.contains(target) || (target instanceof Element && resolveNodeToolbarKind(target))) return;
      closeNodeToolbar();
    };
    const repositionNodeToolbar = () => {
      setNodeToolbar((current) => {
        if (!current || !current.target.isConnected) return null;
        const rect = current.target.getBoundingClientRect();
        const hostRect = host.getBoundingClientRect();
        const width = Math.min(560, Math.max(300, hostRect.width - 16));
        return {
          ...current,
          left: Math.round(Math.max(hostRect.left + 8, Math.min(hostRect.right - width - 8, rect.left))),
          top: Math.round(current.kind === "code"
            ? Math.max(hostRect.top + 8, Math.min(window.innerHeight - 48, rect.top + 4))
            : Math.max(hostRect.top + 8, Math.min(window.innerHeight - 48, rect.top - 44))),
        };
      });
    };
    host.addEventListener("pointerdown", onAdvancedTableCellPointerDown, true);
    host.ownerDocument.addEventListener("pointermove", onAdvancedTableCellPointerMove, true);
    host.ownerDocument.addEventListener("pointerup", onAdvancedTableCellPointerUp, true);
    host.ownerDocument.addEventListener("pointercancel", onAdvancedTableCellPointerCancel, true);
    host.addEventListener("click", onPortableNodeClick, true);
    host.addEventListener("pointerup", onCodeNodePointerUp, true);
    host.addEventListener("scroll", repositionNodeToolbar, { passive: true });
    window.addEventListener("resize", repositionNodeToolbar);
    window.addEventListener("pointerdown", closeNodeToolbarOutside, true);
    const openBlockMenuAt = (
      block: NonNullable<ReturnType<typeof blockAtViewportY>>,
      anchor: { right: number; top: number },
      selectedIndices: number[] = [block.index],
      listHierarchy?: BlockMenuState["listHierarchy"],
    ) => {
      if (!block || block.pageTitle || (newDocument && block.index === 0)) return false;
      const indices = [...new Set(selectedIndices)].filter((index) => index >= 0 && index < block.count).sort((a, b) => a - b);
      const liveTitleIndex = crepe.editor.action((ctx) => pageTitleIndex(ctx.get(editorViewCtx).state.doc));
      if (indices.length === 0 || indices.includes(liveTitleIndex ?? -1) || (newDocument && indices.includes(0))) return false;
      let collapsedSectionDestinations: { up: number | null; down: number | null } | null = null;
      let belowAnchor: BelowInsertAnchor<ProseNode> | null = null;
      let canImageSideBySide = false;
      try {
        collapsedSectionDestinations = crepe.editor.action((ctx) => {
          const state = ctx.get(editorViewCtx).state;
          canImageSideBySide = createImageSideBySideTransaction(state, indices) != null;
          const belowTargetIndices = expandCollapsedSectionBlockIndices(
            state.doc,
            indices,
            foldedHeadingPositions(state),
          );
          belowAnchor = createBelowInsertAnchor(state.doc, Math.max(...belowTargetIndices));
          if (!foldedHeadingPositions(state).includes(block.pos)) return null;
          return {
            up: collapsedSectionStepDestination(state.doc, indices, block.pos, "up"),
            down: collapsedSectionStepDestination(state.doc, indices, block.pos, "down"),
          };
        });
      } catch { /* 普通多块菜单继续使用既有相邻区块步进 */ }
      if (!belowAnchor) return false;
      const moveUpDestination = collapsedSectionDestinations
        ? collapsedSectionDestinations.up
        : blockGroupStepDestination(indices, block.count, newDocument, "up");
      const moveDownDestination = collapsedSectionDestinations
        ? collapsedSectionDestinations.down
        : blockGroupStepDestination(indices, block.count, newDocument, "down");
      hideSelectionToolbar();
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      setRichLinkDialog(null);
      setLinkDisplayPicker(null);
      setLinkToolbar(null);
      closeNodeToolbar();
      closeBlockMenu();
      setBlockMenuQuery("");
      block.target.classList.add("block-menu-target");
      if (blockStateStatus) applyBlockVisualState(block.target, "menu-target", blockStateStatus, lang, indices.length);
      const targetRect = block.target.getBoundingClientRect();
      const menuTargetOverlay = document.createElement("div");
      menuTargetOverlay.className = "editor-block-menu-target-overlay block-menu-target";
      menuTargetOverlay.style.left = `${Math.round(targetRect.left - 4)}px`;
      menuTargetOverlay.style.top = `${Math.round(targetRect.top - 2)}px`;
      menuTargetOverlay.style.width = `${Math.round(targetRect.width + 8)}px`;
      menuTargetOverlay.style.height = `${Math.round(targetRect.height + 4)}px`;
      menuTargetOverlay.setAttribute("role", "status");
      menuTargetOverlay.setAttribute("aria-label", lang === "en" ? "Block actions open" : "区块操作已打开");
      document.body.appendChild(menuTargetOverlay);
      if (blockStateStatus) applyBlockVisualState(menuTargetOverlay, "menu-target", blockStateStatus, lang, indices.length);
      setBlockMenu({
        pos: block.pos,
        indices,
        currentType: block.entry.id,
        target: block.target,
        canMoveUp: indices.length > 1 ? moveUpDestination != null : canMoveTopLevelBlock(block.index, block.count, newDocument, "up"),
        canMoveDown: indices.length > 1 ? moveDownDestination != null : canMoveTopLevelBlock(block.index, block.count, newDocument, "down"),
        canConvert: indices.length === 1 && block.canConvert,
        canImageSideBySide,
        overlay: menuTargetOverlay,
        belowAnchor,
        listHierarchy,
        left: Math.max(10, Math.min(window.innerWidth - 250, anchor.right + 7)),
        top: Math.max(10, Math.min(window.innerHeight - 430, anchor.top - 4)),
      });
      return true;
    };
    const openBlockMenuForOperation = (
      operation: HTMLElement,
      clientY: number,
      selectedIndices?: number[],
      explicitListHierarchy?: BlockMenuState["listHierarchy"],
    ) => {
      const block = blockAtViewportY(clientY);
      const rect = operation.getBoundingClientRect();
      const listItem = explicitListHierarchy ? null : listItemAtViewportY(clientY);
      const sourceIds = listItem && selectedListItems.has(listItem.id)
        ? listItem.snapshot.entries.filter(({ id }) => selectedListItems.has(id)).map(({ id }) => id)
        : (listItem ? [listItem.id] : []);
      const listHierarchy = explicitListHierarchy ?? (listItem && sourceIds.length > 0 ? {
        listPos: listItem.listPos,
        sourceIds,
        availability: resolveListHierarchyAvailability(listItem.snapshot, sourceIds),
      } : undefined);
      return block ? openBlockMenuAt(block, rect, selectedIndices, listHierarchy) : false;
    };
    const openBrowseInsertMenuForOperation = (operation: HTMLElement, clientY: number) => {
      const block = blockAtViewportY(clientY);
      if (!block || !canOpenBrowseInsertMenu({
        isTextblock: block.isTextblock,
        isParagraph: block.entry.id === "text",
        contentSize: block.contentSize,
        newDocument,
        blockIndex: block.index,
      })) return false;
      const rect = operation.getBoundingClientRect();
      const hostRect = host.getBoundingClientRect();
      const width = Math.min(420, Math.max(272, hostRect.width - 16));
      const layout = resolveSlashMenuLayout({
        viewportTop: Math.max(8, hostRect.top + 8),
        viewportBottom: Math.min(window.innerHeight - 8, hostRect.bottom - 8),
        anchorTop: rect.top,
        anchorBottom: rect.bottom,
        preferredMenuHeight: 520,
        fixedChromeHeight: 102,
        maxGroupHeight: 418,
      });
      hideSelectionToolbar();
      closeSlashInsertMenu();
      closeBlockMenu();
      setRichLinkDialog(null);
      setLinkDisplayPicker(null);
      setLinkToolbar(null);
      closeNodeToolbar();
      updateBrowseInsertMenu({
        pos: block.pos,
        left: Math.round(resolveInsertMenuLeft({
          viewportLeft: hostRect.left,
          viewportRight: hostRect.right,
          anchorLeft: rect.left,
          menuWidth: width,
        })),
        top: Math.round(layout.top),
        placement: layout.placement,
        activeIndex: 0,
        groupMaxHeight: layout.groupMaxHeight,
      });
      return true;
    };
    let browseAddPress: { pointerId: number; operation: HTMLElement } | null = null;
    let browseAddMousePress: HTMLElement | null = null;
    let browseAddOpenedAt = Number.NEGATIVE_INFINITY;
    const onBrowseAddPointerDown = (event: PointerEvent) => {
      const operation = getAddOperation(event.target);
      if (!operation || event.button !== 0) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      browseAddPress = { pointerId: event.pointerId, operation };
    };
    const onBrowseAddPointerUp = (event: PointerEvent) => {
      const press = browseAddPress;
      const operation = getAddOperation(event.target);
      if (!press || press.pointerId !== event.pointerId || !operation || operation !== press.operation) return;
      browseAddPress = null;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (openBrowseInsertMenuForOperation(operation, event.clientY)) browseAddOpenedAt = event.timeStamp;
    };
    const onBrowseAddPointerCancel = (event: PointerEvent) => {
      if (browseAddPress?.pointerId === event.pointerId) browseAddPress = null;
    };
    const onBrowseAddMouseDown = (event: MouseEvent) => {
      const operation = getAddOperation(event.target);
      if (!operation || event.button !== 0) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      browseAddMousePress = operation;
    };
    const onBrowseAddMouseUp = (event: MouseEvent) => {
      const press = browseAddMousePress;
      const operation = getAddOperation(event.target);
      if (!press || !operation || press !== operation || event.button !== 0) return;
      browseAddMousePress = null;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (isDuplicateBrowseAddCompatibilityClick(browseAddOpenedAt, event.timeStamp)) return;
      if (openBrowseInsertMenuForOperation(operation, event.clientY)) browseAddOpenedAt = event.timeStamp;
    };
    const onBrowseAddClick = (event: MouseEvent) => {
      const operation = getAddOperation(event.target);
      if (!operation || event.button !== 0) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (isDuplicateBrowseAddCompatibilityClick(browseAddOpenedAt, event.timeStamp)) return;
      if (openBrowseInsertMenuForOperation(operation, event.clientY)) browseAddOpenedAt = event.timeStamp;
    };
    const onBlockPointerDown = (event: PointerEvent) => {
      const operation = getDragOperation(event.target);
      if (!operation || event.button !== 0) return;
      // BlockProvider owns the floating handle and may move/recreate it as the real mouse
      // crosses into the document. Capture on the stable editor host and stop the provider's
      // own pointer handler, otherwise a slow physical drag can lose capture before 4px while
      // a synthetic one-shot drag happens to work.
      event.preventDefault();
      event.stopPropagation();
      const source = blockAtViewportY(event.clientY);
      // 已存在的顶层多块选择优先沿用原有整组移动语义；列表行层级拖动不能
      // 把其中的列表块悄悄降级成单个 list_item。
      const listSource = source && selectedBlocks.has(source.index)
        ? null
        : listItemAtViewportY(event.clientY);
      const listSourceIds = listSource && selectedListItems.has(listSource.id)
        ? listSource.snapshot.entries
          .filter(({ id }) => selectedListItems.has(id))
          .map(({ id }) => id)
        : (listSource ? [listSource.id] : []);
      const baseSourceIndices = !listSource && source && selectedBlocks.has(source.index)
        ? [...selectedBlocks.keys()].sort((a, b) => a - b)
        : (source ? [source.index] : []);
      const sourceIndices = listSource ? baseSourceIndices : expandCollapsedSectionIndices(baseSourceIndices);
      const targetsByIndex = new Map(topLevelBlockTargets().map(({ index, target }) => [index, target]));
      const listTargetsById = new Map(
        listSource?.snapshot.entries.map((entry) => {
          const selected = selectedListItems.get(entry.id)?.target;
          const target = selected ?? crepe.editor.action((ctx) => ctx.get(editorViewCtx).nodeDOM(entry.pos));
          return [entry.id, target instanceof HTMLElement ? target : null] as const;
        }) ?? [],
      );
      blockPress = {
        x: event.clientX,
        y: event.clientY,
        at: performance.now(),
        pointerId: event.pointerId,
        operation,
        source,
        listSource,
        listSourceIds,
        listRootX: listSource ? event.clientX - listSource.depth * 28 : event.clientX,
        listDropInput: null,
        sourceIndices,
        sourceTargets: listSource
          ? listSourceIds.map((id) => listTargetsById.get(id)).filter((target): target is HTMLElement => Boolean(target))
          : sourceIndices.map((index) => targetsByIndex.get(index)).filter((target): target is HTMLElement => Boolean(target)),
        destinationIndex: source?.index ?? -1,
        dropActive: false,
        dragging: false,
        dropLine: null,
        ghost: null,
        dropTarget: null,
      };
      try { host.setPointerCapture?.(event.pointerId); } catch { /* pointer already ended */ }
    };

    const stopBlockAutoScroll = () => {
      blockAutoScrollVelocity = 0;
      if (blockAutoScrollFrame != null) cancelAnimationFrame(blockAutoScrollFrame);
      blockAutoScrollFrame = null;
    };

    const clearBlockPointerDrag = (press: BlockPress | null) => {
      stopBlockAutoScroll();
      clearBlockDragVisuals({
        host,
        sourceTargets: press?.sourceTargets ?? [],
        dropTarget: press?.dropTarget ?? null,
        dropLine: press?.dropLine ?? null,
        ghost: press?.ghost ?? null,
        pointerId: press?.pointerId ?? null,
        status: blockStateStatus,
      });
    };

    const setBlockDropTarget = (press: BlockPress, target: HTMLElement | null) => {
      if (press.dropTarget === target) return;
      if (press.dropTarget) clearBlockVisualState(press.dropTarget, "drag-target", blockStateStatus ?? "omia-block-state-status");
      press.dropTarget = target;
      if (target && blockStateStatus) applyBlockVisualState(target, "drag-target", blockStateStatus, lang);
    };

    const moveBlocksToIndex = (sourceIndices: number[], destinationIndex: number) => {
      const sortedIndices = [...new Set(sourceIndices)].sort((a, b) => a - b);
      if (sortedIndices.length === 0) return;
      const selectionIsContiguous = sortedIndices.every((index, offset) => index === sortedIndices[0] + offset);
      if (selectionIsContiguous && sortedIndices[0] === destinationIndex) return;
      try {
        crepe.editor.action((ctx) => {
          const view = ctx.get(editorViewCtx);
          const blocks: Array<{ pos: number; nodeSize: number }> = [];
          view.state.doc.forEach((child, offset) => blocks.push({ pos: offset, nodeSize: child.nodeSize }));
          const sources = sortedIndices.map((index) => {
            const block = blocks[index];
            const node = block ? view.state.doc.nodeAt(block.pos) : null;
            return block && node ? { ...block, node } : null;
          });
          if (sources.some((source) => !source)
            || sortedIndices.includes(pageTitleIndex(view.state.doc) ?? -1)
            || (newDocument && sortedIndices.includes(0))) return;
          const validSources = sources.filter((source): source is NonNullable<typeof source> => Boolean(source));
          const previousFolded = foldedHeadingPositions(view.state);
          let tr = view.state.tr;
          [...validSources].reverse().forEach((source) => {
            tr = tr.delete(source.pos, source.pos + source.nodeSize);
          });
          let insertAt = tr.doc.content.size;
          tr.doc.forEach((_child, offset, index) => {
            if (index === destinationIndex) insertAt = offset;
          });
          tr = tr.insert(insertAt, validSources.map(({ node }) => node.copy(node.content)));
          tr = replaceFoldedHeadingPositions(
            tr,
            foldedHeadingPositionsAfterBlockMove(tr, validSources, insertAt, previousFolded),
          );
          view.dispatch(tr.setSelection(Selection.near(tr.doc.resolve(Math.min(insertAt + 1, tr.doc.content.size)))).scrollIntoView());
          view.focus();
        });
        clearSelectedBlocks();
      } catch {
        showNotice("error", en ? "Couldn't move this block" : "区块移动没有完成", 2600);
      }
    };

    const duplicateBlocks = (sourceIndices: number[]) => {
      const sortedIndices = [...new Set(sourceIndices)].sort((a, b) => a - b);
      if (sortedIndices.length === 0) return false;
      try {
        const duplicated = crepe.editor.action((ctx) => {
          const view = ctx.get(editorViewCtx);
          if (sortedIndices.includes(pageTitleIndex(view.state.doc) ?? -1)
            || (newDocument && sortedIndices.includes(0))) return false;
          const blocks: Array<{ pos: number; nodeSize: number; node: NonNullable<typeof view.state.doc.firstChild> }> = [];
          view.state.doc.forEach((node, pos) => blocks.push({ pos, nodeSize: node.nodeSize, node }));
          const sources = sortedIndices.map((index) => blocks[index]).filter((source): source is NonNullable<typeof source> => Boolean(source));
          if (sources.length !== sortedIndices.length) return false;
          const last = sources[sources.length - 1];
          if (!last) return false;
          const insertAt = last.pos + last.nodeSize;
          const tr = view.state.tr.insert(insertAt, sources.map(({ node }) => node.copy(node.content)));
          view.dispatch(
            tr.setSelection(Selection.near(tr.doc.resolve(Math.min(insertAt + 1, tr.doc.content.size))))
              .scrollIntoView(),
          );
          view.focus();
          return true;
        });
        if (duplicated) clearSelectedBlocks();
        return duplicated;
      } catch {
        showNotice("error", en ? "Couldn't duplicate this block" : "区块副本没有创建成功", 2600);
        return false;
      }
    };

    const onBlockKeyboardShortcut = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || (event.target as HTMLElement | null)?.closest(".cm-editor")) return;
      let selectionCollapsed = false;
      try {
        selectionCollapsed = crepe.editor.action((ctx) => ctx.get(editorViewCtx).state.selection.empty);
      } catch { return; }
      const action = resolveBlockKeyboardAction({
        key: event.key,
        commandModifier: event.metaKey || event.ctrlKey,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
        isComposing: event.isComposing,
        selectionCollapsed,
      });
      if (!action) return;
      const selected = selectedBlockIndices();
      const current = selected.length > 0 ? blockAtIndex(selected[0]) : blockAtSelection();
      if (!current || current.pageTitle || (newDocument && current.index === 0)) return;
      const baseIndices = selected.length > 0 ? selected : [current.index];
      const indices = expandCollapsedSectionIndices(baseIndices);

      let handled = false;
      if (action === "duplicate") {
        handled = duplicateBlocks(indices);
      } else {
        const direction = action === "move-up" ? "up" : "down";
        let destination: number | null = null;
        try {
          destination = crepe.editor.action((ctx) => {
            const state = ctx.get(editorViewCtx).state;
            return baseIndices.length === 1 && foldedHeadingPositions(state).includes(current.pos)
              ? collapsedSectionStepDestination(state.doc, indices, current.pos, direction)
              : blockGroupStepDestination(indices, current.count, newDocument, direction);
          });
        } catch { /* 无可用事务时保留未处理状态 */ }
        if (destination != null) {
          moveBlocksToIndex(indices, destination);
          handled = true;
        }
      }
      if (!handled) return;
      event.preventDefault();
      event.stopPropagation();
      showNotice(
        "success",
        action === "duplicate"
          ? (en ? `${indices.length} ${indices.length === 1 ? "block" : "blocks"} duplicated` : `已创建 ${indices.length} 个区块副本`)
          : (action === "move-up"
            ? (en ? "Block moved up" : "区块已上移")
            : (en ? "Block moved down" : "区块已下移")),
      );
    };

    const updateBlockDropTarget = (press: BlockPress, clientX: number, clientY: number) => {
      if (!press.source || !press.dropLine) return false;
      const hostRect = host.getBoundingClientRect();
      if (!isBlockDropPointUsable(clientX, clientY, hostRect)) {
        setBlockDropTarget(press, null);
        press.destinationIndex = press.source.index;
        press.dropActive = false;
        press.dropLine.hidden = true;
        return false;
      }
      const safeY = Math.max(hostRect.top + 2, Math.min(hostRect.bottom - 2, clientY));
      if (press.listSource) {
        const target = listItemAtViewportY(safeY);
        if (!target || target.listPos !== press.listSource.listPos) {
          setBlockDropTarget(press, null);
          press.listDropInput = null;
          press.dropActive = false;
          press.dropLine.hidden = true;
          return false;
        }
        const rect = listItemRowRect(target.target);
        const dropAfter = safeY >= rect.top + rect.height / 2;
        const input: ListDragTransactionInput = {
          listPos: press.listSource.listPos,
          sourceIds: press.listSourceIds,
          targetId: target.id,
          dropAfter,
          pointerX: clientX,
          rootLeft: press.listRootX,
          indentWidth: 28,
        };
        const plan = resolveListDragDrop({ items: target.snapshot.entries, ...input });
        if (!plan.ok) {
          setBlockDropTarget(press, null);
          press.listDropInput = null;
          press.dropActive = false;
          press.dropLine.hidden = true;
          return false;
        }
        setBlockDropTarget(press, target.target);
        press.listDropInput = input;
        press.dropActive = true;
        press.dropLine.hidden = false;
        press.dropLine.classList.add("is-list-depth");
        const cueLabel = en
          ? (plan.cue === "nested" ? "nested" : plan.cue === "same-level" ? "same level" : "lifted")
          : (plan.cue === "nested" ? "成为子项" : plan.cue === "same-level" ? "同级" : "提升层级");
        press.dropLine.dataset.depthLabel = en
          ? `Level ${plan.depth + 1} · ${cueLabel}`
          : `层级 ${plan.depth + 1} · ${cueLabel}`;
        const lineY = dropAfter ? rect.bottom : rect.top;
        const lineLeft = Math.max(hostRect.left + 8, rect.left + (plan.depth - target.depth) * 28);
        press.dropLine.style.left = `${Math.round(lineLeft)}px`;
        press.dropLine.style.top = `${Math.round(lineY - 1)}px`;
        press.dropLine.style.width = `${Math.max(36, Math.round(rect.right - lineLeft))}px`;
        return true;
      }
      const target = blockAtViewportY(safeY);
      if (!target) {
        setBlockDropTarget(press, null);
        press.destinationIndex = press.source.index;
        press.dropActive = false;
        press.dropLine.hidden = true;
        return false;
      }
      const rect = target.target.getBoundingClientRect();
      setBlockDropTarget(press, target.target);
      const dropAfter = safeY >= rect.top + rect.height / 2;
      press.destinationIndex = resolveBlockGroupDropIndex(
        press.sourceIndices,
        target.index,
        dropAfter,
        target.count,
        newDocument,
      );
      const lineY = dropAfter ? rect.bottom : rect.top;
      press.dropActive = true;
      press.dropLine.hidden = false;
      press.dropLine.style.left = `${Math.round(rect.left)}px`;
      press.dropLine.style.top = `${Math.round(lineY - 1)}px`;
      press.dropLine.style.width = `${Math.round(rect.width)}px`;
      return true;
    };

    const positionBlockGhost = (press: BlockPress, clientX: number, clientY: number) => {
      if (!press.ghost) return;
      const width = press.ghost.offsetWidth || 260;
      const height = press.ghost.offsetHeight || 96;
      const left = Math.max(12, Math.min(window.innerWidth - width - 12, clientX + 18));
      const top = Math.max(10, Math.min(window.innerHeight - height - 10, clientY - 19));
      press.ghost.style.transform = `translate3d(${Math.round(left)}px, ${Math.round(top)}px, 0)`;
    };

    const ensureBlockAutoScroll = () => {
      if (blockAutoScrollFrame != null || blockAutoScrollVelocity === 0) return;
      const step = () => {
        blockAutoScrollFrame = null;
        const press = blockPress;
        if (!press?.dragging || blockAutoScrollVelocity === 0) return;
        const before = host.scrollTop;
        host.scrollTop += blockAutoScrollVelocity;
        const active = updateBlockDropTarget(press, blockPointerViewportX, blockPointerViewportY);
        press.ghost?.classList.toggle("is-outside", !active);
        if (!active) {
          blockAutoScrollVelocity = 0;
          return;
        }
        if (host.scrollTop === before) {
          blockAutoScrollVelocity = 0;
          return;
        }
        blockAutoScrollFrame = requestAnimationFrame(step);
      };
      blockAutoScrollFrame = requestAnimationFrame(step);
    };

    const updateBlockAutoScroll = (clientY: number) => {
      const rect = host.getBoundingClientRect();
      blockPointerViewportY = clientY;
      blockAutoScrollVelocity = blockDragAutoScrollVelocity(clientY, rect.top, rect.bottom);
      if (blockAutoScrollVelocity === 0) stopBlockAutoScroll();
      else ensureBlockAutoScroll();
    };

    const onBlockPointerMove = (event: PointerEvent) => {
      const press = blockPress;
      if (!press || event.pointerId !== press.pointerId) return;
      if (!press.dragging && Math.hypot(event.clientX - press.x, event.clientY - press.y) <= 4) return;
      if (!press.source || press.source.pageTitle || (newDocument && press.source.index === 0)) {
        clearBlockPointerDrag(press);
        blockPress = null;
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      if (!press.dragging) {
        press.dragging = true;
        closeBlockMenu();
        press.sourceTargets.forEach((target) => {
          if (blockStateStatus) {
            applyBlockVisualState(
              target,
              "drag-source",
              blockStateStatus,
              lang,
              press.listSourceIds.length || press.sourceIndices.length,
            );
          }
        });
        host.classList.add("is-block-pointer-dragging");
        press.dropLine = document.createElement("div");
        press.dropLine.className = "editor-block-drop-line";
        press.dropLine.setAttribute("aria-hidden", "true");
        document.body.appendChild(press.dropLine);

        const sourceTargets = press.sourceTargets.length > 0 ? press.sourceTargets : [press.source.target];
        press.ghost = createBlockDragGhost({
          sourceTargets,
          sourceWidth: press.source.target.getBoundingClientRect().width,
          viewportWidth: window.innerWidth,
          lang,
        });
        document.body.appendChild(press.ghost);
      }

      positionBlockGhost(press, event.clientX, event.clientY);
      blockPointerViewportX = event.clientX;
      const active = updateBlockDropTarget(press, event.clientX, event.clientY);
      press.ghost?.classList.toggle("is-outside", !active);
      if (active) updateBlockAutoScroll(event.clientY);
      else stopBlockAutoScroll();
    };

    const onBlockPointerUp = (event: PointerEvent) => {
      const press = blockPress;
      blockPress = null;
      if (!press || event.pointerId !== press.pointerId) return;
      if (press.dragging) {
        event.preventDefault();
        event.stopPropagation();
        clearBlockPointerDrag(press);
        if (press.listSource && press.listDropInput && press.dropActive) {
          try {
            const applied = crepe.editor.action((ctx) => {
              const view = ctx.get(editorViewCtx);
              const transaction = createListDragTransaction(view.state, press.listDropInput!);
              if (!transaction) return false;
              view.dispatch(transaction.scrollIntoView());
              view.focus();
              return true;
            });
            if (!applied) showNotice("error", en ? "Couldn't change this list level" : "列表层级没有改变", 2600);
            else clearSelectedBlocks();
          } catch {
            showNotice("error", en ? "Couldn't change this list level" : "列表层级没有改变", 2600);
          }
        } else if (press.source && press.dropActive) {
          moveBlocksToIndex(press.sourceIndices, press.destinationIndex);
        }
        return;
      }
      clearBlockPointerDrag(press);
      if (!isBlockHandleTap(press, { x: event.clientX, y: event.clientY, at: performance.now() })) return;
      const block = blockAtViewportY(event.clientY);
      if (!block || block.pageTitle || (newDocument && block.index === 0)) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey) {
        event.preventDefault();
        event.stopPropagation();
        const listItem = listItemAtViewportY(event.clientY);
        if (listItem) updateListSelection(listItem, event);
        else updateBlockSelection(block, event);
        return;
      }
      const opensOperationGroup = press.source != null && (press.sourceIndices.length > 1 || press.listSourceIds.length > 1);
      if (!opensOperationGroup) clearSelectedBlocks();
      const listHierarchy = press.listSource && press.listSourceIds.length > 0 ? {
        listPos: press.listSource.listPos,
        sourceIds: press.listSourceIds,
        availability: resolveListHierarchyAvailability(press.listSource.snapshot, press.listSourceIds),
      } : undefined;
      if (!openBlockMenuForOperation(
        press.operation,
        event.clientY,
        opensOperationGroup ? press.sourceIndices : undefined,
        listHierarchy,
      )) return;
      event.preventDefault();
      event.stopPropagation();
    };
    const onBlockPointerCancel = (event: PointerEvent) => {
      if (!blockPress || event.pointerId !== blockPress.pointerId) return;
      const press = blockPress;
      blockPress = null;
      clearBlockPointerDrag(press);
    };
    const onBlockDragKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !blockPress?.dragging) return;
      event.preventDefault();
      event.stopPropagation();
      const press = blockPress;
      blockPress = null;
      clearBlockPointerDrag(press);
    };
    const onBlockHandleKeyDown = (event: KeyboardEvent) => {
      const shortcut = resolveBlockMenuShortcut({
        key: event.key,
        code: event.code,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        shiftKey: event.shiftKey,
        composing: event.isComposing || imeComposing,
        blockedSurface: Boolean((event.target as HTMLElement | null)?.closest(".cm-editor")),
      });
      if (shortcut) {
        const groupIndices = selectedBlocks.size > 1 ? selectedBlockIndices() : undefined;
        const block = groupIndices ? blockAtIndex(groupIndices[0]) : blockAtSelection();
        if (!block || block.pageTitle || (newDocument && block.index === 0)) return;
        const operationIndices = expandCollapsedSectionIndices(groupIndices ?? [block.index]);
        event.preventDefault();
        event.stopPropagation();
        const rect = block.target.getBoundingClientRect();
        openBlockMenuAt(block, { right: Math.max(10, rect.left - 8), top: rect.top }, operationIndices);
        return;
      }
      const addOperation = getAddOperation(event.target);
      if (addOperation && !event.repeat && (event.key === "Enter" || event.key === " ")) {
        event.preventDefault();
        event.stopPropagation();
        const rect = addOperation.getBoundingClientRect();
        openBrowseInsertMenuForOperation(addOperation, rect.top + rect.height / 2);
        return;
      }
      const operation = getDragOperation(event.target);
      if (!operation || event.repeat || (event.key !== "Enter" && event.key !== " ")) return;
      event.preventDefault();
      event.stopPropagation();
      const rect = operation.getBoundingClientRect();
      openBlockMenuForOperation(operation, rect.top + rect.height / 2);
    };
    const onBlockLostPointerCapture = (event: PointerEvent) => {
      if (!blockPress || event.pointerId !== blockPress.pointerId) return;
      const press = blockPress;
      blockPress = null;
      clearBlockPointerDrag(press);
    };
    const onBlockWindowBlur = () => {
      if (!blockPress) return;
      const press = blockPress;
      blockPress = null;
      clearBlockPointerDrag(press);
    };
    const onBlockDragStart = (event: DragEvent) => {
      if (!getDragOperation(event.target)) return;
      // 防御性兜底：BlockProvider 将来若重新写回 draggable，也不允许它抢占系统文件拖入通道。
      event.preventDefault();
      closeBlockMenu();
    };
    const onRevealFoldedSectionsForFind = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.shiftKey || event.key.toLocaleLowerCase() !== "f") return;
      if (!(event.metaKey || event.ctrlKey)) return;
      crepe.editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const transaction = createUnfoldAllSectionsTransaction(view.state);
        if (!transaction) return;
        view.dispatch(transaction);
        setFoldedSections(foldedHeadingPositions(view.state));
      });
    };
    const onFoldAwareCopy = (event: ClipboardEvent) => {
      if (event.defaultPrevented || !event.clipboardData) return;
      let completeMarkdown = "";
      crepe.editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        if (!shouldCopyWholeFoldedDocument({
          from: view.state.selection.from,
          to: view.state.selection.to,
          documentSize: view.state.doc.content.size,
          foldedCount: foldedHeadingPositions(view.state).length,
        })) return;
        try {
          completeMarkdown = serializePortableImageMarkdown(ctx.get(serializerCtx)(view.state.doc).replace(
            /^(\s*>\s*)\\(\[!(?:note|tip|important|warning|caution)\])/gim,
            "$1$2",
          ));
        } catch {
          completeMarkdown = "";
        }
      });
      if (!completeMarkdown) return;
      event.clipboardData.setData("text/plain", completeMarkdown);
      event.preventDefault();
    };
    const closeBlockMenuOnViewportChange = () => {
      closeBlockMenu();
      closeNodeToolbar();
      updateBrowseInsertMenu(null);
      positionSelectedBlockOverlays();
    };
    host.ownerDocument.addEventListener("pointerdown", onBrowseAddPointerDown, true);
    host.ownerDocument.addEventListener("pointerup", onBrowseAddPointerUp, true);
    host.ownerDocument.addEventListener("pointercancel", onBrowseAddPointerCancel, true);
    host.ownerDocument.addEventListener("mousedown", onBrowseAddMouseDown, true);
    host.ownerDocument.addEventListener("mouseup", onBrowseAddMouseUp, true);
    host.ownerDocument.addEventListener("click", onBrowseAddClick, true);
    host.addEventListener("pointerdown", onBlockPointerDown, true);
    host.addEventListener("pointermove", onBlockPointerMove, true);
    host.addEventListener("pointerup", onBlockPointerUp, true);
    host.addEventListener("pointercancel", onBlockPointerCancel, true);
    host.addEventListener("lostpointercapture", onBlockLostPointerCapture, true);
    host.addEventListener("dragstart", onBlockDragStart, true);
    host.addEventListener("keydown", onBlockHandleKeyDown, true);
    host.addEventListener("keydown", onSelectedBlocksKeyDown, true);
    host.addEventListener("keydown", onSelectAllKeyDown, true);
    host.addEventListener("keydown", onBlockKeyboardShortcut, true);
    host.addEventListener("keydown", onRevealFoldedSectionsForFind, true);
    host.addEventListener("keydown", onNewDocumentBoundaryKeyDown, true);
    host.addEventListener("cut", onNewDocumentCut, true);
    host.addEventListener("copy", onFoldAwareCopy, true);
    host.addEventListener("paste", onExternalHtmlPasteNotice, true);
    host.addEventListener("paste", onUrlPaste, true);
    host.addEventListener("scroll", closeBlockMenuOnViewportChange, { passive: true });
    window.addEventListener("resize", closeBlockMenuOnViewportChange);
    window.addEventListener("keydown", onBlockDragKeyDown, true);
    window.addEventListener("blur", onBlockWindowBlur);
    // 挂上 callout 装饰插件（必须在 create() 之前 use）
    crepe.editor.use(calloutDecorations);
    crepe.editor.use(richLinkDecorations);
    crepe.editor.use(sectionFoldPlugin);
    crepe.editor.use(advancedTablePlugins);
    crepe.editor.use(persistentLayoutPlugins);
    crepe.editor.use(controlledInlinePlugins);
    crepe.editor.use(controlledBlockPlugins);
    crepe.editor.use(advancedClipboardPlugin);
    crepe.editor.use(safeClipboardImportPlugin);
    crepe.editor.use(pageTitlePlugin);
    let outlineSyncFrame: number | undefined;
    let pendingOutlineDocument: ProseNode | null = null;
    const scheduleHeadingOutlineSync = (document: ProseNode) => {
      pendingOutlineDocument = document;
      if (outlineSyncFrame != null) return;
      outlineSyncFrame = requestAnimationFrame(() => {
        outlineSyncFrame = undefined;
        const currentDocument = pendingOutlineDocument;
        pendingOutlineDocument = null;
        if (!currentDocument) return;
        const next = deriveHeadingOutline(currentDocument, lang, { excludePageTitle: true });
        setHeadingOutline((current) => sameHeadingOutline(current, next) ? current : next);
      });
    };
    crepe.on((listener) => {
      listener.markdownUpdated((ctx, markdown) => {
        // Crepe 序列化会把 callout 标记 [!NOTE] 转义成 \[!NOTE]，存盘前还原成标准 GFM：
        // 既保证阅读视图能识别、又保证 .md 可移植（GitHub/Obsidian 等也认）。
        const cleaned = serializeEditorMarkdown(markdown);
        const previousSerializedDocument = serializedDocumentRef.current;
        const documentChanged = previousSerializedDocument != null && previousSerializedDocument !== cleaned;
        serializedDocumentRef.current = cleaned;
        // WKWebView 会在纯焦点切换时重复发出内容相同的 markdownUpdated。
        // 只有文档真的变化才让 target token 失效；否则节点工具栏的下一次操作会被误判为 stale。
        if (documentChanged) {
          documentRevisionRef.current += 1;
          closeNodeToolbar();
        }
        const pendingExactMarkdown = pendingExactMarkdownRef.current;
        pendingExactMarkdownRef.current = null;
        const guardedChange = pendingExactMarkdown == null
          ? initialChangeGuard.next(cleaned)
          : initialChangeGuard.registerExact(cleaned, pendingExactMarkdown);
        exactMarkdownRef.current = guardedChange.markdown;
        if (guardedChange.publish) onSourceRewriteRef.current?.(initialChangeGuard.rewriteInfo());
        const nextStructure = inspectNewDocument(guardedChange.markdown);
        host.classList.toggle("is-pristine", newDocument && nextStructure.titleEmpty && nextStructure.bodyEmpty);
        host.classList.toggle("is-title-empty", newDocument && nextStructure.titleEmpty);
        host.classList.toggle("is-body-empty", newDocument && nextStructure.bodyEmpty);
        if (cleaned !== markdownAtLastBlockSelectionUpdate) clearSelectedBlocks();
        markdownAtLastBlockSelectionUpdate = cleaned;
        closeBlockMenu();
        updateBrowseInsertMenu(null);
        if (guardedChange.publish) onChangeRef.current(guardedChange.markdown);
        scheduleSlashInsertMenuSync();
        const view = ctx.get(editorViewCtx);
        scheduleHeadingOutlineSync(view.state.doc);
        setFoldedSections(foldedHeadingPositions(view.state));
      });
    });
    let destroyed = false;
    let handleDecorationFrame: number | undefined;
    let addHandleVisibilityFrame: number | undefined;
    const handleNames = en ? ["Add block", "Block actions and drag"] : ["添加区块", "区块操作与拖动"];
    const multiSelectHint = en
      ? `Drag to reorder · ${blockMenuShortcutHint(/Mac|iPhone|iPad/.test(navigator.platform) ? "mac" : "windows", "en")} · Cmd/Ctrl-click to select multiple`
      : `拖动调整顺序 · ${blockMenuShortcutHint(/Mac|iPhone|iPad/.test(navigator.platform) ? "mac" : "windows", "zh")} · ⌘/Ctrl 点按多选`;
    const refreshAddHandleVisibility = () => {
      addHandleVisibilityFrame = undefined;
      const operation = host.querySelector<HTMLElement>(".milkdown-block-handle .operation-item:first-child");
      if (!operation) return;
      // `+` 在非空块会 display:none，自身矩形归零；始终用同一胶囊里可见的六点定位，
      // 才能在手柄随后移动到空块时重新判定并出现。
      const stableHandle = operation.parentElement?.children[1] instanceof HTMLElement
        ? operation.parentElement.children[1]
        : operation.parentElement;
      const rect = stableHandle?.getBoundingClientRect();
      const block = rect && rect.height > 0 ? blockAtViewportY(rect.top + rect.height / 2) : null;
      const blockHandle = operation.closest<HTMLElement>(".milkdown-block-handle");
      if (blockHandle && block) {
        blockHandle.hidden = block.pageTitle;
        decorateBlockHandleEntry(blockHandle, block.entry, {
          addLabel: handleNames[0],
          actionLabel: handleNames[1],
          hint: multiSelectHint,
        });
      }
      const allowed = Boolean(block && !block.pageTitle && canOpenBrowseInsertMenu({
        isTextblock: block.isTextblock,
        isParagraph: block.entry.id === "text",
        contentSize: block.contentSize,
        newDocument,
        blockIndex: block.index,
      }));
      operation.hidden = !allowed;
      operation.setAttribute("aria-hidden", allowed ? "false" : "true");
      operation.setAttribute("tabindex", allowed ? "0" : "-1");
    };
    const scheduleAddHandleVisibility = () => {
      if (addHandleVisibilityFrame != null) return;
      addHandleVisibilityFrame = requestAnimationFrame(refreshAddHandleVisibility);
    };
    host.addEventListener("pointermove", scheduleAddHandleVisibility, true);
    host.ownerDocument.addEventListener("selectionchange", scheduleAddHandleVisibility);
    void crepe.create().then(() => {
      if (destroyed) return;
      const view = crepe.editor.action((ctx) => ctx.get(editorViewCtx));
      selectionToolbarEditorView = view;
      const readyMarkdown = crepe.editor.action((ctx) => serializeEditorMarkdown(
        ctx.get(serializerCtx)(ctx.get(editorViewCtx).state.doc),
      ));
      const queuedChange = initialChangeGuard.markReady(readyMarkdown);
      exactMarkdownRef.current = queuedChange.markdown;
      if (queuedChange.publish) onChangeRef.current(queuedChange.markdown);
      requestAnimationFrame(() => { if (!destroyed) onReadyRef.current?.(); });
      selectionToolbarShell = installSelectionToolbarShell(host, {
        lang,
        getTypeModel: () => {
          const samples = selectionBlockSamplesForState(view.state, newDocument);
          return resolveSelectionBlockType(samples, lang);
        },
        getFormatState: () => controlledInlineSelectionState(view.state),
        getAlignmentState: () => controlledBlockAlignmentState(view.state),
        onConvert: (target) => {
          const samples = selectionBlockSamplesForState(view.state, newDocument);
          const model = resolveSelectionBlockType(samples, lang);
          if (!model.canConvert) return false;
          const indexes = [...new Set(samples.map(({ topLevelIndex }) => topLevelIndex))];
          const transaction = createSelectionBlockConversionTransaction(view.state, indexes, target);
          if (!transaction) return false;
          view.dispatch(transaction);
          selectionToolbarShell?.refresh();
          view.focus();
          return true;
        },
        onFormat: (action) => {
          if (view.state.selection.empty && selectionToolbarStoredSelection
            && host.querySelector(".milkdown-toolbar")?.contains(host.ownerDocument.activeElement)
            && selectionToolbarStoredSelection.to <= view.state.doc.content.size) {
            view.dispatch(view.state.tr.setSelection(TextSelection.create(
              view.state.doc,
              selectionToolbarStoredSelection.from,
              selectionToolbarStoredSelection.to,
            )));
          }
          const preservedSelection = {
            from: view.state.selection.from,
            to: view.state.selection.to,
          };
          const transaction = createControlledInlineTransaction(view.state, action, { composing: imeComposing });
          if (!transaction) return false;
          view.dispatch(transaction);
          selectionToolbarStoredSelection = preservedSelection;
          selectionToolbarShell?.refresh();
          if (action.id === "text-color" || action.id === "background-color") return true;
          view.focus();
          // 色板项会在 click 的默认焦点阶段暂时拥有焦点；待该事件完整结束后再把
          // ProseMirror 选区和浮层恢复，用户才能像飞书一样连续叠加文字色/背景色。
          requestAnimationFrame(() => {
            if (destroyed) return;
            requestAnimationFrame(() => {
              if (destroyed) return;
              if (preservedSelection.from < preservedSelection.to
                && preservedSelection.to <= view.state.doc.content.size) {
                view.dispatch(view.state.tr.setSelection(TextSelection.create(
                  view.state.doc,
                  preservedSelection.from,
                  preservedSelection.to,
                )));
              }
              view.focus();
              selectionToolbar.keyboardSelection();
              selectionToolbarShell?.refresh();
            });
          });
          return true;
        },
        onAlign: (action) => {
          if (view.state.selection.empty && selectionToolbarStoredSelection
            && host.querySelector(".milkdown-toolbar")?.contains(host.ownerDocument.activeElement)
            && selectionToolbarStoredSelection.to <= view.state.doc.content.size) {
            view.dispatch(view.state.tr.setSelection(TextSelection.create(
              view.state.doc,
              selectionToolbarStoredSelection.from,
              selectionToolbarStoredSelection.to,
            )));
          }
          const preservedSelection = { from: view.state.selection.from, to: view.state.selection.to };
          const transaction = createControlledBlockAlignmentTransaction(view.state, action, { composing: imeComposing });
          if (!transaction) return false;
          view.dispatch(transaction);
          selectionToolbarStoredSelection = preservedSelection;
          selectionToolbarShell?.refresh();
          view.focus();
          return true;
        },
        onLink: (rawHref) => {
          if (view.state.selection.empty && selectionToolbarStoredSelection
            && selectionToolbarStoredSelection.to <= view.state.doc.content.size) {
            view.dispatch(view.state.tr.setSelection(TextSelection.create(
              view.state.doc,
              selectionToolbarStoredSelection.from,
              selectionToolbarStoredSelection.to,
            )));
          }
          const href = safeNavigableHref(rawHref);
          if (!href || view.state.selection.empty) return false;
          const inserted = insertUrlPaste(view.state, href);
          if (!inserted) return false;
          view.dispatch(inserted.transaction.scrollIntoView());
          selectionToolbarStoredSelection = { from: inserted.from, to: inserted.to };
          selectionToolbarShell?.refresh();
          view.focus();
          return true;
        },
        onMenuOpen: () => {
          if (!view.state.selection.empty) {
            selectionToolbarStoredSelection = {
              from: view.state.selection.from,
              to: view.state.selection.to,
            };
          }
          closeBlockMenu();
          closeNodeToolbar();
          setLinkToolbar(null);
          updateSlashInsertMenu(null);
          updateBrowseInsertMenu(null);
        },
      });
      decorateSelectionToolbarAccessibility(host, lang);
      view.dom.setAttribute("aria-label", en ? "Document editor" : "文档编辑器");
      view.dom.setAttribute(
        "aria-keyshortcuts",
        "Alt+Shift+M Control+/ Meta+/ Control+A Meta+A Control+C Meta+C Control+D Meta+D Control+Shift+ArrowUp Meta+Shift+ArrowUp Control+Shift+ArrowDown Meta+Shift+ArrowDown Delete Backspace Escape",
      );
      scheduleHeadingOutlineSync(view.state.doc);
      setFoldedSections(foldedHeadingPositions(view.state));
      scheduleSlashInsertMenuSync();
      // BlockProvider 在 create() resolve 后的下一帧才把手柄 append 进 root。
      handleDecorationFrame = requestAnimationFrame(() => {
        scheduleAddHandleVisibility();
      });
      if (autoFocus) requestAnimationFrame(() => view.focus());
    }).catch((error) => {
      if (!destroyed) onReadyErrorRef.current?.(String(error));
    });
    return () => {
      destroyed = true;
      selectionToolbarEditorView = null;
      clearSelectionToolbarFallback();
      selectionToolbarShell?.dispose();
      selectionToolbar.dispose();
      host.classList.remove("selection-toolbar-pointer-selecting", "selection-toolbar-has-text");
      host.ownerDocument.removeEventListener("selectionchange", onSelectionChange);
      host.ownerDocument.removeEventListener("pointerup", onPointerUp, true);
      host.ownerDocument.removeEventListener("pointercancel", onPointerCancel, true);
      host.removeEventListener("mousedown", onMouseDownFallback, true);
      host.ownerDocument.removeEventListener("mouseup", onMouseUpFallback, true);
      host.removeEventListener("keyup", onKeyUp);
      host.ownerDocument.removeEventListener("keydown", onSelectionEscape, true);
      host.removeEventListener("pointerdown", onPointerDown, true);
      host.ownerDocument.removeEventListener("pointerdown", closeSelectionToolbarOutside, true);
      window.removeEventListener("keydown", onSlashMenuKeyDown, true);
      host.removeEventListener("compositionstart", onSlashMenuCompositionStart, true);
      host.removeEventListener("beforeinput", onEditorBeforeInput, true);
      host.removeEventListener("compositionend", onEditorCompositionEnd, true);
      host.removeEventListener("input", scheduleSlashInsertMenuSync, true);
      host.removeEventListener("keyup", scheduleSlashInsertMenuSync, true);
      host.ownerDocument.removeEventListener("selectionchange", scheduleSlashInsertMenuSync);
      host.removeEventListener("scroll", scheduleSlashInsertMenuSync);
      window.removeEventListener("resize", scheduleSlashInsertMenuSync);
      window.removeEventListener("pointerdown", closeSlashAssistanceOutside, true);
      if (slashMenuSyncFrame != null) cancelAnimationFrame(slashMenuSyncFrame);
      closeSlashInsertMenu();
      host.removeEventListener("pointerdown", onBlockPointerDown, true);
      host.removeEventListener("pointermove", onBlockPointerMove, true);
      host.removeEventListener("pointerup", onBlockPointerUp, true);
      host.removeEventListener("pointercancel", onBlockPointerCancel, true);
      host.ownerDocument.removeEventListener("pointerdown", onBrowseAddPointerDown, true);
      host.ownerDocument.removeEventListener("pointerup", onBrowseAddPointerUp, true);
      host.ownerDocument.removeEventListener("pointercancel", onBrowseAddPointerCancel, true);
      host.ownerDocument.removeEventListener("mousedown", onBrowseAddMouseDown, true);
      host.ownerDocument.removeEventListener("mouseup", onBrowseAddMouseUp, true);
      host.ownerDocument.removeEventListener("click", onBrowseAddClick, true);
      host.removeEventListener("lostpointercapture", onBlockLostPointerCapture, true);
      host.removeEventListener("dragstart", onBlockDragStart, true);
      host.removeEventListener("dragover", onExternalImageDragOver, true);
      host.removeEventListener("dragleave", onExternalImageDragLeave, true);
      host.removeEventListener("drop", onExternalImageDrop, true);
      host.classList.remove("is-external-image-drag");
      window.removeEventListener(EDITOR_IMAGE_DROP_EVENT, onNativeEditorImageDrop);
      host.removeEventListener("keydown", onBlockHandleKeyDown, true);
      host.removeEventListener("keydown", onSelectedBlocksKeyDown, true);
      host.removeEventListener("keydown", onSelectAllKeyDown, true);
      host.removeEventListener("keydown", onBlockKeyboardShortcut, true);
      host.removeEventListener("keydown", onRevealFoldedSectionsForFind, true);
      host.removeEventListener("keydown", onNewDocumentBoundaryKeyDown, true);
      host.removeEventListener("cut", onNewDocumentCut, true);
      host.removeEventListener("copy", onFoldAwareCopy, true);
      host.removeEventListener("paste", onExternalHtmlPasteNotice, true);
      host.removeEventListener("paste", onUrlPaste, true);
      host.removeEventListener("mouseover", onLinkMouseOver, true);
      host.removeEventListener("mouseout", onLinkMouseOut, true);
      host.removeEventListener("focusin", onLinkFocusIn, true);
      window.removeEventListener("pointerdown", closeLinkToolbarOutside, true);
      host.removeEventListener("click", onPortableNodeClick, true);
      host.removeEventListener("pointerdown", onAdvancedTableCellPointerDown, true);
      host.ownerDocument.removeEventListener("pointermove", onAdvancedTableCellPointerMove, true);
      host.ownerDocument.removeEventListener("pointerup", onAdvancedTableCellPointerUp, true);
      host.ownerDocument.removeEventListener("pointercancel", onAdvancedTableCellPointerCancel, true);
      if (advancedCompatibilityClickTimer != null) window.clearTimeout(advancedCompatibilityClickTimer);
      host.removeEventListener("pointerup", onCodeNodePointerUp, true);
      host.removeEventListener("scroll", repositionNodeToolbar);
      window.removeEventListener("resize", repositionNodeToolbar);
      window.removeEventListener("pointerdown", closeNodeToolbarOutside, true);
      clearLinkTimers();
      closeNodeToolbar();
      host.removeEventListener("scroll", closeBlockMenuOnViewportChange);
      window.removeEventListener("resize", closeBlockMenuOnViewportChange);
      window.removeEventListener("keydown", onBlockDragKeyDown, true);
      window.removeEventListener("blur", onBlockWindowBlur);
      if (noticeTimerRef.current != null) window.clearTimeout(noticeTimerRef.current);
      if (handleDecorationFrame != null) cancelAnimationFrame(handleDecorationFrame);
      if (addHandleVisibilityFrame != null) cancelAnimationFrame(addHandleVisibilityFrame);
      if (outlineSyncFrame != null) cancelAnimationFrame(outlineSyncFrame);
      pendingOutlineDocument = null;
      host.removeEventListener("pointermove", scheduleAddHandleVisibility, true);
      host.ownerDocument.removeEventListener("selectionchange", scheduleAddHandleVisibility);
      clearBlockPointerDrag(blockPress);
      blockPress = null;
      clearSelectedBlocks();
      executeInsertCommandRef.current = () => false;
      if (clearBlockSelectionRef.current === clearSelectedBlocks) clearBlockSelectionRef.current = () => {};
      closeBlockMenu();
      if (crepeRef.current === crepe) crepeRef.current = null;
      crepe.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceMode]); // 手动切换源码/可视化时重建编辑器；其余依赖仍由 key 驱动

  const closeLinkDisplayPicker = (restoreFocus = true) => {
    linkTitleAbortRef.current?.abort();
    linkTitleAbortRef.current = null;
    setLinkDisplayPicker(null);
    if (restoreFocus) restoreEditorFocus();
  };

  const loadWebPageTitle = async (href: string, signal: AbortSignal) => {
    const response = await fetch(href, { signal, credentials: "omit", redirect: "follow" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType && !/html|xhtml/i.test(contentType)) throw new Error("not html");
    const html = await response.text();
    const title = new DOMParser().parseFromString(html.slice(0, 512_000), "text/html").querySelector("title")?.textContent ?? "";
    if (!title.trim()) throw new Error("missing title");
    return title;
  };

  const chooseLinkDisplay = async (mode: "url" | "title" | "bookmark") => {
    const picker = linkDisplayPicker;
    const crepe = crepeRef.current;
    if (!picker || !crepe) return;

    if (mode === "title") {
      linkTitleAbortRef.current?.abort();
      const abort = new AbortController();
      linkTitleAbortRef.current = abort;
      const timeout = window.setTimeout(() => abort.abort(), 3500);
      setLinkDisplayPicker({ ...picker, loading: true });
      const resolved = await resolveLinkTitle(picker.href, (href) => loadWebPageTitle(href, abort.signal));
      window.clearTimeout(timeout);
      if (abort.signal.aborted) return;
      let changed = false;
      crepe.editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const transaction = replaceLinkDisplay(view.state, { ...picker, label: resolved.label });
        if (!transaction) return;
        view.dispatch(transaction.scrollIntoView());
        view.focus();
        changed = true;
      });
      setLinkDisplayPicker(null);
      showNotice(
        changed ? "success" : "error",
        changed
          ? (resolved.source === "title"
              ? (lang === "en" ? "Link title applied" : "已使用网页标题")
              : (lang === "en" ? "Title unavailable · domain kept" : "未获取到标题，已保留域名"))
          : (lang === "en" ? "This link changed before the title arrived" : "标题返回前链接已发生变化"),
        changed ? 1800 : 2600,
      );
      return;
    }

    let changed = mode === "url" && picker.label === picker.href;
    crepe.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const transaction = mode === "bookmark"
        ? upgradeLinkToBookmark(view.state, { ...picker, label: linkDomainFallback(picker.href) })
        : replaceLinkDisplay(view.state, { ...picker, label: picker.href });
      if (!transaction) return;
      view.dispatch(transaction.scrollIntoView());
      view.focus();
      changed = true;
    });
    setLinkDisplayPicker(null);
    showNotice(
      changed ? "success" : "error",
      changed
        ? (mode === "bookmark"
            ? (lang === "en" ? "Shown as web bookmark" : "已显示为网页书签")
            : (lang === "en" ? "Kept as URL" : "已保留为网址"))
        : (lang === "en" ? "This link can no longer be changed" : "这个链接已无法更改显示方式"),
      changed ? 1600 : 2600,
    );
  };

  const openToolbarLink = () => {
    const href = linkToolbar && safeNavigableHref(linkToolbar.href);
    if (!href) {
      showNotice("error", lang === "en" ? "Unsafe link blocked" : "已阻止不安全链接", 2600);
      return;
    }
    void openUrl(href).catch(() => showNotice("error", lang === "en" ? "Couldn't open this link" : "没有打开这个链接", 2600));
  };

  const chooseCodeLanguage = (language: string) => {
    const toolbar = nodeToolbar;
    const crepe = crepeRef.current;
    if (!toolbar || toolbar.kind !== "code" || toolbar.revision == null || !crepe) return;
    let changed = false;
    crepe.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const target = {
        pos: toolbar.pos,
        nodeSize: toolbar.nodeSize,
        revision: toolbar.revision!,
      };
      const ordinal = codeTargetOrdinal(view.state, target, documentRevisionRef.current);
      const nextExactMarkdown = ordinal == null
        ? null
        : patchCodeFenceLanguage(exactMarkdownRef.current, ordinal, language);
      const transaction = nextExactMarkdown == null
        ? null
        : changeCodeLanguage(view.state, target, documentRevisionRef.current, language);
      if (!transaction) return;
      pendingExactMarkdownRef.current = nextExactMarkdown;
      try {
        view.dispatch(transaction.scrollIntoView());
        view.focus();
        changed = true;
      } catch {
        pendingExactMarkdownRef.current = null;
      }
    });
    closeNodeToolbar();
    showNotice(changed ? "success" : "error", changed
      ? (lang === "en" ? "Code language updated" : "代码语言已更新")
      : (lang === "en" ? "This code block already changed" : "这个代码块已经发生变化"), changed ? 1600 : 2600);
  };

  const toggleCodeWrap = () => {
    const toolbar = nodeToolbar;
    if (!toolbar || toolbar.kind !== "code") return;
    const wrap = setCodeWrapView(toolbar.target, !toolbar.wrap);
    setNodeToolbar({ ...toolbar, wrap });
    showNotice("success", wrap
      ? (lang === "en" ? "Code wrapping on · view only" : "代码自动换行已开启 · 仅当前视图")
      : (lang === "en" ? "Code wrapping off · view only" : "代码自动换行已关闭 · 仅当前视图"));
  };

  const copyCurrentCode = async () => {
    const toolbar = nodeToolbar;
    if (!toolbar || toolbar.kind !== "code") return;
    const result = await copyCodeText(toolbar.codeText ?? "");
    showNotice(result.ok ? "success" : "error", result.ok
      ? (lang === "en" ? "Code copied" : "代码已复制")
      : (lang === "en" ? "Couldn't copy · editing is still available" : "复制失败 · 仍可继续编辑"), result.ok ? 1500 : 2600);
  };

  const beginTableUpgrade = () => {
    const toolbar = nodeToolbar;
    if (!toolbar || toolbar.kind !== "table" || toolbar.tableAdvanced) return;
    setNodeToolbar({ ...toolbar, mode: "table-upgrade", tableLosses: undefined });
  };

  const beginTableDowngrade = () => {
    const toolbar = nodeToolbar;
    const crepe = crepeRef.current;
    if (!toolbar || toolbar.kind !== "table" || !toolbar.tableAdvanced || !crepe) return;
    let losses: AdvancedTableDowngradeLoss[] | null = null;
    crepe.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const node = view.state.doc.nodeAt(toolbar.pos);
      if (!node || node.nodeSize !== toolbar.nodeSize || node.type.name !== ADVANCED_TABLE_NODE_NAME) return;
      losses = analyzeAdvancedTableDowngrade(node.attrs.model).losses;
    });
    if (!losses) {
      showNotice("error", lang === "en" ? "This table already changed" : "这个表格已经发生变化", 2600);
      return;
    }
    setNodeToolbar({ ...toolbar, mode: "table-downgrade", tableLosses: losses });
  };

  const confirmTableTransition = () => {
    const toolbar = nodeToolbar;
    const crepe = crepeRef.current;
    if (!toolbar || toolbar.kind !== "table" || !crepe
      || (toolbar.mode !== "table-upgrade" && toolbar.mode !== "table-downgrade")) return;
    const upgrading = toolbar.mode === "table-upgrade";
    let changed = false;
    crepe.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const transaction = upgrading
        ? createAdvancedTableUpgradeTransaction(view.state, toolbar, true)
        : createAdvancedTableDowngradeTransaction(view.state, toolbar, true);
      if (!transaction) return;
      view.dispatch(transaction.scrollIntoView());
      view.focus();
      changed = true;
    });
    closeNodeToolbar();
    showNotice(changed ? "success" : "error", changed
      ? upgrading
        ? (lang === "en" ? "Current table upgraded · Undo restores GFM" : "当前表格已升级 · 撤销可恢复 GFM")
        : (lang === "en" ? "Current table downgraded" : "当前表格已降级")
      : (lang === "en" ? "This table already changed" : "这个表格已经发生变化"), changed ? 2200 : 2600);
  };

  const currentAdvancedTableCoordinate = (toolbar: NodeToolbarState): AdvancedTableCellCoordinate | null => (
    toolbar.tableAdvanced && toolbar.tableSection && toolbar.tableRow != null && toolbar.tableColumn != null
      ? { section: toolbar.tableSection, row: toolbar.tableRow, column: toolbar.tableColumn }
      : null
  );

  const dispatchAdvancedTableChange = (
    create: (state: EditorState, toolbar: NodeToolbarState) => Transaction | null,
    success: { zh: string; en: string },
  ) => {
    const toolbar = nodeToolbar;
    const crepe = crepeRef.current;
    if (!toolbar || !toolbar.tableAdvanced || !crepe) return;
    let changed = false;
    crepe.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const transaction = create(view.state, toolbar);
      if (!transaction) return;
      view.dispatch(transaction.scrollIntoView());
      view.focus();
      changed = true;
    });
    closeNodeToolbar();
    showNotice(changed ? "success" : "error", changed
      ? success[lang]
      : (lang === "en" ? "This table selection already changed" : "这个表格选区已经发生变化"), changed ? 1600 : 2600);
  };

  const mergeAdvancedTableSelection = () => dispatchAdvancedTableChange(
    (state, toolbar) => createAdvancedTableMergeTransaction(state, toolbar, toolbar.tableSelection ?? []),
    { zh: "已合并选区 · 撤销可恢复", en: "Selection merged · Undo restores it" },
  );

  const splitAdvancedTableSelection = () => dispatchAdvancedTableChange(
    (state, toolbar) => {
      const coordinate = currentAdvancedTableCoordinate(toolbar);
      return coordinate ? createAdvancedTableSplitTransaction(state, toolbar, coordinate) : null;
    },
    { zh: "已拆分单元格 · 撤销可恢复", en: "Cell split · Undo restores it" },
  );

  const setAdvancedTableBackground = (token: ControlledColorToken | null) => dispatchAdvancedTableChange(
    (state, toolbar) => createAdvancedTableCellBackgroundTransaction(state, toolbar, toolbar.tableSelection ?? [], token),
    { zh: token ? "已更新单元格底色" : "已清除单元格底色", en: token ? "Cell background updated" : "Cell background cleared" },
  );

  const runAdvancedTableBlockOperation = (operation: AdvancedTableCellBlockOperation) => dispatchAdvancedTableChange(
    (state, toolbar) => {
      const coordinate = currentAdvancedTableCoordinate(toolbar);
      return coordinate ? createAdvancedTableCellBlockTransaction(state, toolbar, coordinate, operation) : null;
    },
    {
      zh: operation.type === "insert" ? "已插入单元格块" : operation.type === "replace" ? "已更新单元格块" : "已移动单元格块",
      en: operation.type === "insert" ? "Cell block inserted" : operation.type === "replace" ? "Cell block updated" : "Cell block moved",
    },
  );

  const insertAdvancedTableBlock = (kind: "paragraph" | "bullet-list" | "task-list" | "code") => {
    const toolbar = nodeToolbar;
    if (!toolbar) return;
    const label = lang === "en" ? "New content" : "新内容";
    const block: AdvancedTableBlock = kind === "paragraph"
      ? { kind, html: `<p>${label}</p>` }
      : kind === "bullet-list"
        ? { kind, html: `<ul><li><p>${label}</p></li></ul>` }
        : kind === "task-list"
          ? { kind, html: `<ul data-omia-task-list="1"><li data-checked="false"><p>${label}</p></li></ul>` }
          : { kind, html: `<pre><code>${label}</code></pre>` };
    runAdvancedTableBlockOperation({ type: "insert", index: toolbar.tableCellBlocks?.length ?? 0, block });
  };

  const beginAdvancedTableBlockEdit = (index: number) => {
    const toolbar = nodeToolbar;
    const block = toolbar?.tableCellBlocks?.[index];
    if (!toolbar || !block || !editableAdvancedTableBlock(block)) return;
    setNodeToolbar({ ...toolbar, mode: "table-block-edit", tableBlockIndex: index, draft: advancedTableBlockText(block) });
  };

  const saveAdvancedTableBlockEdit = () => {
    const toolbar = nodeToolbar;
    const index = toolbar?.tableBlockIndex;
    const block = index == null ? null : toolbar?.tableCellBlocks?.[index];
    if (!toolbar || index == null || !block || !editableAdvancedTableBlock(block)) return;
    const text = escapeAdvancedTableText(toolbar.draft);
    const replacement: AdvancedTableBlock = block.kind === "paragraph"
      ? { kind: block.kind, html: `<p>${text}</p>` }
      : block.kind === "code"
        ? {
            kind: block.kind,
            html: `<pre><code${block.html.match(/<code( data-language="[^"]+")>/)?.[1] ?? ""}>${text}</code></pre>`,
          }
        : {
            kind: block.kind,
            html: `<h${block.kind.slice("heading-".length)}>${text}</h${block.kind.slice("heading-".length)}>`,
          };
    runAdvancedTableBlockOperation({ type: "replace", index, block: replacement });
  };

  const runNodeToolbarAction = (action: NodeToolbarAction) => {
    const toolbar = nodeToolbar;
    const crepe = crepeRef.current;
    if (!toolbar || !crepe) return;
    if (action === "open") {
      const href = toolbar.href && safeNavigableHref(toolbar.href);
      if (!href) {
        showNotice("error", lang === "en" ? "This source cannot be opened safely" : "这个来源无法安全打开", 2600);
        return;
      }
      void openUrl(href).catch(() => showNotice("error", lang === "en" ? "Couldn't open this source" : "没有打开这个来源", 2600));
      return;
    }
    if (action === "edit-source") {
      setNodeToolbar({ ...toolbar, mode: "source", draft: toolbar.href ?? "" });
      return;
    }
    if (action === "description" && toolbar.kind === "image") {
      setNodeToolbar({ ...toolbar, mode: "description", draft: toolbar.caption ?? "" });
      return;
    }
    if (action === "replace-source" && toolbar.kind === "image") {
      setNodeToolbar({ ...toolbar, mode: "source", draft: toolbar.src ?? "" });
      return;
    }
    if (toolbar.kind === "layout" && action === "layout-linearize") {
      setNodeToolbar({ ...toolbar, mode: "layout-linearize" });
      return;
    }
    if (toolbar.kind === "layout" && [
      "layout-two", "layout-three",
      "layout-left-wide", "layout-equal", "layout-right-wide",
      "layout-previous", "layout-next",
    ].includes(action)) {
      let changed = false;
      crepe.editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const target = { pos: toolbar.pos, nodeSize: toolbar.nodeSize };
        const transaction = action === "layout-two" || action === "layout-three"
          ? createPersistentLayoutColumnCountTransaction(view.state, target, action === "layout-two" ? 2 : 3)
          : action === "layout-previous" || action === "layout-next"
            ? createPersistentLayoutOrderTransaction(view.state, target, action === "layout-previous" ? "previous" : "next")
            : createPersistentLayoutWidthTransaction(view.state, target, action === "layout-left-wide"
              ? "left-wide"
              : action === "layout-right-wide" ? "right-wide" : "equal");
        if (!transaction) return;
        view.dispatch(transaction.scrollIntoView());
        view.focus();
        changed = true;
      });
      closeNodeToolbar();
      showNotice(changed ? "success" : "error", changed
        ? (lang === "en" ? "Column layout updated" : "分栏已更新")
        : (lang === "en" ? "The layout already has this setting" : "分栏已是这个设置或已经发生变化"), changed ? 1500 : 2400);
      return;
    }
    if (toolbar.kind === "table" && [
      "row-before", "row-after", "delete-row",
      "column-before", "column-after", "delete-column",
      "align-left", "align-center", "align-right",
    ].includes(action)) {
      let changed = false;
      if (toolbar.tableRow != null && toolbar.tableColumn != null) {
        crepe.editor.action((ctx) => {
          const view = ctx.get(editorViewCtx);
          const transaction = editPortableTable(view.state, {
            pos: toolbar.pos,
            nodeSize: toolbar.nodeSize,
            row: toolbar.tableRow!,
            column: toolbar.tableColumn!,
          }, action as PortableTableAction);
          if (!transaction) return;
          view.dispatch(transaction.scrollIntoView());
          view.focus();
          changed = true;
        });
      }
      closeNodeToolbar();
      showNotice(changed ? "success" : "error", changed
        ? (lang === "en" ? "Table updated" : "表格已更新")
        : (lang === "en" ? "This operation would make the GFM table invalid" : "该操作会使 GFM 表格无效"), changed ? 1500 : 2600);
      return;
    }
    if (action === "edit") {
      const pos = toolbar.pos;
      closeNodeToolbar();
      crepe.editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const safePos = Math.max(0, Math.min(pos + 1, view.state.doc.content.size));
        view.dispatch(view.state.tr.setSelection(Selection.near(view.state.doc.resolve(safePos))).scrollIntoView());
        view.focus();
      });
      return;
    }
    if (action === "display" && toolbar.kind === "bookmark") {
      let changed = false;
      crepe.editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const node = view.state.doc.nodeAt(toolbar.pos);
        const linkType = view.state.schema.marks.link;
        if (!node || node.nodeSize !== toolbar.nodeSize || !linkType || !node.textContent) return;
        const mark = node.firstChild?.marks.find((item) => item.type === linkType && item.attrs.title === "omia:bookmark");
        if (!mark) return;
        const replacement = node.type.create(
          node.attrs,
          view.state.schema.text(node.textContent, [linkType.create({ href: mark.attrs.href, title: null })]),
          node.marks,
        );
        view.dispatch(view.state.tr.replaceWith(toolbar.pos, toolbar.pos + toolbar.nodeSize, replacement).scrollIntoView());
        view.focus();
        changed = true;
      });
      closeNodeToolbar();
      showNotice(changed ? "success" : "error", changed
        ? (lang === "en" ? "Shown as a text link" : "已显示为文字链接")
        : (lang === "en" ? "This bookmark already changed" : "这个网页书签已经发生变化"), changed ? 1600 : 2600);
      return;
    }
    if (action === "delete") {
      let changed = false;
      crepe.editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const transaction = deletePortableNode(view.state, toolbar);
        if (!transaction) return;
        view.dispatch(transaction.scrollIntoView());
        view.focus();
        changed = true;
      });
      closeNodeToolbar();
      showNotice(changed ? "success" : "error", changed
        ? (lang === "en" ? "Node deleted" : "已删除节点")
        : (lang === "en" ? "This node already changed" : "这个节点已经发生变化"), changed ? 1600 : 2600);
    }
  };

  const confirmPersistentLayoutDowngrade = () => {
    const toolbar = nodeToolbar;
    const crepe = crepeRef.current;
    if (!toolbar || toolbar.kind !== "layout" || !crepe) return;
    let changed = false;
    crepe.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const transaction = createPersistentLayoutDowngradeTransaction(view.state, toolbar);
      if (!transaction) return;
      view.dispatch(transaction.scrollIntoView());
      view.focus();
      changed = true;
    });
    closeNodeToolbar();
    showNotice(changed ? "success" : "error", changed
      ? (lang === "en" ? "Columns removed; blocks kept in reading order" : "已解除分栏，所有块按阅读顺序保留")
      : (lang === "en" ? "This layout already changed" : "这个分栏已经发生变化"), changed ? 1800 : 2600);
  };

  const saveNodeToolbarSource = () => {
    const toolbar = nodeToolbar;
    const crepe = crepeRef.current;
    if (!toolbar || !crepe) return;
    if (toolbar.kind === "image") {
      let nextSource = "";
      crepe.editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const transaction = editImageNode(view.state, toolbar, { src: toolbar.draft });
        if (!transaction) return;
        view.dispatch(transaction.scrollIntoView());
        nextSource = String(transaction.doc.nodeAt(toolbar.pos)?.attrs.src ?? "");
        view.focus();
      });
      if (!nextSource) {
        showNotice("error", lang === "en" ? "Enter a safe image source" : "请输入安全的图片来源", 2600);
        return;
      }
      setNodeToolbar({ ...toolbar, src: nextSource, draft: nextSource, mode: "actions" });
      showNotice("success", lang === "en" ? "Image source replaced" : "图片来源已替换");
      return;
    }
    if (!["bookmark", "audio", "video", "file"].includes(toolbar.kind)) return;
    let nextHref = "";
    crepe.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const transaction = editRichLinkNodeSource(view.state, {
        kind: toolbar.kind as RichLinkKind,
        pos: toolbar.pos,
        nodeSize: toolbar.nodeSize,
      }, toolbar.draft);
      if (!transaction) return;
      view.dispatch(transaction.scrollIntoView());
      const nextNode = transaction.doc.nodeAt(toolbar.pos);
      nextHref = String(nextNode?.firstChild?.marks.find((mark) => mark.type.name === "link")?.attrs.href ?? "");
      view.focus();
    });
    if (!nextHref) {
      showNotice("error", lang === "en" ? "Enter a safe, supported source" : "请输入安全且受支持的来源", 2600);
      return;
    }
    setNodeToolbar({ ...toolbar, href: nextHref, draft: nextHref, mode: "actions" });
    showNotice("success", lang === "en" ? "Source updated" : "来源已更新");
  };

  const saveImageDescription = () => {
    const toolbar = nodeToolbar;
    const crepe = crepeRef.current;
    if (!toolbar || !crepe || toolbar.kind !== "image") return;
    let changed = false;
    const description = toolbar.draft.trim();
    crepe.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const transaction = editImageNode(view.state, toolbar, { caption: description });
      if (!transaction) return;
      view.dispatch(transaction.scrollIntoView());
      view.focus();
      changed = true;
    });
    if (!changed && description !== (toolbar.caption ?? "")) {
      showNotice("error", lang === "en" ? "This image already changed" : "这张图片已经发生变化", 2600);
      return;
    }
    setNodeToolbar({ ...toolbar, caption: description, draft: description, mode: "actions" });
    showNotice("success", lang === "en" ? "Image description saved to alt" : "图片描述已写入 alt");
  };

  const saveToolbarLink = () => {
    const toolbar = linkToolbar;
    const crepe = crepeRef.current;
    if (!toolbar || !crepe) return;
    let changed = false;
    crepe.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const transaction = editLinkHref(view.state, toolbar, toolbar.draft);
      if (!transaction) return;
      view.dispatch(transaction.scrollIntoView());
      view.focus();
      changed = true;
    });
    if (!changed) {
      showNotice("error", lang === "en" ? "Enter a safe http(s) address" : "请输入安全的 http(s) 地址", 2600);
      return;
    }
    setLinkToolbar(null);
    showNotice("success", lang === "en" ? "Link updated" : "链接已更新");
  };

  const unlinkToolbarLink = () => {
    const toolbar = linkToolbar;
    const crepe = crepeRef.current;
    if (!toolbar || !crepe) return;
    let changed = false;
    crepe.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const transaction = removeLink(view.state, toolbar);
      if (!transaction) return;
      view.dispatch(transaction.scrollIntoView());
      view.focus();
      changed = true;
    });
    setLinkToolbar(null);
    showNotice(
      changed ? "success" : "error",
      changed ? (lang === "en" ? "Link removed" : "已取消链接") : (lang === "en" ? "This link already changed" : "这个链接已经发生变化"),
      changed ? 1600 : 2600,
    );
  };

  const showToolbarLinkDisplay = () => {
    const toolbar = linkToolbar;
    const crepe = crepeRef.current;
    if (!toolbar || !crepe) return;
    let canBookmark = false;
    crepe.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const $from = view.state.doc.resolve(toolbar.from);
      const $to = view.state.doc.resolve(toolbar.to);
      canBookmark = $from.sameParent($to)
        && $from.parent.type.name === "paragraph"
        && toolbar.from === $from.start()
        && toolbar.to === $from.end();
    });
    setLinkDisplayPicker({
      from: toolbar.from,
      to: toolbar.to,
      href: toolbar.href,
      label: toolbar.label,
      canBookmark,
      left: toolbar.left,
      top: Math.min(window.innerHeight - 188, toolbar.top + 44),
      loading: false,
    });
    setLinkToolbar(null);
  };

  const closeRichLinkDialog = () => {
    setRichLinkDialog(null);
    restoreEditorFocus();
  };

  const chooseRichLinkFile = async () => {
    if (!richLinkDialog || richLinkDialog.kind === "bookmark") return;
    try {
      const filters = richLinkDialog.kind === "audio"
        ? [{ name: "Audio", extensions: ["mp3", "m4a", "wav", "ogg", "webm"] }]
        : richLinkDialog.kind === "video"
          ? [{ name: "Video", extensions: ["mp4", "mov", "m4v", "webm", "ogv"] }]
          : undefined;
      const selected = await openDialog({ multiple: false, directory: false, filters });
      if (typeof selected === "string") {
        setRichLinkDialog((current) => current ? { ...current, url: selected, error: "" } : current);
      }
    } catch {
      setRichLinkDialog((current) => current
        ? { ...current, error: lang === "en" ? "Couldn't open the file picker." : "没有打开文件选择器。" }
        : current);
    }
  };

  const submitRichLink = (event: { preventDefault(): void }) => {
    event.preventDefault();
    const dialog = richLinkDialog;
    const crepe = crepeRef.current;
    if (!dialog || !crepe) return;
    const normalized = normalizeRichLinkInput(dialog.kind, dialog.url, dialog.label);
    if (!normalized.ok) {
      const error = normalized.reason === "empty"
        ? (lang === "en" ? "Enter a URL or file path." : "请输入网址或文件路径。")
        : normalized.reason === "unsafe"
          ? (lang === "en" ? "This address is unsafe and was blocked." : "这个地址不安全，已阻止插入。")
          : (lang === "en" ? "This block doesn't support that address type." : "这个区块不支持这种地址类型。");
      setRichLinkDialog({ ...dialog, error });
      return;
    }

    let inserted = false;
    try {
      crepe.editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const targetPos = dialog.belowAnchor
          ? resolveBelowInsertAnchor(view.state.doc, dialog.belowAnchor)
          : dialog.pos;
        if (targetPos == null) return;
        const target = dialog.replaceNodeSize > 0 ? view.state.doc.nodeAt(targetPos) : null;
        const paragraph = paragraphSchema.type(ctx);
        const link = view.state.schema.marks.link;
        if ((dialog.replaceNodeSize > 0 && !target) || !link || isPageTitlePosition(view.state.doc, targetPos)) return;
        const markedText = view.state.schema.text(
          normalized.value.label,
          [link.create({ href: normalized.value.href, title: normalized.value.title })],
        );
        const card = paragraph.create(null, markedText);
        let tr = view.state.tr.replaceWith(targetPos, targetPos + dialog.replaceNodeSize, card);
        const cardEnd = targetPos + card.nodeSize;
        if (cardEnd >= tr.doc.content.size) tr = tr.insert(cardEnd, paragraph.create());
        const selectionAt = Math.min(cardEnd + 1, tr.doc.content.size);
        tr = tr.setSelection(TextSelection.near(tr.doc.resolve(selectionAt))).scrollIntoView();
        view.dispatch(tr);
        view.focus();
        inserted = true;
      });
    } catch {
      inserted = false;
    }
    if (!inserted) {
      setRichLinkDialog({ ...dialog, error: lang === "en" ? "This block couldn't be inserted." : "这个区块没有插入成功。" });
      return;
    }
    setRichLinkDialog(null);
    showNotice("success", lang === "en" ? "Block inserted" : "区块已插入");
  };

  if (sourceMode) {
    const labels: Record<MarkdownEditRisk, { zh: string; en: string }> = {
      "front-matter": { zh: "Front Matter", en: "Front Matter" },
      footnotes: { zh: "脚注", en: "footnotes" },
      "raw-html": { zh: "HTML 混排", en: "embedded HTML" },
      toc: { zh: "目录标记", en: "TOC markers" },
      "fence-metadata": { zh: "代码块元数据", en: "code-fence metadata" },
      directives: { zh: "扩展指令", en: "extended directives" },
    };
    const reasons = editSafety.risks.map((risk) => labels[risk][lang]).join("、");
    return (
      <div className="markdown-source-preserve">
        <div className="markdown-source-preserve__notice" role="status">
          <strong>{lang === "en" ? "Lossless source editing" : "源码保真编辑"}</strong>
          {lang === "en"
            ? `: ${reasons}. Visual serialization is bypassed so unsupported syntax is not rewritten.`
            : `：检测到 ${reasons}。已绕开所见即所得序列化，避免高级语法在保存时被改写或丢失。`}
        </div>
        <textarea
          className="markdown-source-preserve__editor"
          value={value}
          onChange={(event) => onChangeRef.current(event.target.value)}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          aria-label={lang === "en" ? "Markdown source" : "Markdown 源码"}
        />
      </div>
    );
  }

  const navigateToHeading = (entry: HeadingOutlineEntry) => {
    const crepe = crepeRef.current;
    if (!crepe) return;
    closeBlockMenu();
    closeNodeToolbar();
    setLinkToolbar(null);
    updateSlashInsertMenu(null);
    updateBrowseInsertMenu(null);
    crepe.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const transaction = createHeadingNavigationTransaction(view.state, entry.pos);
      if (!transaction) return;
      view.dispatch(transaction.scrollIntoView());
      const target = view.nodeDOM(entry.pos);
      if (target instanceof HTMLElement) target.scrollIntoView({ block: "center", behavior: "smooth" });
      view.focus();
    });
  };

  const toggleHeadingSection = (entry: HeadingOutlineEntry) => {
    const crepe = crepeRef.current;
    if (!crepe) return;
    crepe.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const transaction = createSectionFoldTransaction(view.state, entry.pos);
      if (!transaction) return;
      view.dispatch(transaction);
      setFoldedSections(foldedHeadingPositions(view.state));
      view.focus();
    });
  };

  const runBlockAction = (action: BlockAction) => {
    const menu = blockMenu;
    const crepe = crepeRef.current;
    if (!menu || !crepe) return;
    const isGroup = menu.indices.length > 1;
    let clipboardText = "";
    let mutated = false;
    let hierarchyFailed = false;
    try {
      crepe.editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        type DocNode = NonNullable<typeof view.state.doc.firstChild>;
        const blocks: Array<{ pos: number; nodeSize: number; node: DocNode }> = [];
        view.state.doc.forEach((child, offset) => blocks.push({ pos: offset, nodeSize: child.nodeSize, node: child }));

        if (action === "list-lift" || action === "list-sink") {
          if (!menu.listHierarchy) {
            hierarchyFailed = true;
            return;
          }
          const transaction = createListHierarchyTransaction(view.state, {
            listPos: menu.listHierarchy.listPos,
            sourceIds: menu.listHierarchy.sourceIds,
            action: action === "list-lift" ? "lift" : "sink",
          });
          if (!transaction) {
            hierarchyFailed = true;
            return;
          }
          view.dispatch(transaction.scrollIntoView());
          view.focus();
          mutated = true;
          return;
        }

        if (action === "image-side-by-side") {
          const transaction = menu.canImageSideBySide
            ? createImageSideBySideTransaction(view.state, menu.indices)
            : null;
          if (!transaction) return;
          view.dispatch(transaction.scrollIntoView());
          view.focus();
          mutated = true;
          return;
        }

        if (isGroup) {
          const sources = menu.indices.map((index) => blocks[index]).filter((source): source is NonNullable<typeof source> => Boolean(source));
          if (sources.length !== menu.indices.length
            || menu.indices.includes(pageTitleIndex(view.state.doc) ?? -1)
            || (newDocument && menu.indices.includes(0))) return;

          if (action === "copy") {
            const serializer = ctx.get(serializerCtx);
            const folded = new Set(foldedHeadingPositions(view.state));
            if (sources.some(({ pos }) => folded.has(pos))) {
              try {
                const groupedDocument = view.state.doc.type.create(view.state.doc.attrs, sources.map(({ node }) => node));
                clipboardText = serializePortableImageMarkdown(serializer(groupedDocument)).trimEnd();
                return;
              } catch { /* 逐节点兜底仍会保证文字不丢 */ }
            }
            clipboardText = sources.map(({ node }) => {
              try { return serializePortableImageMarkdown(serializer(node)).trimEnd(); }
              catch { return node?.textContent ?? ""; }
            }).join("\n\n");
            return;
          }

          if (action === "duplicate") {
            const last = sources[sources.length - 1];
            if (!last) return;
            const insertAt = last.pos + last.nodeSize;
            const tr = view.state.tr.insert(insertAt, sources.map(({ node }) => node.copy(node.content)));
            view.dispatch(tr.setSelection(Selection.near(tr.doc.resolve(Math.min(insertAt + 1, tr.doc.content.size)))).scrollIntoView());
            view.focus();
            mutated = true;
            return;
          }

          if (action === "delete") {
            let tr = view.state.tr;
            [...sources].reverse().forEach((source) => {
              tr = tr.delete(source.pos, source.pos + source.nodeSize);
            });
            if (tr.doc.childCount === 0) tr = tr.insert(0, paragraphSchema.type(ctx).create());
            const selectionAt = Math.min(sources[0]?.pos ?? 0, tr.doc.content.size);
            view.dispatch(tr.setSelection(Selection.near(tr.doc.resolve(selectionAt))).scrollIntoView());
            view.focus();
            mutated = true;
            return;
          }

          if (action === "move-up" || action === "move-down") {
            const direction = action === "move-up" ? "up" : "down";
            const destination = foldedHeadingPositions(view.state).includes(menu.pos)
              ? collapsedSectionStepDestination(view.state.doc, menu.indices, menu.pos, direction)
              : blockGroupStepDestination(menu.indices, blocks.length, newDocument, direction);
            if (destination == null) return;
            const previousFolded = foldedHeadingPositions(view.state);
            let tr = view.state.tr;
            [...sources].reverse().forEach((source) => {
              tr = tr.delete(source.pos, source.pos + source.nodeSize);
            });
            let insertAt = tr.doc.content.size;
            tr.doc.forEach((_child, offset, index) => {
              if (index === destination) insertAt = offset;
            });
            tr = tr.insert(insertAt, sources.map(({ node }) => node.copy(node.content)));
            tr = replaceFoldedHeadingPositions(
              tr,
              foldedHeadingPositionsAfterBlockMove(tr, sources, insertAt, previousFolded),
            );
            view.dispatch(tr.setSelection(Selection.near(tr.doc.resolve(Math.min(insertAt + 1, tr.doc.content.size)))).scrollIntoView());
            view.focus();
            mutated = true;
          }
          return;
        }

        const node = view.state.doc.nodeAt(menu.pos);
        if (!node || isPageTitlePosition(view.state.doc, menu.pos)) return;

        if (action === "copy") {
          try {
            const serializer = ctx.get(serializerCtx);
            clipboardText = foldedHeadingPositions(view.state).includes(menu.pos)
              ? serializePortableImageMarkdown(serializer(view.state.doc.type.create(view.state.doc.attrs, [node]))).trimEnd()
              : serializePortableImageMarkdown(serializer(node)).trimEnd();
          }
          catch { clipboardText = node.textContent; }
          return;
        }

        if (action === "duplicate") {
          const insertAt = menu.pos + node.nodeSize;
          const tr = view.state.tr.insert(insertAt, node.copy(node.content));
          view.dispatch(tr.setSelection(Selection.near(tr.doc.resolve(Math.min(insertAt + 1, tr.doc.content.size)))).scrollIntoView());
          return;
        }

        const index = blocks.findIndex((block) => block.pos === menu.pos);

        if (action === "move-up" && canMoveTopLevelBlock(index, blocks.length, newDocument, "up")) {
          const previous = blocks[index - 1];
          if (!previous) return;
          const tr = view.state.tr.delete(menu.pos, menu.pos + node.nodeSize).insert(previous.pos, node);
          view.dispatch(tr.setSelection(Selection.near(tr.doc.resolve(Math.min(previous.pos + 1, tr.doc.content.size)))).scrollIntoView());
          return;
        }
        if (action === "move-down" && canMoveTopLevelBlock(index, blocks.length, newDocument, "down")) {
          const next = blocks[index + 1];
          if (!next) return;
          const insertAt = menu.pos + next.nodeSize;
          const tr = view.state.tr.delete(menu.pos, menu.pos + node.nodeSize).insert(insertAt, node);
          view.dispatch(tr.setSelection(Selection.near(tr.doc.resolve(Math.min(insertAt + 1, tr.doc.content.size)))).scrollIntoView());
          return;
        }
        if (action === "delete") {
          let tr = view.state.tr.delete(menu.pos, menu.pos + node.nodeSize);
          if (tr.doc.childCount === 0) tr = tr.insert(0, paragraphSchema.type(ctx).create());
          view.dispatch(tr.setSelection(Selection.near(tr.doc.resolve(Math.min(menu.pos, tr.doc.content.size)))).scrollIntoView());
          return;
        }

        // “转换为”先把复杂块归一成一个正文块，再走 Milkdown 原生命令；标记文本会保留，
        // 列表/引用则按可见文字转换，避免直接拼 schema 产生非法文档。
        const schema = ctx.get(schemaCtx);
        const paragraphType = paragraphSchema.type(ctx);
        const calloutBody = node.type === blockquoteSchema.type(ctx)
          && /^\[!(?:note|tip|important|warning|caution)\]$/i.test(node.firstChild?.textContent.trim() ?? "")
          && node.childCount > 1
          ? node.child(1)
          : null;
        const inlineContent = node.isTextblock
          ? node.content
          : (calloutBody?.isTextblock
            ? calloutBody.content
            : (node.textContent ? schema.text(node.textContent) : undefined));
        let tr = view.state.tr.replaceWith(menu.pos, menu.pos + node.nodeSize, paragraphType.create(null, inlineContent));
        tr = tr.setSelection(TextSelection.near(tr.doc.resolve(menu.pos + 1)));
        view.dispatch(tr);
        const commands = ctx.get(commandsCtx);
        if (/^h[1-6]$/.test(action)) {
          commands.call(setBlockTypeCommand.key, { nodeType: headingSchema.type(ctx), attrs: { level: Number(action.slice(1)) } });
        } else if (action === "code") {
          const codeBlock = schema.nodes.code_block;
          if (codeBlock) commands.call(setBlockTypeCommand.key, { nodeType: codeBlock });
        } else if (action === "callout") {
          const marker = paragraphType.create(null, schema.text("[!NOTE]"));
          const body = paragraphType.create(null, inlineContent);
          const callout = blockquoteSchema.type(ctx).createChecked(null, [marker, body]);
          const currentNode = view.state.doc.nodeAt(menu.pos);
          if (currentNode) {
            const calloutTr = view.state.tr.replaceWith(menu.pos, menu.pos + currentNode.nodeSize, callout);
            const bodyStart = menu.pos + 1 + marker.nodeSize + 1;
            view.dispatch(calloutTr.setSelection(TextSelection.create(calloutTr.doc, bodyStart)).scrollIntoView());
          }
        } else if (action === "quote") {
          commands.call(wrapInBlockTypeCommand.key, { nodeType: blockquoteSchema.type(ctx) });
        } else if (action === "bullet") {
          commands.call(wrapInBlockTypeCommand.key, { nodeType: bulletListSchema.type(ctx) });
        } else if (action === "ordered") {
          commands.call(wrapInBlockTypeCommand.key, { nodeType: orderedListSchema.type(ctx) });
        } else if (action === "todo") {
          commands.call(wrapInBlockTypeCommand.key, { nodeType: listItemSchema.type(ctx), attrs: { checked: false } });
        }
        view.focus();
      });
    } catch {
      showNotice("error", lang === "en" ? "Block action failed" : "区块操作没有完成", 2600);
      closeBlockMenu();
      return;
    }

    if (hierarchyFailed) {
      showNotice("error", lang === "en" ? "This list level can no longer be changed" : "当前列表层级已无法更改", 2600);
      closeBlockMenu();
      restoreEditorFocus();
      return;
    }

    if (action === "copy") {
      void copyEditorText(clipboardText).then((copied) => {
        showNotice(
          copied ? "success" : "error",
          copied
            ? (isGroup
              ? (lang === "en" ? `${menu.indices.length} blocks copied` : `已复制 ${menu.indices.length} 个区块`)
              : (lang === "en" ? "Block copied" : "区块已复制"))
            : (lang === "en" ? "Couldn't copy block" : "区块复制失败"),
          copied ? 1500 : 2600,
        );
      });
    }
    if ((isGroup || action === "list-lift" || action === "list-sink") && mutated) clearBlockSelectionRef.current();
    closeBlockMenu();
    restoreEditorFocus();
  };

  const insertBlockBelow = (command: InsertCommand, tableSize?: TableSize) => {
    const menu = blockMenu;
    const crepe = crepeRef.current;
    if (!menu || !crepe) return;
    if (command.id === "table" && !tableSize) {
      updateTableSizePicker({ source: "below", value: DEFAULT_TABLE_SIZE });
      return;
    }
    let insertAt: number | null = null;
    let openedRichLink = false;
    try {
      crepe.editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        insertAt = resolveBelowInsertAnchor(view.state.doc, menu.belowAnchor);
        if (insertAt == null
          || menu.indices.includes(pageTitleIndex(view.state.doc) ?? -1)
          || (newDocument && menu.indices.includes(0))) return;
        if (command.id === "bookmark" || command.id === "video" || command.id === "audio" || command.id === "file") {
          setRichLinkDialog({
            kind: command.id,
            pos: insertAt,
            replaceNodeSize: 0,
            belowAnchor: menu.belowAnchor,
            url: "",
            label: "",
            error: "",
          });
          openedRichLink = true;
          return;
        }
        if (command.id !== "table" || !tableSize) {
          const paragraph = paragraphSchema.type(ctx).create();
          const tr = view.state.tr.insert(insertAt, paragraph);
          view.dispatch(tr.setSelection(TextSelection.create(tr.doc, insertAt + 1)).scrollIntoView());
        }
      });
      if (insertAt == null) {
        showNotice("error", lang === "en" ? "The target block changed; nothing was inserted" : "目标区块已变化，未插入内容", 2600);
        closeBlockMenu();
        return;
      }
      closeBlockMenu();
      if (openedRichLink) return;
      const executed = executeInsertCommandRef.current(command.id, "below", insertAt, tableSize);
      if (executed) clearBlockSelectionRef.current();
    } catch {
      showNotice("error", lang === "en" ? "This block couldn't be inserted" : "这个区块没有插入成功", 2400);
      closeBlockMenu();
    }
  };

  const onBlockMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented) return;
    const fromSearch = event.target instanceof HTMLInputElement;
    const search = event.currentTarget.querySelector<HTMLInputElement>('input[type="search"]');
    if (fromSearch && (event.key === "Backspace" || event.key === "Delete")) return;
    const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
    const currentIndex = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const activeButton = fromSearch ? buttons[0] : buttons[currentIndex];
    const imeEnter = isImeEnter({
      isComposing: event.nativeEvent.isComposing,
      composing: imeComposingRef.current,
      sinceEndMs: performance.now() - lastImeCompositionEndAtRef.current,
    });
    if (event.key === "Enter") {
      event.preventDefault();
      if (shouldRunBlockMenuEnter({ key: event.key, imeEnter, hasTarget: Boolean(activeButton) })) activeButton?.click();
      return;
    }
    if (event.key === "Backspace" || event.key === "Delete") {
      event.preventDefault();
      runBlockAction("delete");
      return;
    }
    if (!["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End", "Tab"].includes(event.key)) return;
    event.preventDefault();
    const nextIndex = moveBlockMenuFocus(fromSearch ? -1 : currentIndex, event.key as Parameters<typeof moveBlockMenuFocus>[1], buttons.length, event.shiftKey);
    if (nextIndex < 0) search?.focus({ preventScroll: true });
    else buttons[nextIndex]?.focus({ preventScroll: true });
  };

  const blockLabels = lang === "en"
    ? { title: "Block", hint: "Drag the handle to reorder", search: "Search actions…", empty: "No matching actions", copy: "Copy", duplicate: "Duplicate", moveUp: "Move up", moveDown: "Move down", lift: "Decrease list level", sink: "Increase list level", imageSideBySide: "Place images side by side", remove: "Delete", turnInto: "Turn into", structure: "Structure", content: "Content", addBelow: "Add below", text: "Text", h1: "Heading 1", h2: "Heading 2", h3: "Heading 3", h4: "Heading 4", h5: "Heading 5", h6: "Heading 6", quote: "Quote", callout: "Callout", code: "Code", bullet: "Bullet list", ordered: "Numbered list", todo: "To-do list" }
    : { title: "区块", hint: "拖动六点可调整顺序", search: "搜索操作…", empty: "没有匹配的操作", copy: "复制", duplicate: "创建副本", moveUp: "上移", moveDown: "下移", lift: "提升列表层级", sink: "下沉列表层级", imageSideBySide: "图片并排", remove: "删除", turnInto: "转换为", structure: "结构", content: "内容", addBelow: "下方添加", text: "正文", h1: "一级标题", h2: "二级标题", h3: "三级标题", h4: "四级标题", h5: "五级标题", h6: "六级标题", quote: "引用", callout: "高亮块", code: "代码块", bullet: "无序列表", ordered: "有序列表", todo: "待办清单" };
  const blockMenuSelectionCount = blockMenu?.listHierarchy?.sourceIds.length ?? blockMenu?.indices.length ?? 0;
  const blockMenuModel = blockMenu ? buildBlockMenuInformationArchitecture({
    canConvert: blockMenu.canConvert,
    currentType: blockMenu.currentType,
    selectionCount: blockMenuSelectionCount,
    lang,
    listHierarchyAvailability: blockMenu.listHierarchy?.availability,
  }) : null;
  const contentBlockActions: Array<[BlockAction, string, boolean, string]> = blockMenu ? [
    ...(blockMenu.canImageSideBySide ? [["image-side-by-side", blockLabels.imageSideBySide, false, ""] as [BlockAction, string, boolean, string]] : []),
    ["copy", blockLabels.copy, false, "⌘C"],
    ["duplicate", blockLabels.duplicate, false, "⌘D"],
    ["move-up", blockLabels.moveUp, !blockMenu.canMoveUp, "⌘⇧↑"],
    ["move-down", blockLabels.moveDown, !blockMenu.canMoveDown, "⌘⇧↓"],
  ] : [];
  const hierarchyBlockActions: Array<[BlockAction, string, boolean, string]> = blockMenuModel?.listHierarchyActions.map((action) => [
    action.id === "lift" ? "list-lift" : "list-sink",
    action.id === "lift" ? blockLabels.lift : blockLabels.sink,
    !action.enabled,
    action.reason ?? "",
  ]) ?? [];
  const convertBlockActions: Array<[BlockAction, string]> = blockMenu?.canConvert ? [
    ["text", blockLabels.text], ["h1", blockLabels.h1], ["h2", blockLabels.h2], ["h3", blockLabels.h3],
    ["h4", blockLabels.h4], ["h5", blockLabels.h5], ["h6", blockLabels.h6], ["quote", blockLabels.quote],
    ["callout", blockLabels.callout], ["code", blockLabels.code], ["bullet", blockLabels.bullet],
    ["ordered", blockLabels.ordered], ["todo", blockLabels.todo],
  ] : [];
  const normalizedBlockQuery = blockMenuQuery.trim().toLocaleLowerCase();
  const blockActionAliases: Partial<Record<BlockAction, string>> = {
    copy: "复制 copy", duplicate: "副本 duplicate", "move-up": "上移 move up", "move-down": "下移 move down",
    "list-lift": "提升列表层级 decrease list level outdent", "list-sink": "下沉列表层级 increase list level indent",
    "image-side-by-side": "图片并排 place images side by side gallery columns",
    delete: "删除 delete backspace", text: "正文 text paragraph", h1: "一级标题 heading 1", h2: "二级标题 heading 2",
    h3: "三级标题 heading 3", h4: "四级标题 heading 4", h5: "五级标题 heading 5", h6: "六级标题 heading 6",
    quote: "引用 quote", callout: "高亮块 提示框 callout note", code: "代码 code", bullet: "无序列表 bullet",
    ordered: "有序列表 numbered ordered", todo: "待办清单 todo task",
  };
  const matchesBlockQuery = (action: BlockAction, label: string, shortcut = "") => !normalizedBlockQuery
    || `${label} ${shortcut} ${blockActionAliases[action] ?? ""}`.toLocaleLowerCase().includes(normalizedBlockQuery);
  const visibleContentBlockActions = contentBlockActions.filter(([action, label, , shortcut]) => matchesBlockQuery(action, label, shortcut));
  const visibleHierarchyBlockActions = hierarchyBlockActions.filter(([action, label, , reason]) => matchesBlockQuery(action, label, reason));
  const visibleConvertBlockActions = convertBlockActions.filter(([action, label]) => matchesBlockQuery(action, label));
  const shortcutConversionIds = new Set(blockMenuModel?.conversionShortcuts.map((item) => item.id) ?? []);
  const visibleConversionShortcuts = visibleConvertBlockActions.filter(([action]) => shortcutConversionIds.has(action as ConvertibleBlockType));
  const belowInsertCommands = blockMenuInsertCommands(getInsertCommandRegistry("browse"))
    .filter((command) => isInsertCommandAvailable(command, { image: true, table: true, math: true }));
  const visibleBelowInsertCommands = belowInsertCommands.filter((command) => !normalizedBlockQuery
    || `${command.label[lang]} ${command.label[lang === "en" ? "zh" : "en"]} ${command.id}`.toLocaleLowerCase().includes(normalizedBlockQuery));
  const groupedBelowInsertCommands = (["basic", "list", "media", "structure", "callout"] as const)
    .map((category) => ({
      category,
      commands: visibleBelowInsertCommands.filter((command) => command.browse.category === category),
    }))
    .filter((group) => group.commands.length > 0);
  const deleteActionVisible = matchesBlockQuery("delete", blockLabels.remove, "Delete Backspace");
  const structureNoteVisible = visibleHierarchyBlockActions.length > 0 || !normalizedBlockQuery
    || (blockMenuModel?.structureNote.toLocaleLowerCase().includes(normalizedBlockQuery) ?? false);
  const blockMenuHasResults = visibleContentBlockActions.length > 0 || structureNoteVisible
    || visibleConvertBlockActions.length > 0 || visibleBelowInsertCommands.length > 0 || deleteActionVisible;
  const slashResults = slashInsertMenu ? searchInsertCommands(slashInsertMenu.query, lang) : [];
  const slashStatus = slashInsertMenu ? insertMenuStatus(slashInsertMenu.query, slashResults.length, lang) : null;
  const browseCategoryLabels: Record<InsertCommandBrowseCategory, string> = lang === "en"
    ? { basic: "Basics", list: "Lists", media: "Media & attachments", structure: "Structure & data", callout: "Callouts" }
    : { basic: "基础", list: "列表", media: "媒体与附件", structure: "结构与数据", callout: "提示" };
  const groupedSlashResults = (["basic", "list", "media", "structure", "callout"] as const)
    .map((category) => ({ category, commands: slashResults.filter((command) => command.category === category) }))
    .filter((group) => group.commands.length > 0);
  const browseCommands = getInsertCommandRegistry("browse").filter((command) => isInsertCommandAvailable(
    command,
    { image: true, table: true, math: true },
  ));
  const browseModel = buildBrowseInsertMenu(browseCommands);
  const closeBrowseInsertMenu = () => {
    updateTableSizePicker(null);
    updateBrowseInsertMenu(null);
    restoreEditorFocus();
  };
  const selectTableSize = (size: TableSize) => {
    const picker = tableSizePickerStateRef.current;
    if (!picker) return;
    if (picker.source === "below") {
      const tableCommand = getInsertCommandRegistry("browse").find((command) => command.id === "table");
      if (tableCommand) insertBlockBelow(tableCommand, size);
      return;
    }
    executeInsertCommandRef.current("table", picker.source, picker.pos, size);
  };
  const cancelTableSizePicker = () => {
    const source = tableSizePickerStateRef.current?.source;
    updateTableSizePicker(null);
    const container = source === "slash"
      ? slashInsertMenuRef.current
      : source === "browse"
        ? browseInsertMenuRef.current
        : blockMenuRef.current;
    container?.querySelector<HTMLElement>('[data-insert-command="table"]')?.focus({ preventScroll: true });
  };
  const renderTableSizePicker = (source: TableSizePickerState["source"]) => tableSizePicker?.source === source ? (
    <TableSizePicker
      lang={lang}
      value={tableSizePicker.value}
      onChange={(value) => updateTableSizePicker({ ...tableSizePicker, value })}
      onSelect={selectTableSize}
      onCancel={cancelTableSizePicker}
    />
  ) : null;
  const onBrowseInsertMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented) return;
    if (event.key === "Escape") {
      event.preventDefault();
      closeBrowseInsertMenu();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Home" && event.key !== "End") return;
    const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]'));
    if (buttons.length === 0) return;
    event.preventDefault();
    const current = Math.max(0, buttons.indexOf(document.activeElement as HTMLButtonElement));
    const next = moveInsertMenuActiveIndex(current, event.key, buttons.length);
    buttons[next]?.focus({ preventScroll: true });
  };

  return (
    <div className={`editor-canvas${headingOutlineOpen ? " has-outline-open" : ""}`}>
      <div id="omia-block-state-status" className="editor-block-state-status" role="status" aria-live="polite" />
      <div ref={ref} className={`milkdown-host h-full overflow-auto ${lang === "en" ? "lang-en" : "lang-zh"}`} />
      {
        <div className={`editor-heading-outline${headingOutlineOpen ? " is-open" : ""}`}>
          <button
            type="button"
            className="editor-heading-outline__toggle"
            aria-label={lang === "en" ? "Outline" : "目录"}
            aria-expanded={headingOutlineOpen}
            aria-controls="omia-heading-outline-list"
            onClick={() => setHeadingOutlineOpen((current) => !current)}
          >
            <span aria-hidden="true">☷</span>
            {lang === "en" ? "Outline" : "目录"}
            <small>{headingOutline.length}</small>
          </button>
          {headingOutlineOpen && (
            <nav id="omia-heading-outline-list" aria-label={lang === "en" ? "Document outline" : "文档目录"}>
              <header>
                <strong>{lang === "en" ? "Document outline" : "文档目录"}</strong>
                <span>{lang === "en" ? "Derived from headings" : "根据标题实时生成"}</span>
              </header>
              {headingOutline.length === 0 && <p className="editor-heading-outline__empty">{lang === "en" ? "Add headings to build an outline" : "添加标题后会显示目录"}</p>}
              <ol>
                {headingOutline.map((entry) => (
                  <li key={entry.id} data-level={entry.level} data-folded={foldedSections.includes(entry.pos) ? "true" : undefined}>
                    <div>
                      <button className="editor-heading-outline__navigate" type="button" onClick={() => navigateToHeading(entry)} title={entry.text}>
                        <span aria-hidden="true">H{entry.level}</span>
                        <strong>{entry.text}</strong>
                      </button>
                      <button
                        className="editor-heading-outline__fold"
                        type="button"
                        aria-pressed={foldedSections.includes(entry.pos)}
                        aria-label={foldedSections.includes(entry.pos)
                          ? (lang === "en" ? `Expand ${entry.text}` : `展开${entry.text}`)
                          : (lang === "en" ? `Collapse ${entry.text}` : `折叠${entry.text}`)}
                        title={foldedSections.includes(entry.pos)
                          ? (lang === "en" ? "Expand section" : "展开章节")
                          : (lang === "en" ? "Collapse section" : "折叠章节")}
                        onClick={() => toggleHeadingSection(entry)}
                      ><span aria-hidden="true">⌄</span></button>
                    </div>
                  </li>
                ))}
              </ol>
              <footer>{lang === "en" ? "View only · resets after closing the document" : "仅当前视图 · 关闭文档后重置"}</footer>
            </nav>
          )}
        </div>
      }
      {notice && <div className={`editor-notice is-${notice.kind}`} role="status"><span />{notice.text}</div>}
      {slashInsertMenu && slashStatus && (
        <div
          ref={slashInsertMenuRef}
          id="omia-slash-command-menu"
          className="editor-insert-menu editor-slash-insert-menu"
          role="listbox"
          aria-label={slashStatus.label}
          aria-describedby="omia-slash-command-status"
          data-placement={slashInsertMenu.placement}
          style={{ left: slashInsertMenu.left, top: slashInsertMenu.top }}
          onMouseDown={(event) => event.preventDefault()}
        >
          <header className="editor-insert-menu__search-head">
            <span className="editor-insert-menu__slash" aria-hidden="true">/</span>
            <div>
              <strong>{slashInsertMenu.query || (lang === "en" ? "Search commands" : "搜索命令")}</strong>
              <span>{lang === "en" ? "Type to filter blocks" : "继续输入可筛选区块"}</span>
            </div>
            <output id="omia-slash-command-status" aria-live="polite">{slashStatus.status}</output>
          </header>
          <div className="editor-insert-menu__results">
            {groupedSlashResults.map((group) => (
              <section key={group.category} role="group" aria-label={browseCategoryLabels[group.category]}>
                <h3>{browseCategoryLabels[group.category]}</h3>
                {group.commands.map((command) => {
                  const index = slashResults.indexOf(command);
                  const selected = index === slashInsertMenu.activeIndex;
                  return (
                    <button
                      key={command.id}
                      id={`omia-slash-command-${command.id}`}
                      type="button"
                      role="option"
                      data-insert-command={command.id}
                      aria-haspopup={command.id === "table" ? "grid" : undefined}
                      aria-expanded={command.id === "table" ? tableSizePicker?.source === "slash" : undefined}
                      aria-selected={selected}
                      onPointerEnter={() => updateSlashInsertMenu({ ...slashInsertMenu, activeIndex: index })}
                      onMouseUp={(event) => {
                        if (event.button !== 0) return;
                        const target = event.currentTarget;
                        target.dataset.pointerActivated = "true";
                        window.setTimeout(() => { delete target.dataset.pointerActivated; }, 0);
                        executeInsertCommandRef.current(command.id, "slash");
                      }}
                      onClick={(event) => {
                        if (event.currentTarget.dataset.pointerActivated === "true") {
                          delete event.currentTarget.dataset.pointerActivated;
                          return;
                        }
                        executeInsertCommandRef.current(command.id, "slash");
                      }}
                    >
                      <InsertCommandMark command={command} />
                      <span><strong>{command.label[lang]}</strong><small>{command.label[lang === "en" ? "zh" : "en"]}</small></span>
                      <kbd>{command.search.initials}</kbd>
                    </button>
                  );
                })}
              </section>
            ))}
            {slashResults.length === 0 && <div className="editor-insert-menu__empty" role="status">{slashStatus.empty}</div>}
          </div>
          {renderTableSizePicker("slash")}
          <footer><span>↑↓</span>{lang === "en" ? "Navigate" : "选择"}<span>↵</span>{lang === "en" ? "Insert" : "插入"}<kbd>Esc</kbd>{lang === "en" ? "Close" : "关闭"}</footer>
        </div>
      )}
      {browseInsertMenu && (
        <>
          <div className="editor-insert-menu-scrim" aria-hidden="true" onPointerDown={closeBrowseInsertMenu} />
          <div
            ref={browseInsertMenuRef}
            className="editor-insert-menu editor-browse-insert-menu"
            role="menu"
            aria-label={lang === "en" ? "Browse insert blocks" : "浏览插入区块"}
            data-placement={browseInsertMenu.placement}
            style={{ left: browseInsertMenu.left, top: browseInsertMenu.top }}
            onKeyDown={onBrowseInsertMenuKeyDown}
          >
            <header className="editor-browse-insert-menu__head">
              <div><strong>{lang === "en" ? "Add a block" : "添加区块"}</strong><span>{lang === "en" ? "Choose a block type" : "选择要插入的区块类型"}</span></div>
              <kbd>Esc</kbd>
            </header>
            <section className="editor-browse-insert-menu__common" aria-label={lang === "en" ? "Common blocks" : "常用区块"}>
              <h3>{lang === "en" ? "Common" : "常用"}</h3>
              <div>
                {browseModel.common.map((command) => (
                  <button key={command.id} type="button" role="menuitem" data-insert-command={command.id} aria-haspopup={command.id === "table" ? "grid" : undefined} aria-expanded={command.id === "table" ? tableSizePicker?.source === "browse" : undefined} onClick={() => executeInsertCommandRef.current(command.id, "browse", browseInsertMenu.pos)}>
                    <InsertCommandMark command={command} /><span>{command.label[lang]}</span>
                  </button>
                ))}
              </div>
            </section>
            <div
              className="editor-insert-menu__results editor-browse-insert-menu__groups"
              style={{ maxHeight: browseInsertMenu.groupMaxHeight }}
            >
              {browseModel.groups.map((group) => (
                <section key={group.category} role="group" aria-label={browseCategoryLabels[group.category]}>
                  <h3>{browseCategoryLabels[group.category]}</h3>
                  {group.commands.map((command) => {
                    const index = browseCommands.indexOf(command);
                    return (
                      <button
                        key={command.id}
                        type="button"
                        role="menuitem"
                        data-insert-command={command.id}
                        aria-haspopup={command.id === "table" ? "grid" : undefined}
                        aria-expanded={command.id === "table" ? tableSizePicker?.source === "browse" : undefined}
                        aria-current={index === browseInsertMenu.activeIndex ? "true" : undefined}
                        onFocus={() => updateBrowseInsertMenu({ ...browseInsertMenu, activeIndex: index })}
                        onClick={() => executeInsertCommandRef.current(command.id, "browse", browseInsertMenu.pos)}
                      >
                        <InsertCommandMark command={command} />
                        <span><strong>{command.label[lang]}</strong><small>{command.label[lang === "en" ? "zh" : "en"]}</small></span>
                      </button>
                    );
                  })}
                </section>
              ))}
            </div>
            {renderTableSizePicker("browse")}
            <footer><span>↑↓</span>{lang === "en" ? "Navigate" : "选择"}<span>↵</span>{lang === "en" ? "Insert" : "插入"}</footer>
          </div>
        </>
      )}
      {linkToolbar && (
        <div
          ref={linkToolbarRef}
          className="editor-link-toolbar"
          role="toolbar"
          aria-label={lang === "en" ? "Link actions" : "链接操作"}
          style={{ left: linkToolbar.left, top: linkToolbar.top }}
          onPointerLeave={() => { if (!linkToolbar.editing) window.setTimeout(() => setLinkToolbar(null), 180); }}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            setLinkToolbar(null);
            restoreEditorFocus();
          }}
        >
          {linkToolbar.editing ? (
            <form onSubmit={(event) => { event.preventDefault(); saveToolbarLink(); }}>
              <input
                autoFocus
                value={linkToolbar.draft}
                onChange={(event) => setLinkToolbar({ ...linkToolbar, draft: event.target.value })}
                aria-label={lang === "en" ? "Link address" : "链接地址"}
                spellCheck={false}
              />
              <button type="submit">{lang === "en" ? "Save" : "保存"}</button>
              <button type="button" onClick={() => setLinkToolbar({ ...linkToolbar, editing: false, draft: linkToolbar.href })}>{lang === "en" ? "Cancel" : "取消"}</button>
            </form>
          ) : (
            <>
              <button type="button" onClick={openToolbarLink}>{lang === "en" ? "Open" : "打开"}</button>
              <button type="button" onClick={() => setLinkToolbar({ ...linkToolbar, editing: true, draft: linkToolbar.href })}>{lang === "en" ? "Edit" : "编辑"}</button>
              <button type="button" onClick={unlinkToolbarLink}>{lang === "en" ? "Unlink" : "取消链接"}</button>
              <button type="button" onClick={showToolbarLinkDisplay}>{lang === "en" ? "Display" : "显示方式"}</button>
            </>
          )}
        </div>
      )}
      {nodeToolbar?.kind === "table" && nodeToolbar.cellRect && (
        <div
          className="editor-table-cell-selection-overlay"
          role="status"
          aria-label={lang === "en"
            ? `Table cell ${(nodeToolbar.tableRow ?? 0) + 1}, ${(nodeToolbar.tableColumn ?? 0) + 1} selected`
            : `已选择表格第 ${(nodeToolbar.tableRow ?? 0) + 1} 行第 ${(nodeToolbar.tableColumn ?? 0) + 1} 列`}
          style={nodeToolbar.cellRect}
        />
      )}
      {nodeToolbar && (
        <div
          ref={nodeToolbarRef}
          className="editor-node-toolbar"
          role="toolbar"
          aria-label={`${nodeToolbarLabel(nodeToolbar.kind, lang)} ${lang === "en" ? "actions" : "操作"}${nodeToolbar.kind === "table" && nodeToolbar.tableContext
            ? (lang === "en"
              ? ` · ${nodeToolbar.tableContext.rowKind === "header" ? "header" : "body"} row ${nodeToolbar.tableContext.row + 1}, column ${nodeToolbar.tableContext.column + 1} · ${nodeToolbar.tableContext.alignment ?? "default"}`
              : ` · ${nodeToolbar.tableContext.rowKind === "header" ? "表头" : "正文"}第 ${nodeToolbar.tableContext.row + 1} 行，第 ${nodeToolbar.tableContext.column + 1} 列 · ${nodeToolbar.tableContext.alignment ?? "默认对齐"}`)
            : ""}`}
          style={{ left: nodeToolbar.left, top: nodeToolbar.top }}
        >
          <strong>
            {nodeToolbar.kind === "table" && nodeToolbar.tableAdvanced
              ? (lang === "en" ? "Advanced table" : "高级表格")
              : nodeToolbarLabel(nodeToolbar.kind, lang)}
            {nodeToolbar.kind === "table" && nodeToolbar.tableContext && (
              <small className="editor-node-toolbar__context">
                {lang === "en"
                  ? `${nodeToolbar.tableContext.rowKind === "header" ? "Header" : "Body"} ${nodeToolbar.tableContext.row + 1} × ${nodeToolbar.tableContext.column + 1} · ${nodeToolbar.tableContext.alignment ?? "Default"}`
                  : `${nodeToolbar.tableContext.rowKind === "header" ? "表头" : "正文"} ${nodeToolbar.tableContext.row + 1} × ${nodeToolbar.tableContext.column + 1} · ${nodeToolbar.tableContext.alignment ?? "默认"}`}
              </small>
            )}
            {nodeToolbar.kind === "table" && nodeToolbar.tableAdvanced && nodeToolbar.tableSection && nodeToolbar.tableRow != null && nodeToolbar.tableColumn != null && (
              <small className="editor-node-toolbar__context">
                {lang === "en"
                  ? `${nodeToolbar.tableSection === "head" ? "Header" : "Body"} ${nodeToolbar.tableRow + 1} × ${nodeToolbar.tableColumn + 1} · ${nodeToolbar.tableSelection?.length ?? 1} selected`
                  : `${nodeToolbar.tableSection === "head" ? "表头" : "正文"} ${nodeToolbar.tableRow + 1} × ${nodeToolbar.tableColumn + 1} · 已选 ${nodeToolbar.tableSelection?.length ?? 1} 格`}
              </small>
            )}
            {nodeToolbar.kind === "table" && nodeToolbar.tableAdvanced && nodeToolbar.tableSection && nodeToolbar.tableRow != null && nodeToolbar.tableColumn != null && (
              <small className="editor-node-toolbar__context">
                {lang === "en"
                  ? `${nodeToolbar.tableSection === "head" ? "Header" : "Body"} ${nodeToolbar.tableRow + 1} × ${nodeToolbar.tableColumn + 1} · ${nodeToolbar.tableSelection?.length ?? 1} selected`
                  : `${nodeToolbar.tableSection === "head" ? "表头" : "正文"} ${nodeToolbar.tableRow + 1} × ${nodeToolbar.tableColumn + 1} · 已选 ${nodeToolbar.tableSelection?.length ?? 1} 格`}
              </small>
            )}
          </strong>
          {nodeToolbar.mode === "layout-linearize" && nodeToolbar.kind === "layout" ? (
            <div className="editor-table-transition" role="dialog" aria-label={lang === "en" ? "Confirm remove columns" : "确认解除分栏"}>
              <span>{lang === "en"
                ? `The column structure${nodeToolbar.layoutLosses?.includes("column-widths") ? " and custom widths" : ""} will be removed. Every block remains in left-to-right, top-to-bottom reading order.`
                : `将移除分栏结构${nodeToolbar.layoutLosses?.includes("column-widths") ? "和自定义列宽" : ""}；所有块会按从左到右、列内从上到下的阅读顺序保留。`}</span>
              <button type="button" onClick={confirmPersistentLayoutDowngrade}>{lang === "en" ? "Remove columns" : "确认解除"}</button>
              <button type="button" onClick={() => setNodeToolbar({ ...nodeToolbar, mode: "actions" })}>{lang === "en" ? "Cancel" : "取消"}</button>
            </div>
          ) : nodeToolbar.mode === "table-upgrade" && nodeToolbar.kind === "table" ? (
            <div className="editor-table-transition" role="dialog" aria-label={lang === "en" ? "Confirm advanced table upgrade" : "确认升级高级表格"}>
              <span>{lang === "en"
                ? "Convert only this GFM table. Advanced widths, merged cells and complex cells become available; one Undo restores the exact GFM table."
                : "只转换当前 GFM 表格，以启用列宽、合并和复杂单元格；其他表格与正文不变，一次撤销可恢复原表格。"}</span>
              <button type="button" onClick={confirmTableTransition}>{lang === "en" ? "Upgrade this table" : "升级此表格"}</button>
              <button type="button" onClick={() => setNodeToolbar({ ...nodeToolbar, mode: "actions" })}>{lang === "en" ? "Cancel" : "取消"}</button>
            </div>
          ) : nodeToolbar.mode === "table-downgrade" && nodeToolbar.kind === "table" ? (
            <div className="editor-table-transition" role="dialog" aria-label={lang === "en" ? "Confirm GFM downgrade" : "确认降级为 GFM"}>
              <span>{nodeToolbar.tableLosses?.length
                ? (lang === "en"
                  ? `GFM cannot preserve: ${nodeToolbar.tableLosses.map((loss) => TABLE_DOWNGRADE_LOSS_LABELS[loss].en).join(", ")}. Text remains in visual order.`
                  : `GFM 无法保留：${nodeToolbar.tableLosses.map((loss) => TABLE_DOWNGRADE_LOSS_LABELS[loss].zh).join("、")}；正文将按视觉顺序保留。`)
                : (lang === "en" ? "This table can be converted to GFM without loss." : "这个表格可以无损转换为 GFM。")}</span>
              <button type="button" onClick={confirmTableTransition}>{lang === "en" ? "Confirm downgrade" : "确认降级"}</button>
              <button type="button" onClick={() => setNodeToolbar({ ...nodeToolbar, mode: "actions" })}>{lang === "en" ? "Cancel" : "取消"}</button>
            </div>
          ) : nodeToolbar.mode === "table-background" && nodeToolbar.kind === "table" ? (
            <div className="editor-advanced-table-picker" role="dialog" aria-label={lang === "en" ? "Cell background" : "单元格底色"}>
              <span>{lang === "en" ? "Cell" : "单元格"}</span>
              {(Object.keys(CONTROLLED_COLOR_TOKENS) as ControlledColorToken[]).map((token) => (
                <button
                  key={token}
                  type="button"
                  className="editor-advanced-table-picker__swatch"
                  aria-label={lang === "en" ? `${token} cell background` : `${token} 单元格底色`}
                  aria-pressed={nodeToolbar.tableCellBackground === token}
                  style={{ background: CONTROLLED_COLOR_TOKENS[token].background }}
                  onClick={() => setAdvancedTableBackground(token)}
                />
              ))}
              <button type="button" onClick={() => setAdvancedTableBackground(null)}>{lang === "en" ? "Clear" : "清除"}</button>
              <button type="button" onClick={() => setNodeToolbar({ ...nodeToolbar, mode: "actions" })}>{lang === "en" ? "Back" : "返回"}</button>
            </div>
          ) : nodeToolbar.mode === "table-block-edit" && nodeToolbar.kind === "table" ? (
            <form className="editor-advanced-table-block-edit" onSubmit={(event) => { event.preventDefault(); saveAdvancedTableBlockEdit(); }}>
              <input
                autoFocus
                value={nodeToolbar.draft}
                onChange={(event) => setNodeToolbar({ ...nodeToolbar, draft: event.target.value })}
                aria-label={lang === "en" ? "Cell block text" : "单元格块文字"}
              />
              <button type="submit">{lang === "en" ? "Save block" : "保存块"}</button>
              <button type="button" onClick={() => setNodeToolbar({ ...nodeToolbar, mode: "table-blocks", tableBlockIndex: undefined })}>{lang === "en" ? "Cancel" : "取消"}</button>
            </form>
          ) : nodeToolbar.mode === "table-blocks" && nodeToolbar.kind === "table" ? (
            <div className="editor-advanced-table-blocks" role="dialog" aria-label={lang === "en" ? "Cell blocks" : "单元格块"}>
              <div className="editor-advanced-table-blocks__list" role="list">
                {(nodeToolbar.tableCellBlocks ?? []).map((block, index, blocks) => (
                  <div role="listitem" key={`${index}:${block.kind}`}>
                    <span>{index + 1}. {block.kind}</span>
                    <button type="button" disabled={!editableAdvancedTableBlock(block)} aria-label={lang === "en" ? `Edit block ${index + 1}` : `编辑第 ${index + 1} 个块`} onClick={() => beginAdvancedTableBlockEdit(index)}>{lang === "en" ? "Edit" : "编辑"}</button>
                    <button type="button" disabled={index === 0} aria-label={lang === "en" ? `Move block ${index + 1} up` : `上移第 ${index + 1} 个块`} onClick={() => runAdvancedTableBlockOperation({ type: "move", from: index, to: index - 1 })}>↑</button>
                    <button type="button" disabled={index === blocks.length - 1} aria-label={lang === "en" ? `Move block ${index + 1} down` : `下移第 ${index + 1} 个块`} onClick={() => runAdvancedTableBlockOperation({ type: "move", from: index, to: index + 1 })}>↓</button>
                  </div>
                ))}
              </div>
              <div className="editor-advanced-table-blocks__add" role="group" aria-label={lang === "en" ? "Insert cell block" : "插入单元格块"}>
                <button type="button" onClick={() => insertAdvancedTableBlock("paragraph")}>{lang === "en" ? "Paragraph" : "段落"}</button>
                <button type="button" onClick={() => insertAdvancedTableBlock("bullet-list")}>{lang === "en" ? "List" : "列表"}</button>
                <button type="button" onClick={() => insertAdvancedTableBlock("task-list")}>{lang === "en" ? "Task" : "任务"}</button>
                <button type="button" onClick={() => insertAdvancedTableBlock("code")}>{lang === "en" ? "Code" : "代码"}</button>
              </div>
              <button type="button" onClick={() => setNodeToolbar({ ...nodeToolbar, mode: "actions" })}>{lang === "en" ? "Back" : "返回"}</button>
            </div>
          ) : nodeToolbar.mode === "language" && nodeToolbar.kind === "code" ? (
            <div className="editor-code-language-picker" role="dialog" aria-label={lang === "en" ? "Choose code language" : "选择代码语言"}>
              <input
                autoFocus
                type="search"
                value={nodeToolbar.query ?? ""}
                onChange={(event) => setNodeToolbar({ ...nodeToolbar, query: event.target.value })}
                placeholder={lang === "en" ? "Search all languages" : "搜索全部语言"}
                aria-label={lang === "en" ? "Search code languages" : "搜索代码语言"}
              />
              <div className="editor-code-language-picker__list" role="listbox">
                {filterCodeLanguages(
                  buildCodeLanguageCatalog(CODE_LANGUAGE_SOURCES, nodeToolbar.language ?? "", lang),
                  nodeToolbar.query ?? "",
                ).map((option) => (
                  <button
                    key={`${option.unknown ? "unknown" : "known"}:${option.value}`}
                    type="button"
                    role="option"
                    aria-selected={option.selected}
                    data-common={option.common ? "true" : undefined}
                    onClick={() => chooseCodeLanguage(option.value)}
                  >
                    <span>{option.label}</span>
                    {option.unknown && <small>{lang === "en" ? "Unknown · preserved" : "未知值 · 原样保留"}</small>}
                  </button>
                ))}
              </div>
              <button type="button" onClick={() => setNodeToolbar({ ...nodeToolbar, mode: "actions", query: "" })}>{lang === "en" ? "Cancel" : "取消"}</button>
            </div>
          ) : nodeToolbar.mode === "description" ? (
            <form onSubmit={(event) => { event.preventDefault(); saveImageDescription(); }}>
              <input
                autoFocus
                value={nodeToolbar.draft}
                onChange={(event) => setNodeToolbar({ ...nodeToolbar, draft: event.target.value })}
                aria-label={lang === "en" ? "Image description" : "图片描述"}
              />
              <button type="submit">{lang === "en" ? "Save" : "保存"}</button>
              <button type="button" onClick={() => setNodeToolbar({ ...nodeToolbar, mode: "actions", draft: nodeToolbar.caption ?? "" })}>{lang === "en" ? "Cancel" : "取消"}</button>
            </form>
          ) : nodeToolbar.mode === "source" ? (
            <form onSubmit={(event) => { event.preventDefault(); saveNodeToolbarSource(); }}>
              <input
                autoFocus
                value={nodeToolbar.draft}
                onChange={(event) => setNodeToolbar({ ...nodeToolbar, draft: event.target.value })}
                aria-label={nodeToolbar.kind === "image"
                  ? (lang === "en" ? "Image source" : "图片来源")
                  : (lang === "en" ? "Node source" : "节点来源")}
                spellCheck={false}
              />
              <button type="submit">{lang === "en" ? "Save" : "保存"}</button>
              <button type="button" onClick={() => setNodeToolbar({ ...nodeToolbar, mode: "actions", draft: nodeToolbar.href ?? nodeToolbar.src ?? "" })}>{lang === "en" ? "Cancel" : "取消"}</button>
            </form>
          ) : nodeToolbar.kind === "code" ? (
            CODE_TOOLBAR_ACTIONS.map((action) => (
              <button
                key={action}
                type="button"
                aria-pressed={action === "wrap" ? Boolean(nodeToolbar.wrap) : undefined}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  if (action === "language") setNodeToolbar({ ...nodeToolbar, mode: "language", query: "" });
                  else if (action === "wrap") toggleCodeWrap();
                  else void copyCurrentCode();
                }}
              >
                {action === "language"
                  ? `${codeToolbarActionLabel(action, lang)} · ${nodeToolbar.language || (lang === "en" ? "Plain Text" : "纯文本")}`
                  : codeToolbarActionLabel(action, lang)}
              </button>
            ))
          ) : nodeToolbar.kind === "layout" ? (
            nodeToolbarActionGroups("layout").map((group) => (
              <div className={`editor-node-toolbar__group is-${group.id}`} data-group={group.id} key={group.id} role="group" aria-label={nodeToolbarGroupLabel(group.id, lang)}>
                <span>{nodeToolbarGroupLabel(group.id, lang)}</span>
                {group.actions.map((action) => {
                  const model = nodeToolbar.layoutModel;
                  const count = model?.columns.length as 2 | 3 | undefined;
                  const preset = action === "layout-left-wide" ? "left-wide"
                    : action === "layout-equal" ? "equal"
                      : action === "layout-right-wide" ? "right-wide" : null;
                  const pressed = action === "layout-two" ? count === 2
                    : action === "layout-three" ? count === 3
                      : preset && count && model
                        ? persistentLayoutPresetWidths(count, preset).every((width, index) => width === model.widths[index])
                        : undefined;
                  return (
                    <button
                      key={action}
                      type="button"
                      aria-pressed={pressed}
                      className={action === "delete" ? "is-danger" : undefined}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => runNodeToolbarAction(action)}
                    >{nodeToolbarActionLabel(action, lang)}</button>
                  );
                })}
              </div>
            ))
          ) : nodeToolbar.kind === "table" ? (
            nodeToolbar.tableAdvanced ? (
              <>
                <div className="editor-node-toolbar__group is-selection" data-group="selection" role="group" aria-label={lang === "en" ? "Selection" : "选区"}>
                  <span>{lang === "en" ? "Selection" : "选区"}</span>
                  <button
                    type="button"
                    disabled={!nodeToolbar.tableCanMerge}
                    title={!nodeToolbar.tableCanMerge && nodeToolbar.tableMergeReason
                      ? (ADVANCED_TABLE_MERGE_REASON_LABELS[nodeToolbar.tableMergeReason]?.[lang] ?? nodeToolbar.tableMergeReason)
                      : undefined}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={mergeAdvancedTableSelection}
                  >{lang === "en" ? "Merge" : "合并"}</button>
                  <button type="button" disabled={!nodeToolbar.tableCanSplit} onMouseDown={(event) => event.preventDefault()} onClick={splitAdvancedTableSelection}>
                    {lang === "en" ? "Split" : "拆分"}
                  </button>
                </div>
                <div className="editor-node-toolbar__group is-style" data-group="style" role="group" aria-label={lang === "en" ? "Style" : "样式"}>
                  <span>{lang === "en" ? "Style" : "样式"}</span>
                  <button type="button" disabled={!nodeToolbar.tableSelection?.length} onMouseDown={(event) => event.preventDefault()} onClick={() => setNodeToolbar({ ...nodeToolbar, mode: "table-background" })}>
                    {lang === "en" ? "Background" : "底色"}
                  </button>
                </div>
                <div className="editor-node-toolbar__group is-cell" data-group="cell" role="group" aria-label={lang === "en" ? "Cell content" : "单元格内容"}>
                  <span>{lang === "en" ? "Cell" : "单元格"}</span>
                  <button type="button" disabled={!nodeToolbar.tableCellBlocks} onMouseDown={(event) => event.preventDefault()} onClick={() => setNodeToolbar({ ...nodeToolbar, mode: "table-blocks" })}>
                    {lang === "en" ? "Blocks" : "块"}
                  </button>
                </div>
                <div className="editor-node-toolbar__group is-more" data-group="more" role="group" aria-label={lang === "en" ? "More" : "更多"}>
                  <span>{lang === "en" ? "More" : "更多"}</span>
                  <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={beginTableDowngrade}>
                    {lang === "en" ? "Convert to GFM" : "降级为 GFM"}
                  </button>
                </div>
                <div className="editor-node-toolbar__group is-danger" data-group="danger" role="group" aria-label={lang === "en" ? "Danger" : "危险操作"}>
                  <span>{lang === "en" ? "Danger" : "危险"}</span>
                  <button type="button" className="is-danger" onMouseDown={(event) => event.preventDefault()} onClick={() => runNodeToolbarAction("delete")}>
                    {nodeToolbarActionLabel("delete", lang)}
                  </button>
                </div>
              </>
            ) : (
              <>
                <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={beginTableUpgrade}>
                  {lang === "en" ? "Advanced table" : "升级为高级表格"}
                </button>
                {nodeToolbarActionGroups("table").map((group) => (
                  <div className={`editor-node-toolbar__group is-${group.id}`} data-group={group.id} key={group.id} role="group" aria-label={nodeToolbarGroupLabel(group.id, lang)}>
                    <span>{nodeToolbarGroupLabel(group.id, lang)}</span>
                    {group.actions.map((action) => {
                      const context = nodeToolbar.tableContext;
                      const disabled = !context || (action === "row-before" && !context.canInsertRowBefore)
                        || (action === "delete-row" && !context.canDeleteRow)
                        || (action === "delete-column" && !context.canDeleteColumn);
                      const alignment = action.startsWith("align-") ? action.slice("align-".length) : null;
                      return (
                        <button
                          key={action}
                          type="button"
                          disabled={disabled}
                          aria-pressed={alignment ? context?.alignment === alignment : undefined}
                          className={action === "delete" ? "is-danger" : undefined}
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={() => runNodeToolbarAction(action)}
                        >{nodeToolbarActionLabel(action, lang)}</button>
                      );
                    })}
                  </div>
                ))}
              </>
            )
          ) : (
            nodeToolbarActions(nodeToolbar.kind).map((action) => (
              <button
                key={action}
                type="button"
                className={action === "delete" ? "is-danger" : undefined}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => runNodeToolbarAction(action)}
              >{nodeToolbarActionLabel(action, lang)}</button>
            ))
          )}
          <button type="button" className="editor-node-toolbar__close" onClick={() => closeNodeToolbar(true)} aria-label={lang === "en" ? "Close node actions" : "关闭节点操作"}>×</button>
        </div>
      )}
      {linkDisplayPicker && (
        <>
          <div className="editor-link-display-scrim" aria-hidden="true" onPointerDown={() => closeLinkDisplayPicker()} />
          <div
            ref={linkDisplayPickerRef}
            className="editor-link-display-picker"
            role="dialog"
            aria-label={lang === "en" ? "Choose link display" : "选择链接显示方式"}
            aria-busy={linkDisplayPicker.loading}
            style={{ left: linkDisplayPicker.left, top: linkDisplayPicker.top }}
          >
            <header>
              <strong>{lang === "en" ? "Show as" : "显示为"}</strong>
              <span>{linkDomainFallback(linkDisplayPicker.href)}</span>
              <kbd>Esc</kbd>
            </header>
            <div className="editor-link-display-picker__options">
              <button type="button" disabled={linkDisplayPicker.loading} onClick={() => void chooseLinkDisplay("url")}>
                <span aria-hidden="true">↗</span><strong>{lang === "en" ? "URL" : "网址"}</strong><small>{lang === "en" ? "Portable link" : "可移植链接"}</small>
              </button>
              <button type="button" disabled={linkDisplayPicker.loading} onClick={() => void chooseLinkDisplay("title")}>
                <span aria-hidden="true">Aa</span><strong>{lang === "en" ? "Title link" : "标题链接"}</strong><small>{linkDisplayPicker.loading ? (lang === "en" ? "Getting title…" : "正在获取标题…") : (lang === "en" ? "Fallbacks to domain" : "失败时保留域名")}</small>
              </button>
              <button type="button" disabled={linkDisplayPicker.loading || !linkDisplayPicker.canBookmark} onClick={() => void chooseLinkDisplay("bookmark")}>
                <span aria-hidden="true">▰</span><strong>{lang === "en" ? "Web bookmark" : "网页书签"}</strong><small>{linkDisplayPicker.canBookmark ? (lang === "en" ? "Existing Omia block" : "复用现有 Omia 区块") : (lang === "en" ? "Standalone links only" : "仅独立链接可用")}</small>
              </button>
            </div>
          </div>
        </>
      )}
      {richLinkDialog && (
        <>
          <div className="editor-rich-link-scrim" onPointerDown={closeRichLinkDialog} aria-hidden="true" />
          <form className="editor-rich-link-dialog" role="dialog" aria-modal="true" aria-labelledby="editor-rich-link-title" onSubmit={submitRichLink}>
            <header>
              <div className={`editor-rich-link-dialog__icon is-${richLinkDialog.kind}`} dangerouslySetInnerHTML={{ __html: richLinkIcon(richLinkDialog.kind) }} />
              <div>
                <strong id="editor-rich-link-title">{{
                  bookmark: lang === "en" ? "Add web bookmark" : "添加网页书签",
                  audio: lang === "en" ? "Add audio" : "添加音频",
                  video: lang === "en" ? "Add video" : "添加视频",
                  file: lang === "en" ? "Add file" : "添加文件",
                }[richLinkDialog.kind]}</strong>
                <span>{lang === "en" ? "Portable Markdown block" : "可移植的 Markdown 区块"}</span>
              </div>
              <button type="button" className="editor-rich-link-dialog__close" onClick={closeRichLinkDialog} aria-label={lang === "en" ? "Close" : "关闭"}>×</button>
            </header>
            <label>
              <span>{richLinkDialog.kind === "bookmark" ? (lang === "en" ? "Web address" : "网页地址") : (lang === "en" ? "URL or file path" : "网址或文件路径")}</span>
              <div className="editor-rich-link-dialog__url-row">
                <input
                  ref={richLinkUrlRef}
                  type="text"
                  value={richLinkDialog.url}
                  onChange={(event) => setRichLinkDialog({ ...richLinkDialog, url: event.target.value, error: "" })}
                  placeholder={richLinkDialog.kind === "bookmark" ? "https://example.com" : "https://… / media/file.ext"}
                  autoComplete="off"
                  spellCheck={false}
                  aria-invalid={Boolean(richLinkDialog.error)}
                />
                {richLinkDialog.kind !== "bookmark" && <button type="button" className="editor-rich-link-dialog__browse" onClick={() => void chooseRichLinkFile()}>{lang === "en" ? "Browse" : "选择"}</button>}
              </div>
            </label>
            <label>
              <span>{lang === "en" ? "Label (optional)" : "显示名称（可选）"}</span>
              <input
                type="text"
                value={richLinkDialog.label}
                onChange={(event) => setRichLinkDialog({ ...richLinkDialog, label: event.target.value, error: "" })}
                placeholder={lang === "en" ? "Use the site or file name when empty" : "留空时使用网站或文件名"}
              />
            </label>
            {richLinkDialog.error && <div className="editor-rich-link-dialog__error" role="alert">{richLinkDialog.error}</div>}
            <footer>
              <span>{lang === "en" ? "Esc to cancel" : "Esc 取消"}</span>
              <button type="button" onClick={closeRichLinkDialog}>{lang === "en" ? "Cancel" : "取消"}</button>
              <button type="submit" className="is-primary">{lang === "en" ? "Insert block" : "插入区块"}</button>
            </footer>
          </form>
        </>
      )}
      {blockMenu && (
        <>
          <div className="editor-block-menu-scrim" onPointerDown={closeBlockMenu} onWheel={closeBlockMenu} aria-hidden="true" />
          <div
            ref={blockMenuRef}
            className="editor-block-menu"
            role="menu"
            aria-label={blockMenuSelectionCount > 1
              ? (lang === "en" ? `${blockMenuSelectionCount} selected blocks` : `${blockMenuSelectionCount} 个已选区块`)
              : (lang === "en" ? "Block actions" : "区块操作")}
            style={{ left: blockMenu.left, top: blockMenu.top }}
            onKeyDown={onBlockMenuKeyDown}
          >
            <div className="editor-block-menu__head">
              <strong>{blockMenuSelectionCount > 1
                ? (lang === "en" ? `${blockMenuSelectionCount} blocks` : `${blockMenuSelectionCount} 个区块`)
                : blockLabels.title}</strong>
              <span>{blockMenuModel?.scope}</span>
            </div>
            {visibleConvertBlockActions.length > 0 && (
              <div className="editor-block-menu__section editor-block-menu__convert" data-block-menu-zone="convert">
                <span>{blockLabels.turnInto}</span>
                {visibleConversionShortcuts.length > 0 && <div className="editor-block-menu__convert-shortcuts">
                  {visibleConversionShortcuts.map(([action, label]) => {
                    const current = blockMenuModel?.conversions.find((item) => item.id === action)?.current ?? false;
                    return (
                      <button
                        key={action}
                        className={`editor-block-menu__convert-item${current ? " is-current" : ""}`}
                        data-block-action={action}
                        role="menuitemradio"
                        aria-checked={current}
                        aria-current={current ? "true" : undefined}
                        title={label}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => runBlockAction(action)}
                      >
                        <BlockActionIcon action={action} /><span>{label}</span>
                      </button>
                    );
                  })}
                </div>}
                <div className="editor-block-menu__convert-list">
                  {visibleConvertBlockActions.map(([action, label]) => {
                    const current = blockMenuModel?.conversions.find((item) => item.id === action)?.current ?? false;
                    return (
                      <button
                        key={action}
                        className={current ? "is-current" : undefined}
                        data-block-action={action}
                        role="menuitemradio"
                        aria-checked={current}
                        aria-current={current ? "true" : undefined}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => runBlockAction(action)}
                      >
                        <BlockActionIcon action={action} /><span>{label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
            <label className="editor-block-menu__search">
              <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="8.7" cy="8.7" r="5"/><path d="m12.4 12.4 4 4"/></svg>
              <input
                type="search"
                value={blockMenuQuery}
                onChange={(event) => setBlockMenuQuery(event.target.value)}
                onCompositionStart={() => { imeComposingRef.current = true; }}
                onCompositionEnd={() => {
                  imeComposingRef.current = false;
                  lastImeCompositionEndAtRef.current = performance.now();
                }}
                placeholder={blockLabels.search}
                aria-label={blockLabels.search}
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            {structureNoteVisible && <div className="editor-block-menu__section editor-block-menu__structure" data-block-menu-zone="structure">
              <span>{blockLabels.structure}</span>
              <small>{blockMenuModel?.structureNote}</small>
              {visibleHierarchyBlockActions.length > 0 && <div className="editor-block-menu__grid">
                {visibleHierarchyBlockActions.map(([action, label, disabled, reason]) => (
                  <button
                    key={action}
                    data-block-action={action}
                    role="menuitem"
                    disabled={disabled}
                    title={disabled ? reason : undefined}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => runBlockAction(action)}
                  >
                    <BlockActionIcon action={action} /><span>{label}</span>
                  </button>
                ))}
              </div>}
            </div>}
            {visibleContentBlockActions.length > 0 && <div className="editor-block-menu__section editor-block-menu__content" data-block-menu-zone="content">
              <span>{blockLabels.content}</span>
              <div className="editor-block-menu__grid">
                {visibleContentBlockActions.map(([action, label, disabled, shortcut]) => (
                  <button key={action} data-block-action={action} role="menuitem" disabled={disabled} onMouseDown={(event) => event.preventDefault()} onClick={() => runBlockAction(action)}>
                    <BlockActionIcon action={action} /><span>{label}</span><kbd>{shortcut}</kbd>
                  </button>
                ))}
              </div>
            </div>}
            {visibleBelowInsertCommands.length > 0 && <div className="editor-block-menu__section editor-block-menu__insert" data-block-menu-zone="insert">
              <span>{blockLabels.addBelow}</span>
              <div className="editor-block-menu__insert-tree">
                {groupedBelowInsertCommands.map((group) => (
                  <section key={group.category} role="group" aria-label={browseCategoryLabels[group.category]}>
                    <h3>{browseCategoryLabels[group.category]}</h3>
                    <div className="editor-block-menu__insert-grid">
                      {group.commands.map((command) => (
                        <button key={command.id} role="menuitem" data-insert-command={command.id} aria-haspopup={command.id === "table" ? "grid" : undefined} aria-expanded={command.id === "table" ? tableSizePicker?.source === "below" : undefined} title={command.label[lang]} onMouseDown={(event) => event.preventDefault()} onClick={() => insertBlockBelow(command)}>
                          <InsertCommandMark command={command} /><span>{command.label[lang]}</span>
                        </button>
                      ))}
                    </div>
                  </section>
                ))}
              </div>
              {renderTableSizePicker("below")}
            </div>}
            {!blockMenuHasResults && <div className="editor-block-menu__empty" role="status">{blockLabels.empty}</div>}
            {deleteActionVisible && <div className="editor-block-menu__danger" data-block-menu-zone="danger">
              <button data-block-action="delete" role="menuitem" onMouseDown={(event) => event.preventDefault()} onClick={() => runBlockAction("delete")}>
                <BlockActionIcon action="delete" /><span>{blockLabels.remove}</span><kbd>⌫</kbd>
              </button>
            </div>}
          </div>
        </>
      )}
    </div>
  );
});
