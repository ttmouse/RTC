import { FAILSAFE_SCHEMA, load as loadYaml } from "js-yaml";
import { classifyControlledInlineHtml } from "./controlledInlineFormat";
import { stripControlledAlignmentBlocksForSafety } from "./controlledBlockFormat";
import { stripValidAdvancedTablesForSafety } from "../components/editors/advancedTableModel";
import { stripValidPersistentLayoutsForSafety } from "../components/editors/layoutModel";

export type FrontMatterFormat = "yaml" | "toml";

export type FrontMatterBlock = {
  format: FrontMatterFormat;
  raw: string;
};

export type MarkdownDocumentParts = {
  body: string;
  frontMatter?: FrontMatterBlock;
};

export type MarkdownEditRisk =
  | "front-matter"
  | "footnotes"
  | "raw-html"
  | "toc"
  | "fence-metadata"
  | "directives";

export type MarkdownEditSafety = {
  requiresSourceMode: boolean;
  risks: MarkdownEditRisk[];
};

export type CodeFenceInfo = {
  language: string;
  title?: string;
  highlightedLines: Set<number>;
  showLineNumbers: boolean;
  hasMetadata: boolean;
};

export type FootnoteExtraction = {
  body: string;
  definitions: Map<string, string>;
  definitionOrder: string[];
};

export type MarkdownAssetUrlFactory = (absolutePath: string) => string;

const FRONT_MATTER_MARKERS = new Map<string, FrontMatterFormat>([
  ["---", "yaml"],
  ["+++", "toml"],
]);

function normalizedLines(source: string): string[] {
  return source.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split("\n");
}

/** Split only a real, closed front-matter block at the beginning of a document. */
export function extractFrontMatter(source: string): MarkdownDocumentParts {
  const lines = normalizedLines(source);
  const marker = lines[0]?.trim();
  const format = FRONT_MATTER_MARKERS.get(marker);
  if (!format) return { body: source };

  const close = lines.findIndex((line, index) => index > 0
    && (line.trim() === marker || (format === "yaml" && line.trim() === "...")));
  if (close < 0) return { body: source };
  return {
    frontMatter: { format, raw: lines.slice(1, close).join("\n") },
    body: lines.slice(close + 1).join("\n").replace(/^\n/, ""),
  };
}

function scalarText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(scalarText).join(", ");
  return JSON.stringify(value);
}

function flattenFrontMatter(value: unknown, prefix: string, rows: Array<[string, string]>): void {
  if (Array.isArray(value)) {
    rows.push([prefix || "value", scalarText(value)]);
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (child && typeof child === "object" && !Array.isArray(child)) flattenFrontMatter(child, path, rows);
      else rows.push([path, scalarText(child)]);
    }
    return;
  }
  rows.push([prefix || "value", scalarText(value)]);
}

function stripTomlComment(line: string): string {
  let quote = "";
  let escaped = false;
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (escaped) { escaped = false; continue; }
    if (quote === '"' && char === "\\") { escaped = true; continue; }
    if (quote) {
      if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === "#") return line.slice(0, index);
  }
  return line;
}

function findTomlEquals(line: string): number {
  let quote = "";
  let escaped = false;
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (escaped) { escaped = false; continue; }
    if (quote === '"' && char === "\\") { escaped = true; continue; }
    if (quote) {
      if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === "=") return index;
  }
  return -1;
}

