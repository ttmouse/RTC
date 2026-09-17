#!/usr/bin/env node
/**
 * 界面体验巡检（`npm run check:ux`）。
 *
 * ## 为什么要有这个脚本
 *
 * `npm test`（`scripts/check-static.mjs`）只能证明「文件在、语法对、资源找得到」——
 * 它是一盏静态的灯。2026-09-17 那次「AI 会议内容滚不动了」它全绿：
 * 代码没错、资源没缺，只是 `.editor-canvas` 的 scrollHeight 是 15854、clientHeight 是 770、
 * overflow 是 hidden，一万多像素的正文被裁掉且**没有任何办法够到**。
 * 这种问题只有把页面真正跑起来、量一遍几何才看得见。
 *
 * ## 它查什么
 *
 * 全部是「机械可判定」的毛病，不靠审美判断：
 *
 * | 检查 | 为什么这是毛病 |
 * |------|---------------|
 * | 内容被裁掉且够不着 | 元素内容超出了盒子、被 overflow:hidden 裁掉，且祖先里没有任何滚动容器能把它滚出来 → 用户永远看不到 |
 * | 控件被盖住 | 可点元素的中心点被别的元素接走了 → 看着在那儿，点不动（踩过：语音指令页） |
 * | 控件在视口外 | 可点元素中心点在可视区外且没被滚动容器兜住 |
 * | 可点区域过小 | 宽或高 < 16px |
 * | 横向溢出 | 页面出现横向滚动条 |
 * | 大块可见空白 | 占了 > 300×200 的地方，自己没字、后代也没字、也没有可点元素 → 一块不知道干嘛的空面板 |
 *
 * 判据都写成「用户能不能看到 / 能不能点到」，所以不依赖具体组件长什么样。
 *
 * ## 用法
 *
 *   npm run check:ux                       # 自带夹具起一个临时服务，跑完整个矩阵
 *   node scripts/check-ux.mjs --url <url>  # 巡检一个已经在跑的服务
 *
 * 退出码非 0 = 有发现。想让它当门禁用，直接串进 CI 即可。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ── Playwright 不在这个仓库的依赖里，别假装它在 ──
const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  console.error('巡检需要 Playwright，但当前解析不到它。');
  console.error('装一个即可（装完浏览器会自动下到 ~/Library/Caches/ms-playwright）：');
  console.error('    npm i -D playwright && npx playwright install chromium');
  process.exit(2);
}

// ────────────────────────────── 在页面里跑的检查 ──────────────────────────────

/**
 * 这个函数会被序列化后丢进浏览器执行，所以**不能**引用外面的任何变量。
 * 返回一串 {kind, selector, detail, text} —— kind 是毛病类型，其余用于定位。
 */
