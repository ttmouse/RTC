/**
 * 静态检查（`npm test` 的全部内容）。
 *
 * 这个脚本存在的意义是「能在产品坏掉时报错」。旧版本做不到：
 *   - 它检查的三个文件里有两个（playground.html / playground-settings.html）根本不存在，
 *     而 `if (!fs.existsSync(...)) continue` 会静默跳过——把 src/index.html 删了同样能过；
 *   - 只扫 HTML 里 `value="sk-..."` 形式的密钥，JS 里的密钥看不见；
 *   - 完全没碰 server.js、scripts/*.mjs、asr_local/server.py。
 * 换句话说它是一盏永远绿的灯。现在改成：列出来的文件必须存在，并且把真正会「加载失败」
 * 的东西都过一遍（模块语法、相对导入是否解析得到、HTML 引用的静态资源是否存在、
 * Python 能否编译）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fail = (msg) => { throw new Error(msg); };
const rel = (p) => path.relative(root, p);

// ── 1) HTML：id 唯一 / 无内联脚本 / 无硬编码密钥 / 引用的资源真实存在 ──
const HTML_FILES = ['src/index.html'];

for (const file of HTML_FILES) {
  const htmlPath = path.join(root, file);
  if (!fs.existsSync(htmlPath)) fail(`${file}: 文件不存在（检查清单里的入口文件被删了）`);
  const html = fs.readFileSync(htmlPath, 'utf8');

  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
  const seen = new Set();
  const duplicates = [];
  for (const id of ids) {
    if (seen.has(id)) duplicates.push(id);
    else seen.add(id);
  }
  if (duplicates.length > 0) {
    fail(`${file}: 重复 id: ${[...new Set(duplicates)].join(', ')}`);
  }

  if (/value=["']sk-(?!x{4})[A-Za-z0-9_-]{12,}["']/.test(html)) {
    fail(`${file}: 检测到硬编码 API Key`);
  }

  const inline = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)]
    .find((m) => m[2].trim());
  if (inline) fail(`${file}: 存在内联脚本（与 CSP 冲突，且无法被静态检查覆盖）`);

  // HTML 注释必须成对闭合。这不是洁癖：注释没闭合时，解析器会一路吞到**下一个** `-->`
  // 为止，中间的元素会被整段当成注释文本丢掉——DOM 里根本没有它们，页面也不报错。
  // 真实案例：在 HTML 注释里手滑写了 CSS 的 `*/` 收尾（而不是 `-->`），
  // 结果电平条、刻度线、峰值线三个元素连同行内结构全部消失，而 npm test 全绿。
  // 这里只做「配对」这一个判断——不解析 HTML，够用且不会误报。
  const commentOpens = (html.match(/<!--/g) || []).length;
  const commentCloses = (html.match(/-->/g) || []).length;
  if (commentOpens !== commentCloses) {
    fail(`${file}: HTML 注释未闭合（<!-- × ${commentOpens}，--> × ${commentCloses}）`
      + '——未闭合的注释会吞掉后面的元素，页面还不报错');
  }

  // 引用的 css/js 必须真的存在，否则运行时 404、页面无声降级。
  // 跳过以 / 开头的路径：那是服务端动态路由（例如开发模式的 /__dev_reload.js），
  // 不对应 src/ 下的文件。
  for (const m of html.matchAll(/(?:href|src)="([^"]+\.(?:css|js))"/g)) {
    if (m[1].startsWith('/')) continue;
    const asset = path.join(root, 'src', m[1]);
    if (!fs.existsSync(asset)) fail(`${file}: 引用了不存在的资源 ${m[1]}`);
  }

  if (!html.includes('<script type="module" src="js/main.js"></script>')) {
    fail(`${file}: 缺少模块入口 <script type="module" src="js/main.js">`);
  }
}

// ── 2) 前端模块：语法 + 相对导入必须解析到真实文件/具名导出 ──
const jsDir = path.join(root, 'src/js');
const jsFiles = fs.readdirSync(jsDir).filter((f) => f.endsWith('.js')).sort();

const exportsOf = new Map();
for (const file of jsFiles) {
  const src = fs.readFileSync(path.join(jsDir, file), 'utf8');
  exportsOf.set(file, new Set(
    [...src.matchAll(/export\s+(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z0-9_$]+)/g)]
      .map((m) => m[1]),
  ));
}

// 前端模块必须按 ESM 检查。本项目 package.json 没有 "type" 字段，`.js` 默认是 CommonJS，
// 含 import 的文件会走 Node 的「模块语法检测」路径——而那条路径**只解析、不做早错检查**。
// 实测：`import ...; let a = 1; let a = 2;` 存成 .js，`node --check` 退出码是 0（不报错）；
// 同内容存成 .mjs 才会以「Identifier 'a' has already been declared」失败。
// 一个重复的 let 声明就是这样溜过检查的：静态检查全绿，运行时整个模块加载失败。
// 所以统一复制成 .mjs 再检查，强制走真正的 ESM 编译。
const syntaxTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rtc-syntax-'));
// 用 realpath：macOS 上 /tmp 是 /private/tmp 的软链，而 node 报错里给的是解析后的路径，
// 不统一的话下面的 replaceAll 匹配不上，报错信息里就会留着临时文件路径给用户看。
const syntaxTmpFile = path.join(fs.realpathSync(syntaxTmpDir), 'module.mjs');

for (const file of jsFiles) {
  const filePath = path.join(jsDir, file);
  fs.copyFileSync(filePath, syntaxTmpFile);
  const result = spawnSync(process.execPath, ['--check', syntaxTmpFile], { encoding: 'utf8' });
  if (result.status !== 0) {
    // 报错信息里是临时文件路径，换回真实路径再抛，否则谁也定位不到是哪个文件
    fail(`${rel(filePath)}: ${result.stderr.trim().replaceAll(syntaxTmpFile, rel(filePath))}`);
  }

  const src = fs.readFileSync(filePath, 'utf8');
  for (const m of src.matchAll(/import\s*\{([^}]+)\}\s*from\s*'\.\/([^']+)'/g)) {
    const dep = m[2];
    if (!exportsOf.has(dep)) fail(`${rel(filePath)}: 导入了不存在的模块 ./${dep}`);
    const names = m[1].split(',').map((s) => s.trim().split(/\s+as\s+/)[0]).filter(Boolean);
    for (const name of names) {
      if (!exportsOf.get(dep).has(name)) {
        fail(`${rel(filePath)}: 从 ./${dep} 导入了不存在的具名导出 ${name}`);
      }
    }
  }
}

// ── 3) 后端 JS：语法 ──
const BACKEND_JS = ['server.js', ...fs.readdirSync(path.join(root, 'scripts'))
  .filter((f) => f.endsWith('.mjs'))
  .map((f) => path.join('scripts', f))];

for (const file of BACKEND_JS) {
  const filePath = path.join(root, file);
  const result = spawnSync(process.execPath, ['--check', filePath], { encoding: 'utf8' });
  if (result.status !== 0) fail(`${file}: ${result.stderr.trim()}`);
}

// ── 4) Python sidecar：语法（保持「可管理、不可识别」的降级路径不被语法错误破坏）──
const PY_FILES = ['asr_local/server.py'];
for (const file of PY_FILES) {
  const result = spawnSync('python3', ['-m', 'py_compile', path.join(root, file)], { encoding: 'utf8' });
  if (result.status !== 0) fail(`${file}: ${(result.stderr || result.stdout).trim()}`);
}

// ── 5) JSON：配置文件、锁文件、Tauri 清单与 ACL schema 都必须是合法 JSON ──
// 这些文件里任何一处尾逗号/多余 {} 都会让 tauri build 或 npm ci 在更晚、更难懂的地方爆炸。
const JSON_FILES = [
  'package.json',
  'package-lock.json',
  'src-tauri/tauri.conf.json',
  'src-tauri/capabilities/default.json',
  ...fs.readdirSync(path.join(root, 'src-tauri/gen/schemas'))
    .filter((f) => f.endsWith('.json'))
    .map((f) => path.join('src-tauri/gen/schemas', f)),
];
for (const file of JSON_FILES) {
  const filePath = path.join(root, file);
  if (!fs.existsSync(filePath)) continue;
  try {
    JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    fail(`${file}: JSON 解析失败 — ${e.message}`);
  }
}

// ── 6) CSS：括号平衡 + 规则外的游离声明 ──
// 真实案例（本仓库）：某个 style.css 里留下一个没有选择器的声明块，浏览器不报错，
// 而是把**紧随其后的那条规则**一起丢掉——症状是按钮悄悄退化成系统默认样式
// （录制按钮变成一块灰方块）。这跟 HTML 注释没闭合是同一类毛病：语法上「能解析」，
// 语义上少了一整块，静态灯全绿。
const CSS_DIRS = [path.join(root, 'meeting-board/src')];
const cssFiles = ['src/css/style.css', 'meeting-board/src/style.css'];
(function collect(dir) {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) collect(p);
    else if (e.name.endsWith('.css')) cssFiles.push(rel(p));
  }
})(CSS_DIRS[0]);

for (const file of [...new Set(cssFiles)].sort()) {
  const cssPath = path.join(root, file);
  if (!fs.existsSync(cssPath)) fail(`${file}: 文件不存在（CSS 检查清单里的文件被删了）`);
  // 注释先去掉：注释里的花括号和分号不该参与配对判断。
  const css = fs.readFileSync(cssPath, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  let depth = 0; let buf = ''; let line = 1; let stmtLine = 1;
  const orphans = [];
  for (const ch of css) {
    if (ch === '\n') { line += 1; continue; }
    if (ch === '{') { depth += 1; buf = ''; stmtLine = line; continue; }
    if (ch === '}') { depth -= 1; buf = ''; stmtLine = line; continue; }
    // 深度 0 上的 `;`：要么是 @import / @charset 这类语句（合法），要么就是游离声明（会吞掉下一条规则）。
    if (ch === ';' && depth === 0) {
      const stmt = buf.trim();
      if (stmt && !stmt.startsWith('@')) orphans.push(`第 ${stmtLine} 行附近: ${stmt.slice(0, 60)}`);
      buf = '';
      continue;
    }
    buf += ch;
  }
  if (depth !== 0) {
    fail(`${file}: 花括号不配对（${depth > 0 ? '少' : '多'} ${Math.abs(depth)} 个 ${depth > 0 ? '}' : '{'}）——不配对会把后面的规则整段吞掉`);
  }
  if (orphans.length) {
    fail(`${file}: 规则外有 ${orphans.length} 处游离声明，浏览器会连它后面那条规则一起丢掉\n      ${orphans.join('\n      ')}`);
  }
}

fs.rmSync(syntaxTmpDir, { recursive: true, force: true });

console.log(`static checks passed (${jsFiles.length} frontend modules, ${BACKEND_JS.length} backend scripts, ${PY_FILES.length} python files, ${JSON_FILES.length} json files, ${[...new Set(cssFiles)].length} stylesheets)`);
