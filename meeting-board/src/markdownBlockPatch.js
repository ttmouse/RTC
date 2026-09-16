// 「分块保真保存」——移植自 xiaoer-omia（Omia）2026-09-09 的方案，两边用的是同一个编辑器（Crepe）。
//
// 为什么需要它：Crepe 吐出来的 Markdown 是它自己的归一化写法——代码围栏上的标题/语言会丢、
// `<mark>` 这类原始 HTML 会变、列表符号会换、表格会重排。白板又是「外部 AI 往文件里写 + 人在
// 编辑器里改」的场景，以前保存是整篇回写：用户只改一行，整篇都会被按编辑器的写法重写一遍。
// 现在改成：
//   1. 把原文、编辑器就绪时的序列化（baseline）、当前序列化（edited）都按顶层块切开；
//   2. edited 里和 baseline 逐字相同的块 = 用户没碰过 → 回填该块的**原文**；
//   3. 只有真改过的块才用编辑器的结果。
// 一个字没改 → 输出等于原文（字节一致）。Front Matter 编辑器根本不看，原样接回去。
//
// 没跟着搬过来的：Omia 会在改到高级语法块时弹一次「会改写什么」的确认框。白板是投屏 + 自动保存，
// 弹窗会打断会上的人，所以这里只做保真、不做确认；调用方也从结果里拿不到风险清单。
//
// 它挡不住的事：保存前如果不重新读一次磁盘，外面刚写进去的内容仍会被这一次保存覆盖。
// 那属于「两边同时写」，要另想办法。
import MarkdownIt from 'markdown-it';

const splitter = new MarkdownIt({ html: true, linkify: false, typographer: false });

const KIND_BY_TYPE = {
  heading_open: 'heading',
  paragraph_open: 'paragraph',
  fence: 'fence',
  code_block: 'code',
  bullet_list_open: 'list',
  ordered_list_open: 'list',
  blockquote_open: 'quote',
  table_open: 'table',
  hr: 'hr',
  html_block: 'html',
};

const FRONT_MATTER_MARKERS = new Map([['---', 'yaml'], ['+++', 'toml']]);

function normalizedLines(source) {
  return source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
}

/** 只剥离文档开头那个真正闭合的 front matter 块。也要给编辑器用：它不认 front matter，
 *  把它当普通正文渲染（--- 变成分割线），所以进编辑器前先剥掉，保存时再由 patch 原样接回。 */
export function extractFrontMatter(source) {
  const lines = normalizedLines(source);
  const marker = (lines[0] || '').trim();
  const format = FRONT_MATTER_MARKERS.get(marker);
  if (!format) return { body: source };
  const close = lines.findIndex((line, index) => index > 0
    && (line.trim() === marker || (format === 'yaml' && line.trim() === '...')));
  if (close < 0) return { body: source };
  return { body: lines.slice(close + 1).join('\n').replace(/^\n/, '') };
}

/** 按顶层块切分；所有字节都落在某个块的 text 或 gap 里，拼回去等于输入。 */
export function splitMarkdownBlocks(body) {
  const lines = body.split('\n');
  const lastIndex = lines.length - 1;
  const lineText = (index) => (index < lastIndex ? `${lines[index]}\n` : lines[index]);
  const slice = (from, to) => {
    let out = '';
    for (let index = from; index < to && index < lines.length; index += 1) out += lineText(index);
    return out;
  };

  const ranges = [];
  for (const token of splitter.parse(body, {})) {
    if (token.level !== 0 || !token.map || token.nesting === -1) continue;
    const [start, end] = token.map;
    if (end <= start) continue;
    const previous = ranges[ranges.length - 1];
    if (previous && start < previous.end) continue; // 嵌套/重叠的顶层记号只取第一个
    ranges.push({ kind: KIND_BY_TYPE[token.type] || 'other', start, end });
  }
  if (ranges.length === 0) {
    return body === '' ? [] : [{ kind: 'other', start: 0, end: lines.length, text: body, gap: '' }];
  }

  const blocks = [];
  ranges.forEach((range, index) => {
    const next = ranges[index + 1];
    const lead = index === 0 ? slice(0, range.start) : ''; // 文首空行并入第一个块
    const text = lead + slice(range.start, range.end);
    blocks.push({ kind: range.kind, start: range.start, end: range.end, text, gap: slice(range.end, next ? next.start : lines.length) });
  });
  return blocks;
}