function splitTomlList(value: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let quote = "";
  let escaped = false;
  let depth = 0;
  for (let index = 0; index < value.length; index++) {
    const char = value[index];
    if (escaped) { escaped = false; continue; }
    if (quote === '"' && char === "\\") { escaped = true; continue; }
    if (quote) {
      if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === "[" || char === "{") depth++;
    else if (char === "]" || char === "}") depth--;
    else if (char === "," && depth === 0) {
      parts.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  const tail = value.slice(start).trim();
  if (tail) parts.push(tail);
  return parts;
}

function tomlValueComplete(value: string): boolean {
  let quote = "";
  let escaped = false;
  let depth = 0;
  for (let index = 0; index < value.length; index++) {
    const char = value[index];
    if (escaped) { escaped = false; continue; }
    if (quote === '"' && char === "\\") { escaped = true; continue; }
    if (quote) {
      if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === "[" || char === "{") depth++;
    else if (char === "]" || char === "}") depth--;
  }
  return !quote && depth <= 0;
}

function displayTomlValue(raw: string): string {
  const value = raw.trim();
  if (value.startsWith("[") && value.endsWith("]")) {
    return splitTomlList(value.slice(1, -1)).map(displayTomlValue).join(", ");
  }
  if ((value.startsWith('"""') && value.endsWith('"""'))
    || (value.startsWith("'''") && value.endsWith("'''"))) {
    return value.slice(3, -3).trim();
  }
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    const inner = value.slice(1, -1);
    if (value[0] === "'") return inner;
    try { return JSON.parse(value); } catch { return inner.replace(/\\n/g, "\n").replace(/\\t/g, "\t"); }
  }
  return value.replace(/\s*\n\s*/g, " ");
}

function normalizeTomlKey(value: string): string {
  return splitTomlList(value.replace(/\./g, ","))
    .map((part) => part.replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, "$1$2").trim())
    .filter(Boolean)
    .join(".");
}

function tomlFrontMatterEntries(raw: string): Array<[string, string]> {
  const rows: Array<[string, string]> = [];
  let section = "";
  let pendingKey = "";
  let pendingValue = "";

  const flush = () => {
    if (!pendingKey) return;
    rows.push([section ? `${section}.${pendingKey}` : pendingKey, displayTomlValue(pendingValue)]);
    pendingKey = "";
    pendingValue = "";
  };

  for (const rawLine of raw.split("\n")) {
    const line = stripTomlComment(rawLine).trim();
    if (!line && !pendingKey) continue;
    if (pendingKey) {
      pendingValue += `\n${line}`;
      if (tomlValueComplete(pendingValue)) flush();
      continue;
    }
    const table = line.match(/^\[\[?([\s\S]*?)\]\]?$/);
    if (table) {
      section = normalizeTomlKey(table[1]);
      continue;
    }
    const equals = findTomlEquals(line);
    if (equals < 0) continue;
    pendingKey = normalizeTomlKey(line.slice(0, equals));
    pendingValue = line.slice(equals + 1).trim();
    if (tomlValueComplete(pendingValue)) flush();
  }
  flush();
  return rows;
}

/** Parse metadata for display only. Values never become executable HTML. */
export function frontMatterEntries(block: FrontMatterBlock): Array<[string, string]> {
  try {
    if (block.format === "yaml") {
      const parsed = loadYaml(block.raw, { schema: FAILSAFE_SCHEMA });
      const rows: Array<[string, string]> = [];
      flattenFrontMatter(parsed, "", rows);
      return rows;
    }

    return tomlFrontMatterEntries(block.raw);
  } catch {
    return [];
  }
}

function parseLineRange(spec: string): Set<number> {
  const lines = new Set<number>();
  for (const part of spec.split(",")) {
    const match = part.trim().match(/^(\d+)(?:-(\d+))?$/);
    if (!match) continue;
    const start = Number(match[1]);
    const end = Math.min(Number(match[2] ?? match[1]), start + 500);
    if (start < 1 || end < start) continue;
    for (let line = start; line <= end; line++) lines.add(line);
  }
  return lines;
}