function auditPage() {
  const problems = [];
  const push = (kind, el, detail) => {
    problems.push({ kind, selector: describe(el), detail, text: snippet(el) });
  };

  const snippet = (el) => (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 48);

  /** 给元素拼一个能按图索骥的短选择器：标签 + id + 头两个类。 */
  const describe = (el) => {
    if (!el || el === document.documentElement) return 'html';
    let out = el.tagName.toLowerCase();
    if (el.id) out += `#${el.id}`;
    const cls = (el.getAttribute('class') || '').split(/\s+/).filter(Boolean).slice(0, 2);
    if (cls.length) out += `.${cls.join('.')}`;
    return out;
  };

  const style = (el) => getComputedStyle(el);

  /** 元素自己是否「看得见」——不含被祖先藏掉的情况，那个由 visibleTree 处理。 */
  const shown = (el) => {
    const cs = style(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };

  /** 祖先里有没有一个容器能把这个方向上的溢出滚出来。 */
  const scrollableAncestor = (el, axis) => {
    for (let p = el.parentElement; p && p !== document.documentElement; p = p.parentElement) {
      const cs = style(p);
      const o = axis === 'y' ? cs.overflowY : cs.overflowX;
      if (o !== 'auto' && o !== 'scroll') continue;
      const over = axis === 'y' ? p.scrollHeight - p.clientHeight : p.scrollWidth - p.clientWidth;
      if (over > 2) return p;
    }
    return null;
  };

  const INTERACTIVE = 'button, a[href], input, select, textarea, [role="button"], [contenteditable="true"], summary';
  const DEAD = 'html, body, script, style, head, link, meta';

  const all = [...document.querySelectorAll('*')];

  for (const el of all) {
    if (DEAD.includes(el.tagName.toLowerCase())) continue;
    if (el.getAttribute('aria-hidden') === 'true') continue;
    if (!shown(el)) continue;

    const cs = style(el);
    const tag = el.tagName.toLowerCase();

    // ── 1) 内容被裁掉，而且够不着 ──
    if (!['input', 'textarea', 'select', 'img', 'svg', 'canvas', 'video'].includes(tag)) {
      // 单行省略号是**刻意**的截断，不算毛病（没 title 的会在下面单独提示）。
      const intentionalEllipsis = cs.whiteSpace === 'nowrap' && cs.textOverflow === 'ellipsis';
      const overY = el.scrollHeight - el.clientHeight;
      const clipsY = cs.overflowY === 'hidden' || cs.overflowY === 'clip';
      if (clipsY && overY > 8 && !intentionalEllipsis && !scrollableAncestor(el, 'y')) {
        push('内容被裁掉且够不着', el, `纵向还有 ${overY}px 看不到（clientHeight=${el.clientHeight}, scrollHeight=${el.scrollHeight}），且没有可滚动祖先`);
      }
      const overX = el.scrollWidth - el.clientWidth;
      const clipsX = cs.overflowX === 'hidden' || cs.overflowX === 'clip';
      if (clipsX && overX > 8 && !intentionalEllipsis && !scrollableAncestor(el, 'x')) {
        push('内容被裁掉且够不着', el, `横向还有 ${overX}px 看不到（clientWidth=${el.clientWidth}, scrollWidth=${el.scrollWidth}），且没有可滚动祖先`);
      }
    }

    // ── 2) 可点元素：点得到吗、够大吗 ──
    if (el.matches(INTERACTIVE)) {
      const r = el.getBoundingClientRect();
      if (r.width < 16 || r.height < 16) {
        push('可点区域过小', el, `${Math.round(r.width)}×${Math.round(r.height)}px，小于 16px 很难点中`);
      }
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const inside = cx >= 0 && cy >= 0 && cx <= innerWidth && cy <= innerHeight;
      if (!inside) {
        // 在视口外不算毛病，只要用户滚一滚能到它。
        if (!scrollableAncestor(el, 'y') && !scrollableAncestor(el, 'x')) {
          push('控件在视口外且够不着', el, `中心点 (${Math.round(cx)}, ${Math.round(cy)}) 在 ${innerWidth}×${innerHeight} 视口外，也没有可滚动祖先`);
        }
      } else if (shown(el)) {
        const hit = document.elementFromPoint(cx, cy);
        if (hit && hit !== el && !el.contains(hit) && !hit.contains(el)) {
          push('控件被盖住（点不动）', el, `中心点上其实是 ${describe(hit)}`);
        }
      }
    }

    // ── 3) 大块可见空白 ──
    const r = el.getBoundingClientRect();
    if (r.width > 300 && r.height > 200 && cs.pointerEvents !== 'none') {
      const ownText = [...el.childNodes]
        .filter((n) => n.nodeType === 3)
        .map((n) => n.textContent.trim())
        .join('');
      const hasTextBelow = !!(el.innerText || '').trim();
      const hasControlBelow = el.querySelector(INTERACTIVE) !== null;
      // 只有「这一整块连后代都没内容」才算空；否则那只是个大容器。
      if (!ownText && !hasTextBelow && !hasControlBelow) {
        push('大块可见空白', el, `${Math.round(r.width)}×${Math.round(r.height)}px 没有任何文字或可点元素`);
      }
    }
  }

  // ── 4) 文字对比度 ──
  // 体验规范里点过名：「色带压在刻度上会把对比度从 5.19 拉到 3.07（低于 4.5 可读线）」。
  // 既然规范用数字说话，就用数字查。
  const parse = (c) => {
    const m = String(c).match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(',').map((x) => parseFloat(x));
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const lum = ({ r, g, b }) => {
    const f = (v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const ratio = (a, b) => {
    const [hi, lo] = lum(a) > lum(b) ? [lum(a), lum(b)] : [lum(b), lum(a)];
    return (hi + 0.05) / (lo + 0.05);
  };
  /** 有效的背景色：一路往上找第一个不透明的底色。 */
  const background = (el) => {
    for (let p = el; p; p = p.parentElement) {
      const cs = style(p);
      if (cs.backgroundImage !== 'none') return null; // 渐变/图片背景算不出来，不猜
      const bg = parse(cs.backgroundColor);
      if (bg && bg.a >= 0.9) return bg;
    }
    return { r: 255, g: 255, b: 255, a: 1 };
  };
  const hasOwnText = (el) => [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
  const blend = (fg, bg) => ({
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
  });

  for (const el of all) {
    if (!hasOwnText(el) || !shown(el)) continue;
    const cs = style(el);
    const fg = parse(cs.color);
    const bg = background(el);
    if (!fg || !bg) continue;
    const size = parseFloat(cs.fontSize);
    const bold = Number(cs.fontWeight) >= 700;
    const large = size >= 24 || (size >= 18.66 && bold);
    const need = large ? 3 : 4.5;
    const got = ratio(blend(fg, bg), bg);
    if (got < need) {
      const hex = (c) => `#${[c.r, c.g, c.b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
      push('文字对比度不足', el, `${got.toFixed(2)}:1，低于可读线 ${need}:1（字号 ${size}px${bold ? ' 粗体' : ''}，${hex(fg)} on ${hex(bg)}）`);
    }
  }

  // ── 5) 浮层的定位基准 ──
  // 绝对定位的浮层（下拉、菜单、气泡）是按「最近的已定位祖先」算坐标的。祖先丢了
  // position:relative，基准就变成整个窗口：菜单掉到屏幕外，还把页面撑出滚动条，
  // 浏览器为了把菜单里的输入框滚进视野，会把顶栏整条顶出屏幕——症状是「一点按钮,
  // 整个界面错位」，而静态检查全绿。
  // 真实案例 2026-09-17：.board-bar 的 position:relative 在加「阅读/编辑」开关时被顺手删掉，
  // 点会议名即复现（下拉 top 从 56 变成 427、页面 scrollHeight 从 900 变成 1428）。
  for (const el of all) {
    if (style(el).position !== 'absolute') continue;
    let anchored = false;
    for (let p = el.parentElement; p; p = p.parentElement) {
      if (style(p).position !== 'static') { anchored = true; break; }
    }
    if (!anchored) {
      push('浮层没有已定位的祖先', el, 'position:absolute 但祖先链上都是 static —— 定位基准是整个窗口，换尺寸/换容器就会跑到视口外');
    }
    if (!shown(el)) continue;
    const r = el.getBoundingClientRect();
    const outside = r.right <= 0 || r.bottom <= 0 || r.left >= innerWidth || r.top >= innerHeight;
    if (outside) push('浮层开在视口外', el, `rect=(${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.width)}×${Math.round(r.height)}) 整个落在 ${innerWidth}×${innerHeight} 视口外`);
  }

  // ── 6) 页面横向溢出 ──
  const doc = document.documentElement;
  if (doc.scrollWidth - doc.clientWidth > 2) {
    problems.push({
      kind: '页面横向溢出',
      selector: 'html',
      detail: `scrollWidth=${doc.scrollWidth} > clientWidth=${doc.clientWidth}，多出 ${doc.scrollWidth - doc.clientWidth}px`,
      text: '',
    });
  }

  return problems;
}

// ────────────────────────────── 场景与视口矩阵 ──────────────────────────────

const makeEvents = (n) => Array.from({ length: n }, (_, i) => ({
  schemaVersion: 1,
  eventId: `e${i}`,
  type: 'segment',
  text: `第 ${i + 1} 句：这句话用来把逐字稿撑到足够长，好让滚动行为真实发生。`,
  ts: new Date(Date.now() - 600000 + i * 1000).toISOString(),
}));

const longDoc = `# 会议记录\n\n${Array.from({ length: 60 }, (_, i) => `## 第 ${i + 1} 节\n\n这一段正文用来把白板撑长，检查滚动是否可达。`).join('\n\n')}`;

const SCENARIOS = [
  { name: '空白会议（无逐字稿、无 AI 内容）', events: [], document: '', preliminary: null },
  { name: '只有逐字稿（AI 还没写）', events: makeEvents(40), document: '', preliminary: null },
  { name: 'AI 已写正文（长）', events: makeEvents(40), document: longDoc, preliminary: { text: longDoc, status: 'ready', model: 'minicpm5-meeting' } },
  { name: 'AI 整理失败（fallback）', events: makeEvents(40), document: '', preliminary: { text: '原始转写', status: 'fallback', model: 'minicpm5-meeting', error: 'Ollama 整理超时' } },
];

const VIEWPORTS = [
  { name: '桌面 1280×900', width: 1280, height: 900 },
  { name: '窄窗 900×760', width: 900, height: 760 },
  { name: '小窗 680×520', width: 680, height: 520 },
];

const TABS = ['raw', 'ai'];

// ────────────────────────────── 跑起来 ──────────────────────────────

const freePort = () => new Promise((resolve) => {
  const srv = require('node:net').createServer();
  srv.listen(0, '127.0.0.1', () => {
    const { port } = srv.address();
    srv.close(() => resolve(port));
  });
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForServer(url, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch { /* 还没起来 */ }
    await wait(150);
  }
  throw new Error(`服务没起来: ${url}`);
}

/** 起一个带夹具的临时服务，返回 { url, stop }。 */
async function startFixtureServer(scenario) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rtc-ux-'));
  const date = new Date().toISOString().slice(0, 10);
  fs.mkdirSync(path.join(dataDir, 'events'), { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, 'events', `${date}.jsonl`),
    scenario.events.map((e) => `${JSON.stringify(e)}\n`).join(''),
  );

  const port = await freePort();
  const proc = spawn(process.execPath, [path.join(root, 'server.js')], {
    cwd: root,
    env: { ...process.env, PORT: String(port), RTC_DATA_DIR: dataDir },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  const url = `http://127.0.0.1:${port}/meeting-board/`;
  await waitForServer(url);

  // 场次 id 由服务端算，问它要，别自己拼（时区差一点就对不上）。
  const sessions = await (await fetch(`http://127.0.0.1:${port}/api/meeting-board/sessions?date=${date}`)).json();
  const id = sessions.sessions?.at(-1)?.id;
  const board = { sessions: {} };
  if (id) board.sessions[id] = { document: scenario.document, ...(scenario.preliminary ? { preliminary: scenario.preliminary } : {}) };
  fs.writeFileSync(path.join(dataDir, 'meeting-board.json'), JSON.stringify(board));

  return {
    url,
    stop: () => {
      proc.kill('SIGTERM');
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

async function auditUrl(page, label, out) {
  const problems = await page.evaluate(auditPage);
  for (const p of problems) out.push({ where: label, ...p });
  return problems.length;
}

async function main() {
  const urlArg = process.argv.indexOf('--url');
  // --inject "<css>"：只用来给这个巡检自己做对照组——注入一段破坏性样式，看它会不会变红。
  // 「能报错」这件事必须能自证，否则它就是一盏永远绿的灯。
  const injectArg = process.argv.indexOf('--inject');
  const injectCss = injectArg !== -1 ? process.argv[injectArg + 1] : '';
  const browser = await chromium.launch();
  const findings = [];
  let audited = 0;

  if (urlArg !== -1) {
    // 巡检一个已经在跑的服务
    const url = process.argv[urlArg + 1];
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(url, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1200);
    if (injectCss) await page.addStyleTag({ content: injectCss });
    const sessionBtn = page.locator('#sessionBtn');
    if (await sessionBtn.count()) {
      await sessionBtn.click();
      await page.waitForTimeout(300);
      audited += 1;
      await auditUrl(page, `${url} · 下拉展开`, findings);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(250);
    }
    for (const tab of TABS) {
      const button = page.locator(`#preliminaryTabs .preliminary-tab[data-tab="${tab}"]`);
      if (await button.count()) { await button.click(); await page.waitForTimeout(400); }
      audited += 1;
      await auditUrl(page, `${url} · ${tab}`, findings);
    }
    await page.close();
  } else {
    for (const scenario of SCENARIOS) {
      const server = await startFixtureServer(scenario);
      try {
        const page = await browser.newPage({ viewport: VIEWPORTS[0] });
        await page.goto(server.url, { waitUntil: 'networkidle' });
        if (injectCss) await page.addStyleTag({ content: injectCss });
        await page.waitForSelector('#preliminaryTabs .preliminary-tab', { timeout: 20000 });
        await page.waitForTimeout(900);

        for (const vp of VIEWPORTS) {
          await page.setViewportSize({ width: vp.width, height: vp.height });
          await page.waitForTimeout(350);
          // 顶栏的场次下拉只有展开时才进 DOM —— 不点开就等于这块浮层从未被巡检过。
          // 它曾经因为祖先的 position:relative 被删而开到视口外（见上面 auditPage 里的记录）。
          const sessionBtn = page.locator('#sessionBtn');
          if (await sessionBtn.count()) {
            await sessionBtn.click();
            await page.waitForTimeout(300);
            audited += 1;
            await auditUrl(page, `${scenario.name} · ${vp.name} · 下拉展开`, findings);
            await page.keyboard.press('Escape');
            await page.waitForTimeout(250);
          }
          for (const tab of TABS) {
            const button = page.locator(`#preliminaryTabs .preliminary-tab[data-tab="${tab}"]`);
            if (await button.count()) { await button.click(); await page.waitForTimeout(350); }
            audited += 1;
            await auditUrl(page, `${scenario.name} · ${vp.name} · ${tab}`, findings);
          }
        }
        await page.close();
      } finally {
        server.stop();
      }
    }
  }

  await browser.close();

  // ── 汇总 ──
  const byKind = new Map();
  for (const f of findings) {
    if (!byKind.has(f.kind)) byKind.set(f.kind, []);
    byKind.get(f.kind).push(f);
  }

  console.log(`\n界面体验巡检：跑了 ${audited} 个组合（${SCENARIOS.length || 1} 场景 × ${VIEWPORTS.length} 视口 × ${TABS.length} 标签）`);
  console.log('─'.repeat(72));

  if (findings.length === 0) {
    console.log('没发现机械可判定的界面毛病。');
    process.exit(0);
  }

  // 同一种毛病在多个组合里重复出现，只报「出现在哪些组合」+ 一个代表，免得刷屏。
  // 想看全量：--all
  const showAll = process.argv.includes('--all');
  for (const [kind, items] of byKind) {
    const wheres = [...new Set(items.map((i) => i.where))];
    console.log(`\n■ ${kind}  （${items.length} 处，覆盖 ${wheres.length} 个组合）`);
    const seen = new Map();
    for (const it of items) {
      const key = `${it.selector}|${it.detail}`;
      if (!seen.has(key)) seen.set(key, it);
    }
    const list = [...seen.values()];
    for (const [i, it] of list.entries()) {
      if (!showAll && i >= 6) { console.log(`    …还有 ${list.length - 6} 种，加 --all 看全量`); break; }
      console.log(`    ${it.selector}  ← ${it.where}`);
      console.log(`        ${it.detail}`);
      if (it.text) console.log(`        文字: ${it.text}`);
    }
  }

  console.log('\n' + '─'.repeat(72));
  console.log(`合计 ${findings.length} 处发现，${byKind.size} 类问题。`);
  process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(2);
});
