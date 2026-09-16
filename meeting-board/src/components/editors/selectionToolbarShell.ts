import { CONTROLLED_COLOR_TOKENS, type ControlledColorToken } from "../../lib/controlledInlineFormat";
import type { ConvertibleBlockType } from "./blockUi";
import type { ControlledInlineAction, ControlledInlineSelectionState } from "./controlledInlineTransactions";
import {
  buildSelectionToolbarComposition,
  moveSelectionToolbarFocus,
  selectionBlockConversions,
  selectionBlockTypeLabel,
  type SelectionBlockTypeModel,
  type SelectionToolbarActionId,
  type SelectionToolbarMoveKey,
} from "./selectionToolbar";

const NATIVE_ACTIONS = ["bold", "italic", "strikethrough", "inline-code", "inline-formula", "link"] as const;
type NativeAction = typeof NATIVE_ACTIONS[number];
export type SelectionAlignment = "left" | "center" | "right";
export type SelectionAlignmentAction = SelectionAlignment | "increase-indent" | "decrease-indent";
export type SelectionAlignmentState = {
  current: SelectionAlignment | "mixed";
  enabled?: boolean;
  canIndent: boolean;
  canOutdent: boolean;
};

const ACTION_LABELS: Record<NativeAction | "underline" | "colors" | "more" | "clear-format", { zh: string; en: string }> = {
  bold: { zh: "加粗", en: "Bold" },
  italic: { zh: "斜体", en: "Italic" },
  underline: { zh: "下划线", en: "Underline" },
  strikethrough: { zh: "删除线", en: "Strikethrough" },
  "inline-code": { zh: "行内代码", en: "Inline code" },
  "inline-formula": { zh: "行内公式", en: "Inline formula" },
  link: { zh: "链接", en: "Link" },
  colors: { zh: "文字与背景颜色", en: "Text and background color" },
  "clear-format": { zh: "清除格式", en: "Clear formatting" },
  more: { zh: "更多", en: "More" },
};

const TOKEN_LABELS: Record<ControlledColorToken, { zh: string; en: string }> = {
  gray: { zh: "灰色", en: "Gray" },
  red: { zh: "红色", en: "Red" },
  orange: { zh: "橙色", en: "Orange" },
  yellow: { zh: "黄色", en: "Yellow" },
  green: { zh: "绿色", en: "Green" },
  blue: { zh: "蓝色", en: "Blue" },
  purple: { zh: "紫色", en: "Purple" },
  "soft-gray": { zh: "浅灰", en: "Soft gray" },
  "medium-gray": { zh: "中灰", en: "Medium gray" },
  pink: { zh: "粉色", en: "Pink" },
  peach: { zh: "桃色", en: "Peach" },
  lemon: { zh: "柠檬黄", en: "Lemon" },
  mint: { zh: "薄荷绿", en: "Mint" },
  sky: { zh: "天蓝", en: "Sky" },
  lavender: { zh: "薰衣草紫", en: "Lavender" },
};

const TEXT_COLOR_TOKENS: ControlledColorToken[] = ["gray", "red", "orange", "yellow", "green", "blue", "purple"];
const BACKGROUND_COLOR_TOKENS = Object.keys(CONTROLLED_COLOR_TOKENS) as ControlledColorToken[];
const PRIMARY_TYPES: ConvertibleBlockType[] = ["text", "h1", "h2", "h3", "ordered", "bullet", "todo", "code", "quote", "callout"];
const OTHER_HEADINGS: ConvertibleBlockType[] = ["h4", "h5", "h6"];

export type SelectionToolbarShell = {
  refresh: () => void;
  closeMenus: (restoreFocus?: boolean) => void;
  dispose: () => void;
};

type Options = {
  lang: "zh" | "en";
  getTypeModel: () => SelectionBlockTypeModel;
  getFormatState: () => ControlledInlineSelectionState;
  getAlignmentState?: () => SelectionAlignmentState;
  onConvert: (target: ConvertibleBlockType) => boolean;
  onFormat: (action: ControlledInlineAction) => boolean;
  onAlign?: (action: SelectionAlignmentAction) => boolean;
  onLink?: (href: string) => boolean;
  onMenuOpen?: () => void;
};

function createButton(className: string, label: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.setAttribute("aria-label", label);
  button.title = label;
  return button;
}