/** Parse common fence metadata without changing ordinary language-only fences. */
export function parseCodeFenceInfo(info: string): CodeFenceInfo {
  const trimmed = info.trim();
  const languageMatch = trimmed.match(/^([^\s{[]+)?/);
  const language = languageMatch?.[1] ?? "";
  const remainder = trimmed.slice(language.length).trim();
  const titleMatch = remainder.match(/(?:^|\s)(?:title|filename|file)=(?:"([^"]*)"|'([^']*)'|([^\s{}]+))/i);
  const bracketTitle = remainder.match(/(?:^|\s)\[([^\]]+)\](?=\s|$)/);
  const rangeMatch = remainder.match(/\{([\d,\s-]+)\}/)
    ?? remainder.match(/(?:highlight|hl_lines)=(?:"([\d,\s-]+)"|'([\d,\s-]+)'|([\d,-]+))/i);
  const highlightedLines = parseLineRange(rangeMatch?.[1] ?? rangeMatch?.[2] ?? rangeMatch?.[3] ?? "");
  const explicitLineNumbers = /(?:^|\s)(?:linenos|line-numbers|showLineNumbers|:line-numbers)(?=\s|$)/i.test(remainder);
  return {
    language,
    title: titleMatch?.[1] ?? titleMatch?.[2] ?? titleMatch?.[3] ?? bracketTitle?.[1],
    highlightedLines,
    showLineNumbers: explicitLineNumbers || highlightedLines.size > 0,
    hasMetadata: remainder.length > 0,
  };
}

/** Extract GFM-style footnote definitions while leaving references in the body. */
export function extractFootnoteDefinitions(source: string): FootnoteExtraction {
  const lines = normalizedLines(source);
  const body: string[] = [];
  const definitions = new Map<string, string>();
  const definitionOrder: string[] = [];
  let fence: { marker: string; length: number } | undefined;

  for (let index = 0; index < lines.length;) {
    const fenceMatch = lines[index].match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      if (!fence) fence = { marker, length: fenceMatch[1].length };
      else if (marker === fence.marker && fenceMatch[1].length >= fence.length && fenceMatch[2].trim() === "") fence = undefined;
      body.push(lines[index]);
      index++;
      continue;
    }

    const match = fence ? null : lines[index].match(/^( {0,3})\[\^([^\]\s]+)\]:[ \t]*(.*)$/);
    if (!match) {
      body.push(lines[index]);
      index++;
      continue;
    }

    const definitionIndent = match[1].length;
    const id = match[2];
    const content = [match[3]];
    index++;
    while (index < lines.length) {
      const continuation = lines[index].match(/^( {2,}|\t)(.*)$/);
      if (continuation) {
        const indent = continuation[1];
        const expectedIndent = definitionIndent + 4;
        const strip = indent === "\t" ? 1 : Math.min(expectedIndent, indent.length);
        content.push(lines[index].slice(strip));
        index++;
        continue;
      }
      if (lines[index].trim() === "" && index + 1 < lines.length && /^(?: {2,}|\t)/.test(lines[index + 1])) {
        content.push("");
        index++;
        continue;
      }
      break;
    }

    if (!definitions.has(id)) {
      definitionOrder.push(id);
      definitions.set(id, content.join("\n").trim());
    }
  }

  return { body: body.join("\n"), definitions, definitionOrder };
}

function splitReferenceSuffix(reference: string): { path: string; query: string; hash: string } {
  const queryAt = reference.indexOf("?");
  const hashAt = reference.indexOf("#");
  const pathEnd = Math.min(queryAt < 0 ? reference.length : queryAt, hashAt < 0 ? reference.length : hashAt);
  const queryEnd = hashAt >= 0 && hashAt > pathEnd ? hashAt : reference.length;
  return {
    path: reference.slice(0, pathEnd),
    query: queryAt >= 0 && queryAt === pathEnd ? reference.slice(queryAt, queryEnd) : "",
    hash: hashAt >= 0 ? reference.slice(hashAt) : "",
  };
}

function normalizeLocalPath(path: string): string {
  const slashPath = path.replace(/\\/g, "/");
  const drive = slashPath.match(/^[A-Za-z]:/i)?.[0] ?? "";
  const unc = !drive && slashPath.startsWith("//");
  const absolute = !drive && !unc && slashPath.startsWith("/");
  const rest = slashPath.slice(drive.length + (unc ? 2 : absolute ? 1 : 0));
  const parts: string[] = [];
  for (const part of rest.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") { if (parts.length > 0) parts.pop(); continue; }
    parts.push(part);
  }
  const prefix = drive ? `${drive}/` : unc ? "//" : absolute ? "/" : "";
  return prefix + parts.join("/");
}

