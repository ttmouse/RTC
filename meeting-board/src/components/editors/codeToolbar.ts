import type { Node as ProseNode } from "@milkdown/kit/prose/model";
import type { EditorState, Transaction } from "@milkdown/kit/prose/state";

export type CodeTargetToken = {
  pos: number;
  nodeSize: number;
  revision: number;
};

export type CodeToolbarAction = "language" | "wrap" | "copy";
export const CODE_TOOLBAR_ACTIONS = ["language", "wrap", "copy"] as const satisfies readonly CodeToolbarAction[];

const CODE_ACTION_LABELS: Record<CodeToolbarAction, { zh: string; en: string }> = {
  language: { zh: "语言", en: "Language" },
  wrap: { zh: "自动换行", en: "Wrap" },
  copy: { zh: "复制代码", en: "Copy code" },
};

export function codeToolbarActionLabel(action: CodeToolbarAction, lang: "zh" | "en"): string {
  return CODE_ACTION_LABELS[action][lang];
}

export function resolveCodeSurfaceIntent(input: {
  insideCode: boolean;
  hasTextSelection: boolean;
}): "selection-toolbar" | "code-toolbar" | null {
  if (!input.insideCode) return null;
  return input.hasTextSelection ? "selection-toolbar" : "code-toolbar";
}

export type CodeLanguageSource = {
  name: string;
  alias?: readonly string[];
  extensions?: readonly string[];
};

export type CodeLanguageOption = {
  value: string;
  label: string;
  search: string;
  common: boolean;
  selected: boolean;
  unknown?: boolean;
};

const COMMON_LANGUAGE_ORDER = [
  "JavaScript", "TypeScript", "Python", "Java", "C", "C++", "C#", "Go", "Rust",
  "HTML", "CSS", "JSON", "Markdown", "Shell", "SQL", "YAML",
] as const;

function normalized(value: string): string {
  return value.trim().toLocaleLowerCase();
}

export function buildCodeLanguageCatalog(
  sources: readonly CodeLanguageSource[],
  currentLanguage: string,
  lang: "zh" | "en",
): readonly CodeLanguageOption[] {
  const current = normalized(currentLanguage);
  const sourceByName = new Map<string, CodeLanguageSource>();
  for (const source of sources) {
    if (!source.name.trim() || sourceByName.has(normalized(source.name))) continue;
    sourceByName.set(normalized(source.name), source);
  }
  const commonNames = new Set(COMMON_LANGUAGE_ORDER.map(normalized));
  const ordered: CodeLanguageSource[] = [];
  for (const common of COMMON_LANGUAGE_ORDER) {
    const source = sourceByName.get(normalized(common));
    if (source) ordered.push(source);
  }
  for (const source of sources) {
    if (sourceByName.get(normalized(source.name)) !== source || ordered.includes(source)) continue;
    ordered.push(source);
  }

  const matchesCurrent = (source: CodeLanguageSource) => [source.name, ...(source.alias ?? [])]
    .some((value) => normalized(value) === current);
  const knownCurrent = !current || ordered.some(matchesCurrent);
  const options: CodeLanguageOption[] = ordered.map((source) => ({
    value: source.name,
    label: source.name,
    search: [source.name, ...(source.alias ?? []), ...(source.extensions ?? [])].join(" ").toLocaleLowerCase(),
    common: commonNames.has(normalized(source.name)),
    selected: matchesCurrent(source),
  }));
  const plain: CodeLanguageOption = {
    value: "",
    label: lang === "en" ? "Plain Text" : "纯文本",
    search: "plain text plaintext txt text 纯文本 文本",
    common: true,
    selected: !current,
  };
  if (!knownCurrent) {
    return [{
      value: currentLanguage,
      label: currentLanguage,
      search: currentLanguage.toLocaleLowerCase(),
      common: true,
      selected: true,
      unknown: true,
    }, plain, ...options];
  }
  return [plain, ...options];
}

export function filterCodeLanguages(
  catalog: readonly CodeLanguageOption[],
  query: string,
): readonly CodeLanguageOption[] {
  const needle = normalized(query);
  if (!needle) return catalog;
  return catalog.filter((option) => option.search.includes(needle) || normalized(option.label).includes(needle));
}

