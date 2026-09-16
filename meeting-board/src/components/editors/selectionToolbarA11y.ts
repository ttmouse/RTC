const TOOLBAR_ITEM_LABELS = {
  en: ["Bold", "Italic", "Strikethrough", "Inline code", "Inline formula", "Link"],
  zh: ["加粗", "斜体", "删除线", "行内代码", "行内公式", "链接"],
} as const;

const DYNAMIC_LABELS = {
  en: {
    bold: "Bold", italic: "Italic", strikethrough: "Strikethrough", "inline-code": "Inline code",
    "inline-formula": "Inline formula", link: "Link", more: "More",
  },
  zh: {
    bold: "加粗", italic: "斜体", strikethrough: "删除线", "inline-code": "行内代码",
    "inline-formula": "行内公式", link: "链接", more: "更多",
  },
} as const;

export function decorateSelectionToolbarAccessibility(root: ParentNode, lang: "en" | "zh"): number {
  const toolbar = root.querySelector<HTMLElement>(".milkdown-toolbar");
  if (!toolbar) return 0;

  toolbar.setAttribute("role", "toolbar");
  toolbar.setAttribute("aria-label", toolbar.hasAttribute("data-omia-selection-shell")
    ? (lang === "en" ? "Selection tools" : "选区工具")
    : (lang === "en" ? "Text formatting" : "文本格式"));

  const labels = TOOLBAR_ITEM_LABELS[lang];
  const buttons = Array.from(toolbar.querySelectorAll<HTMLButtonElement>("button.toolbar-item"));
  buttons.forEach((button, index) => {
    const action = button.dataset.selectionAction as keyof typeof DYNAMIC_LABELS.en | undefined;
    const label = action ? DYNAMIC_LABELS[lang][action] : labels[index];
    if (!label) return;
    button.setAttribute("aria-label", label);
    button.setAttribute("title", label);
  });
  const allButtons = Array.from(toolbar.querySelectorAll<HTMLButtonElement>("button"));
  return allButtons.filter((button) => button.hasAttribute("aria-label")).length;
}