/** Resolve authored relative Markdown resources as file paths before converting them to runtime asset URLs. */
export function createMarkdownAssetResolver(sourcePath: string, toAssetUrl: MarkdownAssetUrlFactory): (reference: string) => string {
  const normalizedSource = sourcePath.replace(/\\/g, "/");
  const slash = normalizedSource.lastIndexOf("/");
  const directory = slash >= 0 ? normalizedSource.slice(0, slash + 1) : "";
  return (reference: string) => {
    const trimmed = reference.trim();
    if (!directory || !trimmed || trimmed.startsWith("#") || trimmed.startsWith("//")
      || (/^[a-z][a-z\d+.-]*:/i.test(trimmed) && !/^[A-Za-z]:[\\/]/.test(trimmed))) return reference;
    const suffix = splitReferenceSuffix(trimmed);
    const absolutePath = normalizeLocalPath(
      /^(?:[A-Za-z]:[\\/]|[\\/]{1,2})/.test(suffix.path) ? suffix.path : directory + suffix.path,
    );
    if (!absolutePath) return reference;
    const assetUrl = toAssetUrl(absolutePath);
    const query = suffix.query
      ? (assetUrl.includes("?") ? `&__omia_query=${encodeURIComponent(suffix.query.slice(1))}` : suffix.query)
      : "";
    return `${assetUrl}${query}${suffix.hash}`;
  };
}

/**
 * Crepe preserves GFM tables/tasks/math, but it cannot round-trip these extensions reliably.
 * Such documents use source editing so opening and saving never destroys unknown syntax.
 */
export function analyzeMarkdownEditSafety(source: string): MarkdownEditSafety {
  const risks = new Set<MarkdownEditRisk>();
  const document = extractFrontMatter(source);
  if (document.frontMatter) risks.add("front-matter");

  const lines = normalizedLines(document.body);
  const htmlSafetySource: string[] = [];
  let fence: { marker: string; length: number } | undefined;
  for (const line of lines) {
    const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      if (!fence) {
        fence = { marker, length: fenceMatch[1].length };
        if (parseCodeFenceInfo(fenceMatch[2]).hasMetadata) risks.add("fence-metadata");
      } else if (marker === fence.marker && fenceMatch[1].length >= fence.length && fenceMatch[2].trim() === "") {
        fence = undefined;
      }
      continue;
    }
    if (fence) continue;

    if (/^\s*<!-- omia:image-ratio=\d+(?:\.\d+)? -->\s*$/.test(line)) {
      htmlSafetySource.push("");
      continue;
    }
    htmlSafetySource.push(line);

    if (/\[\^[^\]\s]+\]/.test(line)) risks.add("footnotes");
    if (/^\s*\[\[?toc\]?\]\s*$/i.test(line)) risks.add("toc");
    if (/^\s*:{3,}/.test(line)) risks.add("directives");
  }

  // Milkdown serializes empty paragraphs as standalone <br /> blocks and can
  // parse them back. Ignore only those markers during safety classification;
  // keep the actual source (and its empty paragraphs) untouched. Inline or
  // attributed breaks still need source preservation because they can be lost.
  const htmlSource = htmlSafetySource.join("\n").replace(
    /(^|\n[ \t]*\n) {0,3}(?:<br \/>|<br>|<br >|<br\/>)[ \t]*(?=\n[ \t]*(?:\n|$)|$)/g,
    "$1",
  );
  const layoutSafety = stripValidPersistentLayoutsForSafety(htmlSource);
  const advancedTableSafety = stripValidAdvancedTablesForSafety(layoutSafety.ok ? layoutSafety.source : htmlSource);
  const controlledBlockSafety = stripControlledAlignmentBlocksForSafety(advancedTableSafety.ok ? advancedTableSafety.source : htmlSource);
  const htmlSafety = classifyControlledInlineHtml(controlledBlockSafety.ok ? controlledBlockSafety.source : htmlSource);
  if (!advancedTableSafety.ok || !layoutSafety.ok || !controlledBlockSafety.ok
    || (htmlSafety.hasHtml && !htmlSafety.controlled)) risks.add("raw-html");

  return { requiresSourceMode: risks.size > 0, risks: [...risks] };
}