export function createCodeTargetToken(
  state: EditorState,
  pos: number,
  revision: number,
): CodeTargetToken | null {
  const node = state.doc.nodeAt(pos);
  if (!node || node.type.name !== "code_block") return null;
  return { pos, nodeSize: node.nodeSize, revision };
}

export function resolveCodeTarget(
  state: EditorState,
  target: CodeTargetToken,
  revision: number,
): ProseNode | null {
  if (target.revision !== revision || target.pos < 0 || target.pos + target.nodeSize > state.doc.content.size) return null;
  const node = state.doc.nodeAt(target.pos);
  if (!node || node.type.name !== "code_block" || node.nodeSize !== target.nodeSize) return null;
  return node;
}

export function codeTargetOrdinal(
  state: EditorState,
  target: CodeTargetToken,
  revision: number,
): number | null {
  if (!resolveCodeTarget(state, target, revision)) return null;
  let ordinal = 0;
  let resolved: number | null = null;
  state.doc.descendants((node, pos) => {
    if (resolved != null || node.type.name !== "code_block") return;
    if (pos === target.pos) resolved = ordinal;
    ordinal += 1;
  });
  return resolved;
}

export function changeCodeLanguage(
  state: EditorState,
  target: CodeTargetToken,
  revision: number,
  language: string,
): Transaction | null {
  const node = resolveCodeTarget(state, target, revision);
  if (!node || node.attrs.language === language) return null;
  return state.tr.setNodeAttribute(target.pos, "language", language);
}

export function patchCodeFenceLanguage(
  source: string,
  targetOrdinal: number,
  language: string,
): string | null {
  if (!Number.isInteger(targetOrdinal) || targetOrdinal < 0) return null;
  const fenceLine = /^([ \t]{0,3})(`{3,}|~{3,})([^\r\n]*)(\r\n|\n|\r|$)/gm;
  let open: { marker: string; length: number } | null = null;
  let ordinal = 0;
  let match: RegExpExecArray | null;
  while ((match = fenceLine.exec(source))) {
    const marker = match[2];
    const info = match[3];
    const markerKind = marker[0];
    if (open) {
      if (markerKind === open.marker && marker.length >= open.length && info.trim() === "") open = null;
      continue;
    }
    if (ordinal === targetOrdinal) {
      const leading = info.match(/^[ \t]*/)?.[0] ?? "";
      const body = info.slice(leading.length);
      const token = body.match(/^(\S+)([\s\S]*)$/);
      const suffix = token?.[2] ?? "";
      const nextInfo = `${leading}${language}${suffix}`;
      const replacement = `${match[1]}${marker}${nextInfo}${match[4]}`;
      return source.slice(0, match.index) + replacement + source.slice(match.index + match[0].length);
    }
    ordinal += 1;
    open = { marker: markerKind, length: marker.length };
  }
  return null;
}

export function setCodeWrapView(target: HTMLElement, enabled: boolean): boolean {
  target.classList.toggle("omia-code-wrap", enabled);
  target.setAttribute("data-omia-wrap", String(enabled));
  return enabled;
}

function fallbackCopy(text: string): boolean {
  if (typeof document === "undefined") return false;
  const textarea = document.createElement("textarea");
  const previous = document.activeElement as HTMLElement | null;
  textarea.value = text;
  textarea.readOnly = true;
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);
  textarea.select();
  let copied = false;
  try {
    copied = document.execCommand("copy");
  } catch {
    copied = false;
  }
  textarea.remove();
  previous?.focus({ preventScroll: true });
  return copied;
}

export async function copyCodeText(
  text: string,
  adapters: {
    writeText?: (text: string) => Promise<void>;
    fallback?: (text: string) => boolean;
  } = {},
): Promise<{ ok: boolean; method: "clipboard" | "fallback" | "failed" }> {
  const writeText = adapters.writeText ?? (
    typeof navigator !== "undefined" && navigator.clipboard?.writeText
      ? navigator.clipboard.writeText.bind(navigator.clipboard)
      : undefined
  );
  if (writeText) {
    try {
      await writeText(text);
      return { ok: true, method: "clipboard" };
    } catch {
      // WebViews may expose clipboard.writeText but reject asynchronously.
    }
  }
  const copied = (adapters.fallback ?? fallbackCopy)(text);
  return copied ? { ok: true, method: "fallback" } : { ok: false, method: "failed" };
}
