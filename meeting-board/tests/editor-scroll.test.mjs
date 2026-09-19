import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// 白板锁成一屏高（.board-wrap 的 height:100vh + overflow:hidden）之后，页面本身不再滚动，
// 每一档内容必须自己有一条**可达的滚动路径**，否则正文会被 flex 容器裁掉、永远看不到下半截。
//
// 这个坑踩过一次：编辑器上游给 .milkdown-host 挂的是 Tailwind 的 `h-full overflow-auto`，
// 而这个构建里根本没有 Tailwind —— 那两个类不生效，宿主节点就长到内容高度，
// 再被 .editor-canvas 的 overflow:hidden 整段裁掉（scrollHeight 15854 / clientHeight 770）。
// 单测看不见布局，浏览器里一眼就能看见「滚不动」，所以这里用 CSS 断言把不变量钉住。
const css = readFileSync(join(import.meta.dirname, '..', 'src', 'style.css'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '');

/** 取出某个选择器第一条规则声明的正文；找不到返回空串。 */
function ruleBody(selector) {
  const at = css.indexOf(`${selector}{`);
  if (at === -1) return '';
  const end = css.indexOf('}', at);
  return end === -1 ? '' : css.slice(at + selector.length + 1, end);
}

let passed = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { passed += 1; console.log(`  ✓ ${name}`); }
  else { failures.push(name); console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
}

const wrap = ruleBody('.board-wrap');
const pageLocked = /height\s*:\s*100vh/.test(wrap) && /overflow\s*:\s*hidden/.test(wrap);

const host = ruleBody('.editor-wrap .milkdown-host');
const hostHasHeight = /(?:^|;)\s*height\s*:\s*100%/.test(host);
const hostScrolls = /overflow-y\s*:\s*(?:auto|scroll)/.test(host);

const transcriptPane = ruleBody('.board-pane pre');
const transcriptScrolls = /overflow-y\s*:\s*(?:auto|scroll)/.test(transcriptPane);

check('编辑器滚动容器显式限制高度（不能靠 Tailwind 的 h-full）', hostHasHeight, host || '(没找到规则)');
check('编辑器滚动容器允许纵向滚动（不能靠 Tailwind 的 overflow-auto）', hostScrolls, host || '(没找到规则)');
check('逐字稿那一档也能滚', transcriptScrolls, transcriptPane || '(没找到规则)');

// 真正的不变量：页面锁死了，就得每一档自己滚；页面没锁死，得能靠页面滚。
check('页面锁成一屏高时，两档内容都必须各自可滚',
  !pageLocked || (hostHasHeight && hostScrolls && transcriptScrolls),
  `pageLocked=${pageLocked} host=${hostHasHeight}/${hostScrolls} transcript=${transcriptScrolls}`);

// 面板之间用 visibility 藏，不用 display:none —— 编辑器挂载时要能量到高度。
const inactivePane = ruleBody('.board-pane[data-active="false"]');
check('非当前档用 visibility 藏（display:none 会让编辑器量到零高度）',
  /visibility\s*:\s*hidden/.test(inactivePane), inactivePane || '(没找到规则)');

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
