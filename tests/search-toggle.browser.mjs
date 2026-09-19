/**
 * 顶栏入口的真浏览器巡检：`npm run check:search`（主要是搜索入口，另含这一排图标的悬停）
 *
 * 它钉的是「搜索从常驻输入框改成顶栏一个图标」之后的几条行为——读代码看不出来，
 * 静态检查和单测也测不到，只有把页面真跑起来才知道：
 *   1) 默认：顶栏图标在、搜索行不在（这条就是这次改动的全部意义，最容易被顺手改回去）；
 *   2) 点图标：行展开、光标**直接落进输入框**（不聚焦等于让用户再点一次）；
 *   3) Esc 一步一跳：有词先清词且框留着，词空了再按才收起；
 *   4) 带着关键词收起：关键词必须一起清掉（否则列表被一份看不见的过滤条件压着）；
 *   5) 和设置页联动：整页覆盖时搜索行让开，回来按 `body.search-open` 恢复；
 *   6) 聚焦的边框是偏灰的墨色（--ink-faint），**不是印章红**：红是稀缺色，一个按需
 *      打开的框每次亮红一下就是在消耗它；
 *   7) 顶栏那一排图标（六个）悬停时给一层浅色纸底（--paper-2）+ 图标转墨色，不再变印章红——
 *      一排六个图标，鼠标扫过去时不该整排都在闪红。
 *
 * 数据走临时目录（RTC_DATA_DIR）+ 自造的几条夹具记录，跑完即删，不碰真实转写；
 * 麦克风拦掉，巡检不录音、不改配置。
 *
 * 自证：`--break=visible|hidden|red|hoverred|esc` 会故意卸掉对应的实现，检查必须变红。
 * 「能报错」这件事必须能自证，否则它就是一盏永远绿的灯。
 *
 * 需要 Playwright（和 check:ux / check:audio 一样，不在仓库依赖里）。装不上时退出码 2（= 没跑成，不是通过）。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  console.error('这个巡检需要 Playwright，但当前解析不到它。');
  console.error('装一个即可：npm i -D playwright && npx playwright install chromium');
  process.exit(2);
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((resolve) => {
  const srv = net.createServer();
  srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
});
async function waitForServer(url, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try { if ((await fetch(url)).ok) return; } catch { /* 还没起来 */ }
    await wait(150);
  }
  throw new Error(`服务没起来: ${url}`);
}

// ── 夹具：3 条记录，够验证「搜索真的重新查过」和「清词后回到全部」 ──
const events = [
  { schemaVersion: 1, eventId: 'e1', type: 'segment', text: '这一句里有苹果，搜到它就对了', ts: new Date(Date.now() - 300000).toISOString() },
  { schemaVersion: 1, eventId: 'e2', type: 'segment', text: '这一句里有香蕉，不该被搜出来', ts: new Date(Date.now() - 240000).toISOString() },
  { schemaVersion: 1, eventId: 'e3', type: 'segment', text: '这一句什么都没有', ts: new Date(Date.now() - 180000).toISOString() },
];

async function startFixtureServer() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rtc-search-'));
  const date = new Date().toISOString().slice(0, 10);
  fs.mkdirSync(path.join(dataDir, 'events'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'events', `${date}.jsonl`), events.map((e) => `${JSON.stringify(e)}\n`).join(''));

  const port = await freePort();
  // RTC_DEV=1：直接服务 src/。不带它服务的是 dist/，巡检就永远跑在上一次构建上——
  // 改完源码还没 build 时，这里会拿旧页面得出假结论。
  const proc = spawn(process.execPath, [path.join(root, 'server.js')], {
    cwd: root,
    env: { ...process.env, RTC_DEV: '1', PORT: String(port), RTC_DATA_DIR: dataDir },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  const url = `http://127.0.0.1:${port}/`;
  await waitForServer(url);
  return {
    url,
    stop: () => { proc.kill('SIGTERM'); fs.rmSync(dataDir, { recursive: true, force: true }); },
  };
}

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
};