/** 块的「语义签名」：抹掉编辑器会改写的形式差异（围栏信息行、HTML 标签、转义、标点、空白）。 */
function signature(block) {
  let text = block.text;
  if (block.kind === 'fence' || block.kind === 'code') text = text.split('\n').slice(1).join('\n');
  text = text
    .replace(/<[^>]+>/g, '')
    .replace(/\\([\\`*_{}[\]()#+\-.!<>|~])/g, '$1')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
  return `${block.kind}:${text.slice(0, 240)}`;
}

/** 最长公共子序列的配对下标（两边都很短，O(n·m) 足够）。 */
function lcsPairs(left, right, equal) {
  const rows = left.length;
  const cols = right.length;
  const table = Array.from({ length: rows + 1 }, () => new Array(cols + 1).fill(0));
  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = cols - 1; j >= 0; j -= 1) {
      table[i][j] = equal(left[i], right[j])
        ? table[i + 1][j + 1] + 1
        : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const pairs = [];
  let i = 0;
  let j = 0;
  while (i < rows && j < cols) {
    if (equal(left[i], right[j])) { pairs.push([i, j]); i += 1; j += 1; }
    else if (table[i + 1][j] >= table[i][j + 1]) i += 1;
    else j += 1;
  }
  return pairs;
}

function frontMatterPrefix(original, body) {
  if (body === original) return '';
  if (body !== '' && original.endsWith(body)) return original.slice(0, original.length - body.length);
  return ''; // 换行风格被归一化到对不上时，宁可当没有 front matter，也不能吐出错位文本
}

/** 段与段之间至少要有一个空行，除非它已经是最后一段。 */
function withSeparator(segment, isLast) {
  if (isLast || segment.endsWith('\n\n') || segment === '') return segment;
  return segment.endsWith('\n') ? `${segment}\n` : `${segment}\n\n`;
}

export function patchMarkdownBlocks({ original, baseline, edited }) {
  if (edited === baseline) return { markdown: original, changedBlocks: 0 };

  const parts = extractFrontMatter(original);
  const body = frontMatterPrefix(original, parts.body) === '' && parts.body !== original ? original : parts.body;
  const prefix = frontMatterPrefix(original, body);

  const originalBlocks = splitMarkdownBlocks(body);
  const baselineBlocks = splitMarkdownBlocks(baseline);
  const editedBlocks = splitMarkdownBlocks(edited);

  const baselineToOriginal = new Map();
  for (const [o, b] of lcsPairs(originalBlocks, baselineBlocks, (a, c) => signature(a) === signature(c))) {
    baselineToOriginal.set(b, o);
  }
  const editedToBaseline = new Map();
  for (const [b, e] of lcsPairs(baselineBlocks, editedBlocks, (a, c) => a.text.trimEnd() === c.text.trimEnd())) {
    editedToBaseline.set(e, b);
  }

  const preserved = new Set();
  let markdown = '';
  let changedBlocks = 0;
  editedBlocks.forEach((block, e) => {
    const isLast = e === editedBlocks.length - 1;
    const b = editedToBaseline.get(e);
    const o = b === undefined ? undefined : baselineToOriginal.get(b);
    if (o !== undefined && !preserved.has(o)) {
      preserved.add(o);
      const source = originalBlocks[o];
      markdown += withSeparator(source.text + source.gap, isLast);
    } else {
      changedBlocks += 1;
      markdown += withSeparator(block.text + block.gap, isLast);
    }
  });

  return { markdown: prefix + markdown, changedBlocks };
}
