// 「分块保真保存」的行为回归：node --test 或 npm test 都能跑。
// 用例覆盖：没改→字节一致、只改一段→其余块保真、增删块、front matter 只出现一次、空文档首次写入。
import { extractFrontMatter, patchMarkdownBlocks, splitMarkdownBlocks } from '../src/markdownBlockPatch.js';

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
};

// 一份带高级语法的原文：front matter + 代码围栏标题 + 原始 HTML + 脚注 + 表格
const original = [
  '---',
  'title: 测试文档',
  'tags: [a, b]',
  '---',
  '',
  '# 会议记录',
  '',
  '## 当前话题',
  '',
  '讨论<<<>>了工作台的起点。',
  '',
  '<mark>这一句被标黄了</mark>',
  '',
  '```js title="示例" {1,3}',
  'const a = 1;',
  '```',
  '',
  '| 列 A | 列 B |',
  '| --- | --- |',
  '| 1 | 2 |',
  '',
  '脚注引用[^1]',
  '',
  '[^1]: 脚注内容',
  '',
].join('\n');

// 编辑器加载同一份文档后吐出来的归一化写法：front matter 不进编辑器、mark 被剥、围栏信息行丢了、表格重排
const baseline = [
  '# 会议记录',
  '',
  '## 当前话题',
  '',
  '讨论<<<>>了工作台的起点。',
  '',
  '这一句被标黄了',
  '',
  '```',
  'const a = 1;',
  '```',
  '',
  '| 列 A | 列 B |',
  '| --- | --- |',
  '| 1 | 2 |',
  '',
  '脚注引用[^1]',
  '',
  '[^1]: 脚注内容',
  '',
].join('\n');

console.log('用例 1：用户没改任何东西 → 必须与原文逐字节相同');
const untouched = patchMarkdownBlocks({ original, baseline, edited: baseline });
check('输出 === 原文', untouched.markdown === original, JSON.stringify(untouched.markdown.slice(0, 80)));

console.log('用例 2：只改了一个段落 → 其他块（含 <mark>、围栏信息行、表格、脚注）逐字节保留');
const edited = baseline.replace('讨论<<<>>了工作台的起点。', '讨论<<<>>了工作台的起点，并看了筛选逻辑。');
const changed = patchMarkdownBlocks({ original, baseline, edited });
check('改动生效', changed.markdown.includes('并看了筛选逻辑'), changed.markdown);
check('<mark> 原样保留', changed.markdown.includes('<mark>这一句被标黄了</mark>'));
check('代码围栏标题原样保留', changed.markdown.includes('```js title="示例" {1,3}'));
check('front matter 原样保留', changed.markdown.startsWith('---\ntitle: 测试文档\n'));
check('表格与脚注原样保留', changed.markdown.includes('| 列 A | 列 B |') && changed.markdown.includes('[^1]: 脚注内容'));
check('只报 1 个块被改', changed.changedBlocks === 1, String(changed.changedBlocks));

console.log('用例 3：新增一个块');
const withNew = `${baseline}\n## 行动项\n\n- 明天验证筛选\n`;
const added = patchMarkdownBlocks({ original, baseline, edited: withNew });
check('新块进来了', added.markdown.includes('## 行动项') && added.markdown.includes('明天验证筛选'));
check('老块仍然保真', added.markdown.includes('<mark>这一句被标黄了</mark>') && added.markdown.includes('```js title="示例" {1,3}'));

console.log('用例 4：删掉一个块');
const removed = baseline.replace('## 当前话题\n\n', '');
const del = patchMarkdownBlocks({ original, baseline, edited: removed });
check('被删的块不在了', !del.markdown.includes('## 当前话题'), del.markdown);
check('其他块仍然保真', del.markdown.includes('<mark>这一句被标黄了</mark>') && del.markdown.includes('```js title="示例" {1,3}'));

console.log('用例 5：块切分是「拼回去等于原文」的');
const pieces = splitMarkdownBlocks(original.slice(0, original.indexOf('\n# ')));
check('切分不丢字节', pieces.map((b) => b.text + b.gap).join('') === original.slice(0, original.indexOf('\n# ')));

console.log('用例 7：front matter 只出现一次（编辑器加载时已剥掉，保存时接回）');
const fmOriginal = '---\ntitle: T\n---\n\n# 标题\n\n正文。\n';
const editorInput = extractFrontMatter(fmOriginal).body;
const fmEdited = editorInput.replace('正文。', '正文改了。');
const fmPatched = patchMarkdownBlocks({ original: fmOriginal, baseline: editorInput, edited: fmEdited });
check('编辑器拿到的是不含 front matter 的正文', editorInput === '# 标题\n\n正文。\n', JSON.stringify(editorInput));
check('front matter 只出现一次', fmPatched.markdown.split('title: T').length === 2, JSON.stringify(fmPatched.markdown));
check('输出以 front matter 开头', fmPatched.markdown.startsWith('---\ntitle: T\n---\n'), JSON.stringify(fmPatched.markdown.slice(0, 40)));
check('正文改动生效', fmPatched.markdown.includes('正文改了。'));

console.log('用例 6：空文档 → 第一次写入');
const first = patchMarkdownBlocks({ original: '', baseline: '', edited: '# 新会议\n\n第一段\n' });
check('内容写进去了', first.markdown === '# 新会议\n\n第一段\n', JSON.stringify(first.markdown));

console.log(`\n通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
