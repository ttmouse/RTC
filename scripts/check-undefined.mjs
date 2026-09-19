/**
 * 前端「名字对不上」体检（`npm run check:js`）。
 *
 * 为什么要有它：静态检查（check-static.mjs）能证明文件在、语法对、import 路径解析得到，
 * 但**证明不了名字对得上**。2026-09-18 真实事故：`asr.js` 用了 `shouldAutoPaste` 却
 * 漏了 import，每句话定型时都抛 ReferenceError；异常被 catch 吞掉，表现是「自动粘贴
 * 配好了却一点效果都没有、也没报错」，靠读代码和看界面都极难发现。
 * 同类第二次：`main.js` 从 settings.js 导入了它并不导出的 `renderPasteHint`，
 * 整个模块图加载失败 —— 界面直接停在初始状态，页面不报错。
 *
 * 怎么查：用 tsc 的 --checkJs 把 JS 当 TS 读，只取这四类错误——
 *   TS2304 找不到名字 / TS2552 名字拼错 / TS2305 模块没有这个导出 / TS2614 导出名对不上。
 * 其余类型错误（隐式 any 之类）一律忽略：这个仓库的注释很重，正经的类型化收益太低。
 *
 * 唯一的已知误报：脚本写在 `window.foo = ...` 上的全局函数（HTML 的 onclick 要用），
 * 模块里裸写 `foo()` 时 tsc 认不出来。这些名字在这里扫一遍源码剔掉。
 *
 * 退出码 0 = 干净；1 = 有发现；2 = 本机没有 tsc（装一个：npm i -g typescript）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(root, 'src/js');
const CODES = ['TS2304', 'TS2552', 'TS2305', 'TS2614'];

const files = fs.readdirSync(SRC).filter(f => f.endsWith('.js')).map(f => path.join('src/js', f));

// 挂在 window 上的全局函数：HTML 的 onclick 依赖它们，模块里裸用是合法的
const globals = new Set();
for (const rel of files) {
  const text = fs.readFileSync(path.join(root, rel), 'utf8');
  for (const m of text.matchAll(/\bwindow\.([A-Za-z_$][\w$]*)\s*=/g)) globals.add(m[1]);
}

const res = spawnSync('tsc', [
  '--allowJs', '--checkJs', '--noEmit',
  '--target', 'es2022', '--module', 'esnext', '--moduleResolution', 'bundler',
  '--skipLibCheck', ...files,
], { cwd: root, encoding: 'utf8' });

if (res.error || res.status === null) {
  console.error('体检需要 tsc，但当前解析不到它。装一个即可：npm i -g typescript');
  process.exit(2);
}

const lines = `${res.stdout || ''}${res.stderr || ''}`.split('\n');
const findings = lines
  .map(line => line.match(/^(.*?)\((\d+),(\d+)\): error (TS\d+): (.*)$/))
  .filter(Boolean)
  .map(m => ({ file: m[1], line: m[2], code: m[4], message: m[5] }))
  .filter(f => CODES.includes(f.code))
  // 误报：名字来自 window.xxx = ...（见文件头说明）
  .filter(f => {
    const name = (f.message.match(/'([^']+)'/) || [])[1];
    return !(name && globals.has(name));
  });

if (!findings.length) {
  console.log(`名字体检通过（${files.length} 个前端模块，无 TS2304/2552/2305/2614）`);
  process.exit(0);
}

console.error(`名字体检发现 ${findings.length} 处（这类问题的症状是「功能静默失效」，务必修）：`);
for (const f of findings) console.error(`  ${f.file}:${f.line}  ${f.code}  ${f.message}`);
process.exit(1);