function createDivider(): HTMLSpanElement {
  const divider = document.createElement("span");
  divider.className = "omia-selection-divider";
  divider.setAttribute("aria-hidden", "true");
  return divider;
}

function installMenuKeyboard(menu: HTMLElement, close: (restoreFocus?: boolean) => void): (event: KeyboardEvent) => void {
  return (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
      return;
    }
    if (!["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End", "Tab"].includes(event.key)) return;
    const buttons = Array.from(menu.querySelectorAll<HTMLButtonElement>("button:not(:disabled):not([hidden])"));
    if (buttons.length === 0) return;
    event.preventDefault();
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = moveSelectionToolbarFocus(current, event.key as SelectionToolbarMoveKey, buttons.length, event.shiftKey);
    buttons[next]?.focus({ preventScroll: true });
  };
}

function formatStateLabel(value: ControlledColorToken | "mixed" | null, lang: "zh" | "en"): string {
  if (value === "mixed") return lang === "en" ? "Mixed" : "多种颜色";
  if (!value) return lang === "en" ? "Default" : "默认";
  return TOKEN_LABELS[value][lang];
}

function blockTypeGlyph(type: ConvertibleBlockType | null): string {
  if (!type || type === "text") return "T";
  if (type.startsWith("h")) return type.toUpperCase();
  if (type === "quote") return "❞";
  if (type === "callout") return "▰";
  if (type === "code") return "{}";
  if (type === "bullet") return "•";
  if (type === "ordered") return "1.";
  return "✓";
}

function alignmentLabel(value: SelectionAlignment | "mixed", lang: "zh" | "en"): string {
  if (value === "mixed") return lang === "en" ? "Mixed alignment" : "多种对齐";
  const labels = {
    left: { zh: "左对齐", en: "Left align" },
    center: { zh: "居中对齐", en: "Center align" },
    right: { zh: "右对齐", en: "Right align" },
  } as const;
  return labels[value][lang];
}

function alignmentIcon(value: SelectionAlignment): string {
  const widths = [13, 9, 13, 7];
  const x = (width: number) => value === "left" ? 2 : value === "center" ? (16 - width) / 2 : 14 - width;
  return `<svg aria-hidden="true" viewBox="0 0 16 16">${widths.map((width, index) => `<path d="M${x(width)} ${3 + index * 3}h${width}"/>`).join("")}</svg>`;
}

