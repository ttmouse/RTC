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

for (const file of jsFiles) {
  const filePath = path.join(jsDir, file);
  // --check 只验证语法。这里额外确保 ESM 关键字不会被当成 CJS 报错。
  const result = spawnSync(process.execPath, ['--check', filePath], { encoding: 'utf8' });
  if (result.status !== 0) fail(`${rel(filePath)}: ${result.stderr.trim()}`);

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

console.log(`static checks passed (${jsFiles.length} frontend modules, ${BACKEND_JS.length} backend scripts, ${PY_FILES.length} python files, ${JSON_FILES.length} json files)`);