async function main() {
  // ── 自证用的破坏开关：故意把实现卸掉一种，看检查会不会红 ──
  const breakArg = process.argv.find((a) => a.startsWith('--break='))?.slice('--break='.length);
  const sabotageCss = {
    visible: '#queryBar{ display:flex !important; }',                        // 假装又变回常驻输入框
    hidden: '#queryBar{ display:none !important; }',                         // 假装图标点了没反应
    red: '#searchInput:focus{ border-color:#bf3a1e !important; }',            // 假装聚焦又变回印章红
    // 假装悬停又改回「无底色 + 印章红」
    hoverred: '#searchBtn:hover, #statsBtn:hover, #shareBtn:hover, #cmdBtn:hover, #meetingBoardBtn:hover, #settingsBtn:hover{ background:none !important; color:#bf3a1e !important; }',
  }[breakArg];
  const sabotageEsc = breakArg === 'esc';               // 假装 Esc 没人管
  if (breakArg && !sabotageCss && !sabotageEsc) {
    console.error(`未知的 --break=${breakArg}，可选：visible / hidden / red / hoverred / esc`);
    process.exit(2);
  }
  if (breakArg) console.log(`\n（自证模式 --break=${breakArg}：故意卸掉对应实现，下面应当出现 ✗）\n`);

  const server = await startFixtureServer();
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.addInitScript(({ killEsc }) => {
    navigator.mediaDevices.getUserMedia = () => Promise.reject(new Error('check:search 拦掉了麦克风'));
    navigator.mediaDevices.enumerateDevices = () => Promise.resolve([]);
    if (killEsc) {
      // 捕获阶段就把 Esc 吃掉：输入框上的 onkeydown 永远收不到，等于这条实现不存在
      document.addEventListener('keydown', (e) => { if (e.key === 'Escape') e.stopImmediatePropagation(); }, true);
    }
  }, { killEsc: !!sabotageEsc });

  const page = await ctx.newPage();
  const vis = (sel) => page.locator(sel).isVisible();
  try {
    await page.goto(server.url, { waitUntil: 'networkidle' });
    await page.waitForTimeout(700);
    if (sabotageCss) await page.addStyleTag({ content: sabotageCss });

    // 1) 默认状态
    const lineCount = () => page.locator('#list .line').count();
    check('默认：顶栏有搜索图标', await vis('#searchBtn'));
    check('默认：搜索那一行不占版面', !(await vis('#queryBar')));
    check('默认：图标与其它顶栏图标共用盒模型（无边框无底色）', await page.evaluate(() => {
      const btn = document.getElementById('searchBtn');
      const peer = document.getElementById('cmdBtn');
      if (!btn || !peer) return false;
      const a = getComputedStyle(btn);
      const b = getComputedStyle(peer);
      return ['borderTopWidth', 'backgroundColor', 'padding', 'color'].every((k) => a[k] === b[k]);
    }));
    const all = await lineCount();

    // 2) 点图标 → 展开 + 聚焦。展开这一步若就失败，后面几条行为全都无从验证：
    //    提前收尾，不让 Playwright 的 fill 超时把整轮打断
    //    （自证模式 --break=hidden 走的正是这条路径）。
    await page.click('#searchBtn');
    await page.waitForTimeout(200);
    const opened = await vis('#queryBar');
    check('点图标：搜索行展开', opened);
    if (!opened) console.log('  （搜索行没展开，后面几条无从验证，已跳过）');
    if (opened) {
      check('点图标：光标直接落进输入框', (await page.evaluate(() => document.activeElement?.id)) === 'searchInput');
      check('点图标：aria-expanded=true', (await page.getAttribute('#searchBtn', 'aria-expanded')) === 'true');
      check('聚焦：边框是偏灰的墨色，不是印章红', await page.evaluate(() => {
        const el = document.getElementById('searchInput');
        const border = getComputedStyle(el).borderTopColor;
        const rgb = (hex) => {
          const v = hex.replace('#', '');
          return `rgb(${parseInt(v.slice(0, 2), 16)}, ${parseInt(v.slice(2, 4), 16)}, ${parseInt(v.slice(4, 6), 16)})`;
        };
        return border === rgb('#8f8572') && border !== rgb('#bf3a1e');
      }), '--ink-faint #8f8572');

      // 3) 搜索真的生效（夹具里只有一条含「苹果」）
      await page.fill('#searchInput', '苹果');
      await page.waitForTimeout(600);
      const hit = await lineCount();
      check('输入关键词：列表只剩命中的那一条', hit === 1 && all === 3, `${all} → ${hit}`);

      // 4) Esc 一步一跳
      await page.press('#searchInput', 'Escape');
      await page.waitForTimeout(500);
      check('Esc①：关键词被清掉', (await page.inputValue('#searchInput')) === '');
      check('Esc①：搜索行仍在（词和框不一起消失）', await vis('#queryBar'));
      check('Esc①：列表回到全部记录', (await lineCount()) === all, `${await lineCount()}/${all}`);
      await page.press('#searchInput', 'Escape');
      await page.waitForTimeout(200);
      check('Esc②：搜索行收起', !(await vis('#queryBar')));

      // 5) 带着关键词收起 → 关键词一并清掉（不许留看不见的过滤）
      //    先回到「已展开」这个已知状态：上一步的 Esc 收起若没生效，这里就得多点一次，
      //    否则本节会以「输入框不可见」的超时收场，而不是老老实实记一笔失败。
      if (!(await vis('#queryBar'))) {
        await page.click('#searchBtn');
        await page.waitForTimeout(150);
      }
      const canFill = await page.locator('#searchInput').isVisible();
      if (!canFill) console.log('  （搜索行没能展开，本节 3 条无从验证，已跳过）');
      if (canFill) {
        await page.fill('#searchInput', '苹果');
      await page.waitForTimeout(600);
      await page.click('#searchBtn');
      await page.waitForTimeout(600);
      check('有词时收起：行收起', !(await vis('#queryBar')));
      check('有词时收起：关键词一起清空', await page.evaluate(() => {
        const el = document.getElementById('searchInput');
        return el.value === '' && !document.body.classList.contains('search-open');
      }));
      check('有词时收起：列表不再被看不见的过滤压着', (await lineCount()) === all, `${await lineCount()}/${all}`);
      }

      // 6) 与设置页的联动
      await page.click('#searchBtn');
      await page.waitForTimeout(150);
      await page.click('#settingsBtn');
      await page.waitForTimeout(400);
      check('进设置页：搜索行让开', !(await vis('#queryBar')));
      await page.click('#settingsClose');
      await page.waitForTimeout(400);
      check('回主界面：设置页关掉', !(await vis('#settingsPage')));
      check('回主界面：搜索行按 body.search-open 恢复（两套显隐写法没打架）', await vis('#queryBar'));
    }

    // 7) 顶栏那一排图标的悬停：浅色纸底 + 墨色图标（不是印章红）。六个一起验——
    //    这一排的价值就在「整排一致」，只验一个的话，漏掉的那个又会长成贴歪的方块。
    const ICONS = ['searchBtn', 'statsBtn', 'shareBtn', 'cmdBtn', 'meetingBoardBtn', 'settingsBtn'];
    const offSpec = [];
    for (const id of ICONS) {
      await page.hover(`#${id}`);
      await page.waitForTimeout(80);
      const { bg, fg } = await page.evaluate((el) => {
        const cs = getComputedStyle(document.getElementById(el));
        return { bg: cs.backgroundColor, fg: cs.color };
      }, id);
      // --paper-2 #ece4d4 / --ink #1a1611（印章红 #bf3a1e 自然被排除在外）
      if (bg !== 'rgb(236, 228, 212)' || fg !== 'rgb(26, 22, 17)') offSpec.push(`${id}=${bg}/${fg}`);
    }
    check('悬停：六个顶栏图标都是浅纸底 + 墨色图标', offSpec.length === 0, offSpec.join(' '));
  } finally {
    await browser.close();
    server.stop();
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n搜索入口巡检：${results.length - failed.length}/${results.length} 通过`);
  if (breakArg) {
    // 自证模式：红才是对的
    console.log(failed.length
      ? `自证通过：--break=${breakArg} 让 ${failed.length} 条变红了（这盏灯会亮）`
      : `自证失败：--break=${breakArg} 之后一条都没红——这盏灯不会亮，等于没装`);
    process.exit(failed.length ? 0 : 1);
  }
  process.exit(failed.length ? 1 : 0);
}

await main();
