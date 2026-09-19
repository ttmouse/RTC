import assert from 'node:assert/strict';
import { state } from '../src/js/state.js';
import { appInList, shouldAutoPaste, shouldAutoEnter } from '../src/js/settings.js';
import { pasteBadgeSpec, specFromActiveApp, specFromTargetApp } from '../src/js/pastebadge.js';

// 「话会跑到哪里去」的判定（ui-interaction-spec 第 6 节 / core-product-principles 第 3 条）。
//
// 这里钉的是两个真实事故：
// 1) 名单里存的是系统应用列表给的 **.app 包名**（WeChat），而前台查询回的是 macOS 的
//    本地化显示名（微信）。字符串相等判定下，用户在设置里加了微信，微信里却永远
//    收不到自动回车/粘贴，而且没有任何地方会告诉他为什么。实测 config.json 里就躺着
//    ["Cindy", "WeChat"]，而记录里的目标应用写的是「微信」。
// 2) 「不在名单里」和「不知道目标是谁」必须都判成不粘：认不出目标时宁可让用户伸手
//    按一下，也不能把不知道发去哪的话送出去。
//
// 测试只读 state 并调用纯函数，不起服务、不碰 DOM，也不碰真实转写记录。

let passed = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { passed += 1; console.log(`  ✓ ${name}`); }
  else { failures.push(name); console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
}

/** 一次前台查询结果的形状（见 src-tauri/src/mac_frontmost.rs） */
const wechat = { name: '微信', bundle: 'WeChat', id: 'com.tencent.xinWeChat' };
const dia = { name: 'Dia', bundle: 'Dia', id: 'company.thebrowser.dia' };

// —— 身份匹配 ——
check('名单里是包名 WeChat，前台是显示名「微信」→ 命中（就是那个事故）',
  appInList(['WeChat'], wechat) === true);
check('名单里是显示名「微信」，前台是同一个应用 → 命中',
  appInList(['微信'], wechat) === true);
check('名单里是 bundle id → 命中',
  appInList(['com.tencent.xinwechat'], wechat) === true, 'bundle id 大小写不该影响判定');
check('名单里的名字对不上这个应用 → 不命中',
  appInList(['WeChat'], dia) === false);
check('认不出目标（null）→ 不命中', appInList(['WeChat'], null) === false);
check('名单为空 → 不命中（是否生效由总闸决定）', appInList([], wechat) === false);
check('名单里混进非字符串（配置文件被手工改坏）→ 不抛错',
  appInList([null, 42, 'WeChat'], wechat) === true);
check('应用身份缺字段（老后端只回显示名）→ 仍按显示名命中',
  appInList(['微信'], { name: '微信', bundle: null, id: null }) === true);

// —— 自动粘贴：两层判定 ——
function setPaste(on, apps) {
  state.autoPaste = on;
  state.autoPasteApps = apps;
}

setPaste(false, []);
check('总闸关着 → 一律不粘，名单里有没有都不粘', shouldAutoPaste(wechat) === false);

setPaste(true, []);
check('总闸开着 · 没配名单 → 沿用老行为（所有应用都粘）', shouldAutoPaste(wechat) === true);
check('总闸开着 · 没配名单 · 认不出目标 → 仍粘（老行为，网页版没有前台查询也照样粘）',
  shouldAutoPaste(null) === true);

setPaste(true, ['Cindy', 'WeChat']);
check('总闸开着 · 配了名单 · 名单里的应用 → 粘', shouldAutoPaste(wechat) === true);
check('总闸开着 · 配了名单 · 名单外的应用（Dia）→ 不粘',
  shouldAutoPaste(dia) === false);
check('总闸开着 · 配了名单 · 认不出目标 → 不粘（不知道会打进哪个输入框）',
  shouldAutoPaste(null) === false);

// —— 自动发送：同一套两层判定，单独一份名单 ——
state.autoPasteApps = [];
state.autoEnter = false;
state.autoEnterApps = [];
check('自动发送 · 总闸关着 → 不按回车', shouldAutoEnter(wechat) === false);

state.autoEnter = true;
check('自动发送 · 总闸开着 · 没配名单 → 沿用老行为', shouldAutoEnter(wechat) === true);

state.autoEnterApps = ['WeChat'];
check('自动发送 · 名单里的应用（存包名 / 前台回「微信」）→ 按回车',
  shouldAutoEnter(wechat) === true);
check('自动发送 · 名单外的应用 → 不按回车', shouldAutoEnter(dia) === false);
check('自动发送 · 认不出目标 → 不按回车', shouldAutoEnter(null) === false);

check('两份名单互不影响（粘贴名单不等于发送名单）', (() => {
  state.autoPaste = true;
  state.autoPasteApps = ['Cindy'];
  state.autoEnter = true;
  state.autoEnterApps = ['WeChat'];
  return shouldAutoPaste(wechat) === false && shouldAutoEnter(wechat) === true;
})());

// —— 记录行末的徽标（这句粘给了哪个应用）——
// 它存在的理由：用户要先知道「这句到底进没进去」；先前做成底标一格「最近一句」是错的，
// 去向是**每条记录**的属性（2026-09-18 用户纠正）。
// 这里只钉两种事实：粘给谁 / 没粘（用户明确说过没提的需求不做：悬停原因、更多细节都不加）。
check('粘出去了 → 写清粘给了谁',
  JSON.stringify(pasteBadgeSpec({ paste: true, appName: '微信' })) === JSON.stringify({ kind: 'app', name: '微信', label: '已粘给 微信' }));
check('认不出目标却粘了（网页版没有系统能力）→ 不写假的应用名',
  pasteBadgeSpec({ paste: true }).label === '已粘出去');
check('没粘 → ⊘，不带原因',
  JSON.stringify(pasteBadgeSpec({ paste: false, appName: 'Dia' })) === JSON.stringify({ kind: 'none', name: null, label: '没粘出去' }));
check('说话时未识别前台应用 → 保留未识别图标',
  specFromActiveApp(null).kind === 'unknown' && specFromActiveApp(null).label === '说话时未识别前台应用');
check('历史记录：事件里有应用名 → 显示那个应用的图标',
  specFromTargetApp('微信').kind === 'app' && specFromTargetApp('微信').name === '微信');
check('历史记录：事件里没有目标 → ⊘',
  specFromTargetApp(null).kind === 'none' && specFromTargetApp(null).label === '没粘出去');

if (failures.length) {
  console.error(`\n${failures.length} failed:`);
  for (const name of failures) console.error(`  - ${name}`);
  process.exit(1);
}
assert.equal(failures.length, 0);
console.log(`\n${passed} passed, 0 failed`);