export function installSelectionToolbarShell(root: ParentNode, options: Options): SelectionToolbarShell | null {
  const toolbar = root.querySelector<HTMLElement>(".milkdown-toolbar");
  if (!toolbar || toolbar.dataset.omiaSelectionShell === "true") return null;
  const nativeButtons = Array.from(toolbar.querySelectorAll<HTMLButtonElement>(":scope > button.toolbar-item")).slice(0, NATIVE_ACTIONS.length);
  if (nativeButtons.length !== NATIVE_ACTIONS.length) return null;
  toolbar.dataset.omiaSelectionShell = "true";
  nativeButtons.forEach((button, index) => {
    const action = NATIVE_ACTIONS[index]!;
    button.dataset.selectionAction = action;
    button.setAttribute("aria-label", ACTION_LABELS[action][options.lang]);
    button.title = ACTION_LABELS[action][options.lang];
  });

  const typeButton = createButton("omia-selection-type-button", options.lang === "en" ? "Block type" : "区块类型");
  typeButton.dataset.selectionAction = "block-type";
  typeButton.setAttribute("aria-haspopup", "menu");
  typeButton.setAttribute("aria-expanded", "false");
  typeButton.innerHTML = '<span class="omia-selection-type-button__glyph" aria-hidden="true">T</span><svg class="omia-selection-chevron" aria-hidden="true" viewBox="0 0 12 12"><path d="m3 4.5 3 3 3-3"/></svg>';

  const typeMenu = document.createElement("div");
  typeMenu.className = "omia-selection-type-menu";
  typeMenu.role = "menu";
  typeMenu.hidden = true;
  typeMenu.setAttribute("aria-label", options.lang === "en" ? "Convert block type" : "转换区块类型");
  const typeReason = document.createElement("p");
  typeReason.className = "omia-selection-type-menu__reason";
  typeReason.role = "status";
  typeMenu.append(typeReason);
  const typeButtons = new Map<ConvertibleBlockType, HTMLButtonElement>();
  const appendTypeButton = (target: HTMLElement, type: ConvertibleBlockType) => {
    const button = createButton("omia-selection-type-menu__item", selectionBlockTypeLabel(type, options.lang));
    button.role = "menuitem";
    button.dataset.blockType = type;
    button.innerHTML = `<span aria-hidden="true">${blockTypeGlyph(type)}</span><strong>${selectionBlockTypeLabel(type, options.lang)}</strong>`;
    button.addEventListener("pointerdown", (event) => event.preventDefault());
    button.addEventListener("click", () => { if (options.onConvert(type)) closeMenus(false); });
    typeButtons.set(type, button);
    target.append(button);
  };
  for (const type of PRIMARY_TYPES.slice(0, 4)) appendTypeButton(typeMenu, type);
  const otherHeadingsButton = createButton("omia-selection-type-menu__item has-submenu", options.lang === "en" ? "Other headings" : "其他标题");
  otherHeadingsButton.role = "menuitem";
  otherHeadingsButton.dataset.blockTypeGroup = "other-headings";
  otherHeadingsButton.innerHTML = `<span aria-hidden="true">H4</span><strong>${options.lang === "en" ? "Other headings" : "其他标题"}</strong><i aria-hidden="true">›</i>`;
  typeMenu.append(otherHeadingsButton);
  for (const type of PRIMARY_TYPES.slice(4)) appendTypeButton(typeMenu, type);
  const otherHeadings = document.createElement("div");
  otherHeadings.className = "omia-selection-type-menu__other";
  otherHeadings.role = "menu";
  otherHeadings.hidden = true;
  for (const type of OTHER_HEADINGS) appendTypeButton(otherHeadings, type);
  typeMenu.append(otherHeadings);
  otherHeadingsButton.addEventListener("pointerdown", (event) => event.preventDefault());
  otherHeadingsButton.addEventListener("click", () => {
    const opening = otherHeadings.hidden;
    otherHeadings.hidden = !opening;
    otherHeadingsButton.setAttribute("aria-expanded", String(opening));
    if (opening) requestAnimationFrame(() => {
      const menuRect = typeMenu.getBoundingClientRect();
      otherHeadings.dataset.placement = menuRect.right + 202 > window.innerWidth ? "left" : "right";
      otherHeadings.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus({ preventScroll: true });
    });
  });

  const alignmentButton = createButton("omia-selection-alignment-button", options.lang === "en" ? "Alignment" : "缩进与对齐");
  alignmentButton.dataset.selectionAction = "alignment";
  alignmentButton.setAttribute("aria-haspopup", "menu");
  alignmentButton.setAttribute("aria-expanded", "false");
  alignmentButton.innerHTML = `<span class="omia-selection-alignment-button__glyph">${alignmentIcon("left")}</span><svg class="omia-selection-chevron" aria-hidden="true" viewBox="0 0 12 12"><path d="m3 4.5 3 3 3-3"/></svg>`;
  const alignmentMenu = document.createElement("div");
  alignmentMenu.className = "omia-selection-alignment-menu";
  alignmentMenu.role = "menu";
  alignmentMenu.hidden = true;
  const alignmentButtons = new Map<SelectionAlignment, HTMLButtonElement>();
  for (const alignment of ["left", "center", "right"] as const) {
    const label = alignmentLabel(alignment, options.lang);
    const button = createButton("omia-selection-alignment-menu__item", label);
    button.role = "menuitemradio";
    button.dataset.alignment = alignment;
    button.innerHTML = `<span>${alignmentIcon(alignment)}</span><strong>${label}</strong><i aria-hidden="true">✓</i>`;
    button.addEventListener("pointerdown", (event) => event.preventDefault());
    button.addEventListener("click", () => { if (options.onAlign?.(alignment)) closeMenus(false); });
    alignmentButtons.set(alignment, button);
    alignmentMenu.append(button);
  }
  alignmentMenu.append(createDivider());
  const indentButtons = new Map<"increase" | "decrease", HTMLButtonElement>();
  for (const [id, action, zh, en, glyph] of [
    ["increase", "increase-indent", "增加缩进", "Increase indent", "→"],
    ["decrease", "decrease-indent", "减少缩进", "Decrease indent", "←"],
  ] as const) {
    const button = createButton("omia-selection-alignment-menu__item", options.lang === "en" ? en : zh);
    button.role = "menuitem";
    button.dataset.indent = id;
    button.innerHTML = `<span aria-hidden="true">${glyph}</span><strong>${options.lang === "en" ? en : zh}</strong>`;
    button.addEventListener("pointerdown", (event) => event.preventDefault());
    button.addEventListener("click", () => { if (options.onAlign?.(action)) closeMenus(false); });
    indentButtons.set(id, button);
    alignmentMenu.append(button);
  }

  const underlineButton = createButton("omia-selection-underline-button", ACTION_LABELS.underline[options.lang]);
  underlineButton.dataset.selectionAction = "underline";
  underlineButton.setAttribute("aria-pressed", "false");
  underlineButton.innerHTML = '<span aria-hidden="true">U</span>';
  underlineButton.addEventListener("pointerdown", (event) => event.preventDefault());
  underlineButton.addEventListener("click", () => { if (options.onFormat({ id: "underline" })) closeMenus(false); });

  const linkButton = createButton("omia-selection-link-button", ACTION_LABELS.link[options.lang]);
  linkButton.dataset.selectionAction = "link";
  linkButton.setAttribute("aria-haspopup", "dialog");
  linkButton.setAttribute("aria-expanded", "false");
  linkButton.innerHTML = '<svg aria-hidden="true" viewBox="0 0 20 20"><path d="M8.2 11.8 11.8 8.2M7 14.4H5.6a4 4 0 0 1 0-8H9m4 0h1.4a4 4 0 1 1 0 8H11"/></svg>';
  const linkPanel = document.createElement("form");
  linkPanel.className = "omia-selection-link-panel";
  linkPanel.setAttribute("role", "dialog");
  linkPanel.hidden = true;
  const linkInput = document.createElement("input");
  linkInput.type = "url";
  linkInput.placeholder = options.lang === "en" ? "Paste or enter a link" : "粘贴或输入链接";
  linkInput.setAttribute("aria-label", linkInput.placeholder);
  const linkConfirm = createButton("omia-selection-link-panel__confirm", options.lang === "en" ? "Confirm" : "确认");
  linkConfirm.type = "submit";
  linkConfirm.textContent = options.lang === "en" ? "Confirm" : "确认";
  linkConfirm.disabled = true;
  linkInput.addEventListener("input", () => { linkConfirm.disabled = linkInput.value.trim().length === 0; });
  linkPanel.append(linkInput, linkConfirm);

  const colorButton = createButton("omia-selection-color-button", ACTION_LABELS.colors[options.lang]);
  colorButton.dataset.selectionAction = "text-color";
  colorButton.dataset.alwaysVisible = "true";
  colorButton.setAttribute("aria-haspopup", "menu");
  colorButton.setAttribute("aria-expanded", "false");
  colorButton.innerHTML = '<span class="omia-selection-color-button__glyph" aria-hidden="true">A</span><svg class="omia-selection-chevron" aria-hidden="true" viewBox="0 0 12 12"><path d="m3 4.5 3 3 3-3"/></svg>';
  const colorMenu = document.createElement("div");
  colorMenu.className = "omia-selection-color-menu";
  colorMenu.role = "menu";
  colorMenu.hidden = true;
  colorMenu.setAttribute("aria-label", ACTION_LABELS.colors[options.lang]);
  const colorButtons = new Map<string, HTMLButtonElement>();
  for (const kind of ["text-color", "background-color"] as const) {
    const section = document.createElement("section");
    section.className = "omia-selection-color-menu__section";
    const heading = document.createElement("h3");
    heading.textContent = kind === "text-color" ? (options.lang === "en" ? "Text color" : "字体颜色") : (options.lang === "en" ? "Background color" : "背景颜色");
    section.append(heading);
    const grid = document.createElement("div");
    grid.className = "omia-selection-color-menu__grid";
    const tokens = kind === "text-color" ? TEXT_COLOR_TOKENS : BACKGROUND_COLOR_TOKENS;
    const reset = createButton("omia-selection-color-menu__swatch is-reset", `${heading.textContent}: ${options.lang === "en" ? "Default" : "默认"}`);
    reset.role = "menuitemradio";
    reset.dataset.formatKind = kind;
    reset.dataset.colorToken = "default";
    reset.innerHTML = kind === "text-color" ? '<span aria-hidden="true">A</span>' : '<span aria-hidden="true">∅</span>';
    reset.addEventListener("pointerdown", (event) => event.preventDefault());
    reset.addEventListener("click", () => { if (options.onFormat({ id: kind, token: null })) refresh(); });
    colorButtons.set(`${kind}:default`, reset);
    grid.append(reset);
    for (const token of tokens) {
      const label = TOKEN_LABELS[token][options.lang];
      const button = createButton("omia-selection-color-menu__swatch", `${heading.textContent}: ${label}`);
      button.role = "menuitemradio";
      button.dataset.formatKind = kind;
      button.dataset.colorToken = token;
      button.style.setProperty("--omia-swatch-color", kind === "text-color" ? CONTROLLED_COLOR_TOKENS[token].text : CONTROLLED_COLOR_TOKENS[token].background);
      button.innerHTML = kind === "text-color" ? '<span aria-hidden="true">A</span>' : '<span aria-hidden="true"></span>';
      button.addEventListener("pointerdown", (event) => event.preventDefault());
      button.addEventListener("click", () => { if (options.onFormat({ id: kind, token })) refresh(); });
      colorButtons.set(`${kind}:${token}`, button);
      grid.append(button);
    }
    section.append(grid);
    colorMenu.append(section);
  }
  const restoreColorButton = createButton("omia-selection-color-menu__restore", options.lang === "en" ? "Restore default" : "恢复默认");
  restoreColorButton.role = "menuitem";
  restoreColorButton.dataset.formatKind = "restore-default";
  restoreColorButton.textContent = options.lang === "en" ? "Restore default" : "恢复默认";
  restoreColorButton.addEventListener("pointerdown", (event) => event.preventDefault());
  restoreColorButton.addEventListener("click", () => { if (options.onFormat({ id: "restore-colors" })) refresh(); });
  colorMenu.append(restoreColorButton);

  const moreButton = createButton("omia-selection-more-button", ACTION_LABELS.more[options.lang]);
  moreButton.dataset.selectionAction = "more";
  moreButton.setAttribute("aria-label", options.lang === "en" ? "More selection actions" : "更多选区操作");
  moreButton.setAttribute("aria-haspopup", "menu");
  moreButton.setAttribute("aria-expanded", "false");
  moreButton.innerHTML = '<svg aria-hidden="true" viewBox="0 0 20 20"><rect x="3" y="3" width="5" height="5" rx="1"/><rect x="12" y="3" width="5" height="5" rx="1"/><rect x="3" y="12" width="5" height="5" rx="1"/><rect x="12" y="12" width="5" height="5" rx="1"/></svg>';
  const moreMenu = document.createElement("div");
  moreMenu.className = "omia-selection-more-menu";
  moreMenu.role = "menu";
  moreMenu.hidden = true;
  const proxies = new Map<NativeAction, HTMLButtonElement>();
  const formulaProxy = createButton("omia-selection-more-menu__item", ACTION_LABELS["inline-formula"][options.lang]);
  formulaProxy.role = "menuitem";
  formulaProxy.dataset.selectionAction = "inline-formula";
  formulaProxy.innerHTML = `<span class="omia-selection-more-menu__icon" aria-hidden="true">fx</span><span>${ACTION_LABELS["inline-formula"][options.lang]}</span>`;
  formulaProxy.addEventListener("pointerdown", (event) => event.preventDefault());
  formulaProxy.addEventListener("click", () => {
    nativeButtons[NATIVE_ACTIONS.indexOf("inline-formula")]?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerType: "mouse" }));
    closeMenus(true);
  });
  proxies.set("inline-formula", formulaProxy);
  moreMenu.append(formulaProxy);
  const clearFormatButton = createButton("omia-selection-more-menu__item is-clear", ACTION_LABELS["clear-format"][options.lang]);
  clearFormatButton.role = "menuitem";
  clearFormatButton.dataset.selectionAction = "clear-format";
  clearFormatButton.innerHTML = `<span class="omia-selection-more-menu__icon" aria-hidden="true">A̸</span><span>${ACTION_LABELS["clear-format"][options.lang]}</span>`;
  clearFormatButton.addEventListener("pointerdown", (event) => event.preventDefault());
  clearFormatButton.addEventListener("click", () => { if (options.onFormat({ id: "clear-format" })) closeMenus(true); });
  moreMenu.append(clearFormatButton);

  const divider1 = createDivider();
  const divider2 = createDivider();
  const divider3 = createDivider();
  toolbar.append(
    typeButton, divider1, alignmentButton, divider2,
    nativeButtons[0]!, nativeButtons[2]!, nativeButtons[1]!, underlineButton,
    linkButton, nativeButtons[3]!, colorButton, divider3, moreButton,
    nativeButtons[4]!, nativeButtons[5]!, typeMenu, alignmentMenu, linkPanel, colorMenu, moreMenu,
  );

  let lastTrigger: HTMLButtonElement = typeButton;
  const closeMenus = (restoreFocus = false) => {
    typeMenu.hidden = true;
    otherHeadings.hidden = true;
    delete otherHeadings.dataset.placement;
    alignmentMenu.hidden = true;
    linkPanel.hidden = true;
    colorMenu.hidden = true;
    moreMenu.hidden = true;
    for (const trigger of [typeButton, alignmentButton, linkButton, colorButton, moreButton]) trigger.setAttribute("aria-expanded", "false");
    otherHeadingsButton.setAttribute("aria-expanded", "false");
    if (restoreFocus) lastTrigger.focus({ preventScroll: true });
  };
  const openMenu = (menu: HTMLElement, trigger: HTMLButtonElement) => {
    const opening = menu.hidden;
    closeMenus();
    if (!opening) return;
    options.onMenuOpen?.();
    lastTrigger = trigger;
    menu.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    requestAnimationFrame(() => menu.querySelector<HTMLButtonElement>("button:not(:disabled):not([hidden])")?.focus({ preventScroll: true }));
  };
  for (const button of [typeButton, alignmentButton, linkButton, colorButton, moreButton]) button.addEventListener("pointerdown", (event) => event.preventDefault());
  typeButton.addEventListener("click", () => openMenu(typeMenu, typeButton));
  alignmentButton.addEventListener("click", () => openMenu(alignmentMenu, alignmentButton));
  linkButton.addEventListener("click", () => {
    const opening = linkPanel.hidden;
    closeMenus();
    if (!opening) return;
    options.onMenuOpen?.();
    lastTrigger = linkButton;
    linkPanel.hidden = false;
    linkButton.setAttribute("aria-expanded", "true");
    requestAnimationFrame(() => linkInput.focus({ preventScroll: true }));
  });
  linkPanel.addEventListener("pointerdown", (event) => event.stopPropagation());
  linkPanel.addEventListener("submit", (event) => {
    event.preventDefault();
    const href = linkInput.value.trim();
    if (!href || !options.onLink?.(href)) return;
    linkInput.value = "";
    linkConfirm.disabled = true;
    closeMenus(false);
  });
  linkPanel.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    closeMenus(true);
  });
  colorButton.addEventListener("click", () => openMenu(colorMenu, colorButton));
  moreButton.addEventListener("click", () => openMenu(moreMenu, moreButton));
  const menuKeyHandlers = [typeMenu, alignmentMenu, colorMenu, moreMenu].map((menu) => {
    const handler = installMenuKeyboard(menu, closeMenus);
    menu.addEventListener("keydown", handler);
    return { menu, handler };
  });
  const onOutsidePointer = (event: PointerEvent) => { if (!toolbar.contains(event.target as Node)) closeMenus(); };
  toolbar.ownerDocument.addEventListener("pointerdown", onOutsidePointer, true);

  const refresh = () => {
    const model = options.getTypeModel();
    const glyph = typeButton.querySelector<HTMLElement>(".omia-selection-type-button__glyph");
    if (glyph) glyph.textContent = blockTypeGlyph(model.currentType);
    typeButton.setAttribute("aria-label", `${options.lang === "en" ? "Block type" : "区块类型"}: ${model.label}`);
    typeButton.title = model.reason ?? model.label;
    typeReason.textContent = model.reason ?? "";
    typeReason.hidden = !model.reason;
    for (const conversion of selectionBlockConversions(model)) {
      const button = typeButtons.get(conversion.id);
      if (!button) continue;
      button.disabled = conversion.disabled;
      button.classList.toggle("is-current", conversion.current);
      if (conversion.current) button.setAttribute("aria-current", "true");
      else button.removeAttribute("aria-current");
    }
    otherHeadingsButton.disabled = !model.canConvert;
    otherHeadingsButton.classList.toggle("is-current", Boolean(model.currentType && OTHER_HEADINGS.includes(model.currentType)));

    const alignment = options.getAlignmentState?.() ?? { current: "left" as const, enabled: false, canIndent: false, canOutdent: false };
    const alignmentEnabled = alignment.enabled !== false;
    alignmentButton.disabled = !alignmentEnabled;
    alignmentButton.setAttribute("aria-label", `${options.lang === "en" ? "Alignment" : "缩进与对齐"}: ${alignmentLabel(alignment.current, options.lang)}`);
    const alignmentGlyph = alignmentButton.querySelector<HTMLElement>(".omia-selection-alignment-button__glyph");
    if (alignmentGlyph) alignmentGlyph.innerHTML = alignmentIcon(alignment.current === "mixed" ? "left" : alignment.current);
    for (const [value, button] of alignmentButtons) {
      const active = alignment.current === value;
      button.disabled = !alignmentEnabled;
      button.classList.toggle("is-current", active);
      if (active) button.setAttribute("aria-current", "true");
      else button.removeAttribute("aria-current");
      button.setAttribute("aria-checked", String(active));
    }
    indentButtons.get("increase")!.disabled = !alignmentEnabled || !alignment.canIndent;
    indentButtons.get("decrease")!.disabled = !alignmentEnabled || !alignment.canOutdent;

    const format = options.getFormatState();
    underlineButton.disabled = !format.enabled;
    linkButton.disabled = !format.enabled;
    underlineButton.classList.toggle("active", format.underline);
    underlineButton.setAttribute("aria-pressed", String(format.underline));
    colorButton.disabled = !format.enabled;
    colorButton.classList.toggle("active", Boolean(format.textColor || format.backgroundColor));
    const textToken = format.textColor && format.textColor !== "mixed" ? format.textColor : null;
    const backgroundToken = format.backgroundColor && format.backgroundColor !== "mixed" ? format.backgroundColor : null;
    colorButton.style.setProperty("--omia-selection-text-color", textToken ? CONTROLLED_COLOR_TOKENS[textToken].text : "currentColor");
    colorButton.style.setProperty("--omia-selection-background-color", backgroundToken ? CONTROLLED_COLOR_TOKENS[backgroundToken].background : "transparent");
    colorButton.setAttribute("aria-label", `${ACTION_LABELS.colors[options.lang]}: ${formatStateLabel(format.textColor, options.lang)} / ${formatStateLabel(format.backgroundColor, options.lang)}`);
    colorMenu.querySelectorAll<HTMLButtonElement>("button").forEach((button) => { button.disabled = !format.enabled; });
    for (const [kind, tokens] of [["text-color", TEXT_COLOR_TOKENS], ["background-color", BACKGROUND_COLOR_TOKENS]] as const) {
      const current = kind === "text-color" ? format.textColor : format.backgroundColor;
      for (const token of ["default", ...tokens] as const) {
        const button = colorButtons.get(`${kind}:${token}`);
        if (!button) continue;
        const active = current !== "mixed" && (token === "default" ? current == null : current === token);
        button.classList.toggle("is-current", active);
        button.setAttribute("aria-checked", String(active));
      }
    }

    const composition = buildSelectionToolbarComposition({ availableWidth: window.innerWidth });
    toolbar.dataset.selectionCompact = "false";
    const visible = new Set<SelectionToolbarActionId>(composition.visible);
    nativeButtons.forEach((button, index) => { button.hidden = !visible.has(NATIVE_ACTIONS[index]!); });
    nativeButtons[5]!.hidden = true;
    linkButton.hidden = !visible.has("link");
    alignmentButton.hidden = !visible.has("alignment");
    underlineButton.hidden = !visible.has("underline");
    colorButton.hidden = !visible.has("text-color");
    proxies.forEach((button, action) => { button.hidden = !composition.overflow.includes(action); });
    clearFormatButton.hidden = !composition.overflow.includes("clear-format");
    moreButton.hidden = !visible.has("more");
    proxies.forEach((proxy, action) => proxy.classList.toggle("active", nativeButtons[NATIVE_ACTIONS.indexOf(action)]?.classList.contains("active") ?? false));
  };
  const onResize = () => { closeMenus(); refresh(); };
  window.addEventListener("resize", onResize);
  refresh();
  return {
    refresh,
    closeMenus,
    dispose() {
      window.removeEventListener("resize", onResize);
      toolbar.ownerDocument.removeEventListener("pointerdown", onOutsidePointer, true);
      menuKeyHandlers.forEach(({ menu, handler }) => menu.removeEventListener("keydown", handler));
    },
  };
}
