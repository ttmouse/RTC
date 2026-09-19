// 白板两档切换的回归：逐字稿 / AI 会议内容。
//
// 白板上只有这两样东西——**AI 会议内容那一档就是白板正文本身**（可编辑，由模型生成），
// 不存在第三个「笔记区」。所以这里守四条产品规则：
//   1. **默认不给空面板**——AI 那档有内容就看它，没有就落到逐字稿，绝不让人对着空白等模型。
//   2. **原文不能冒充 AI 结论**——fallback 档里 preliminary.text 存的是原文，
//      它是「有 AI 记录」但不是「有 AI 稿」，混起来就是把原话盖上 AI 的戳。
//   3. **正文的优先级不能颠倒**——更聪明的模型写过的整篇 > 外部分析生成的那版 > 本地模型那版。
//   4. **有内容就只给内容**——不给「可直接编辑」「本地模型 · <模型名>」「未整理」这类自我说明；
//      说明只在没内容的时候出现（在内容区底部，不在标签栏）。
import { readFileSync } from 'node:fs';
import {
  resolveLocalText, localFailed, resolveRawText, resolveAiContent, makeContext,
  resolveDefaultTab, resolveTabs, resolveTabView, resolveShownTab, tabHasContent,
  preliminaryChanged, TAB_RAW, TAB_AI,
} from '../src/lib/preliminaryPanel.js';

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
};

const RAW = '[10:00] 先做这个吧。\n[10:01] 好。';
const LOCAL_TEXT = '先做这个吧，好。';
const LOCAL = { text: LOCAL_TEXT, status: 'ready', model: 'minicpm5-meeting' };
const FALLBACK = { text: RAW, status: 'fallback', error: 'Ollama 返回内容未通过原文保真校验' };
const DOC = '# 会议记录\n\n## 当前话题\n\n先做这个。';
const ANALYSIS = '# 会议记录\n\n## 行动项\n\n- 做这个';

const ctxOf = (extra = {}) => makeContext({ transcript: RAW, preliminary: LOCAL, ...extra });

// --- 本地模型那一版：fallback 存的原文不算数 ---

check('本地模型那一版取 preliminary.text', resolveLocalText(LOCAL) === LOCAL_TEXT);
check('fallback 下本地模型没有产出（那是原文不是稿）', resolveLocalText(FALLBACK) === '');
check('没有本地记录时是空的', resolveLocalText(null) === '');
check('只有空白的整理结果也算没有', resolveLocalText({ text: '   ', status: 'ready' }) === '');
check('localFailed 认得出 fallback', localFailed(FALLBACK) === true && localFailed(LOCAL) === false);

check('逐字稿档的正文就是 transcript', resolveRawText(RAW) === RAW);
check('没有 transcript 时逐字稿是空的（不会拿 fallback 的原文冒充）', resolveRawText('') === '');

// --- AI 那一档的正文来源：正文 > 分析 > 本地模型 ---

check('有白板正文时用正文', resolveAiContent({ document: DOC, preliminary: LOCAL }).kind === 'document');
check('有白板正文时忽略本地模型那版', resolveAiContent({ document: DOC, preliminary: LOCAL }).text === DOC);
check('没有正文时用外部分析生成的那版', resolveAiContent({ analysisText: ANALYSIS, preliminary: LOCAL }).kind === 'analysis');
check('分析那版优先于本地模型', resolveAiContent({ analysisText: ANALYSIS, preliminary: LOCAL }).text === ANALYSIS);
check('只有本地模型时用它垫一版', resolveAiContent({ preliminary: LOCAL }).kind === 'local');
check('只有本地模型时正文就是它', resolveAiContent({ preliminary: LOCAL }).text === LOCAL_TEXT);
check('什么都没有时是空的', resolveAiContent({}).kind === 'none' && resolveAiContent({}).text === '');
check('只有 fallback 记录时仍是空的（原文不算 AI 稿）', resolveAiContent({ preliminary: FALLBACK }).kind === 'none');
check('空白正文不会被当成有内容', resolveAiContent({ document: '   ', preliminary: LOCAL }).kind === 'local');

// 本地模型整理完会直接把结果写进白板正文，所以「正文」和「本地模型那一版」经常是同一份东西。
// 这时要如实标成 local——**但出处只给程序判断用，界面一个字都不显示它**（见下面第 4 条）。
check('正文正好等于本地模型输出时标成 local（如实说出处）',
  resolveAiContent({ document: LOCAL_TEXT, preliminary: LOCAL }).kind === 'local');
check('正文被 agent 或用户改过就标成 document',
  resolveAiContent({ document: `${LOCAL_TEXT}（补充）`, preliminary: LOCAL }).kind === 'document');
check('没有本地记录时正文就是 document',
  resolveAiContent({ document: DOC }).kind === 'document');

// --- 默认档位：AI 优先，没有就落到逐字稿 ---

check('AI 那档有内容时默认看 AI', resolveDefaultTab(ctxOf()) === TAB_AI);
check('AI 那档只有正文时也默认看 AI', resolveDefaultTab(makeContext({ transcript: RAW, document: DOC })) === TAB_AI);
check('没有 AI 内容时默认落到逐字稿', resolveDefaultTab(makeContext({ transcript: RAW })) === TAB_RAW);
check('生成失败时默认落到逐字稿，不是空着的 AI 档', resolveDefaultTab(makeContext({ transcript: RAW, preliminary: FALLBACK })) === TAB_RAW);
check('两档都没内容时默认逐字稿（而不是 AI 空档）', resolveDefaultTab(makeContext({})) === TAB_RAW);

// --- 切换本身：任何一档都要给得出内容 ---

const full = ctxOf({ document: DOC });
const rawView = resolveTabView(TAB_RAW, full);
const aiView = resolveTabView(TAB_AI, full);
check('切到逐字稿看到原话', rawView.text === RAW && rawView.tab === TAB_RAW);
check('切到 AI 看到白板正文', aiView.text === DOC && aiView.tab === TAB_AI);
check('两档内容不同（切换真的换了内容）', rawView.text !== aiView.text);
check('有 AI 内容时切回逐字稿，原话一份不少', rawView.text === RAW);
check('AI 那档的正文由编辑器呈现，但 text 仍报出内容供数行数', aiView.text.trim().length > 0);

// --- 有内容就只给内容：不给「可直接编辑 / 本地模型 · <模型名>」这类自我说明 ---
// 这类文案曾经摆在标签栏右侧（屏幕最上方、离内容最远，说的却是内容自己的事），
// 已被明确要求不再展示。「能不能编辑」顶栏的「编辑」按钮已经在说。

check('有内容时不写说明（正文自己就是全部）', aiView.note === '', aiView.note);
check('逐字稿那档有内容时也不写说明', rawView.note === '', rawView.note);
check('view 里不再有 status 这一栏（顶栏没有放状态文案的位置）',
  aiView.status === undefined && rawView.status === undefined);

const readyKinds = {
  document: makeContext({ transcript: RAW, document: DOC }),
  analysis: makeContext({ transcript: RAW, analysisText: ANALYSIS }),
  local: makeContext({ transcript: RAW, preliminary: LOCAL }),
};
Object.entries(readyKinds).forEach(([kind, ctx]) => {
  const view = resolveTabView(TAB_AI, ctx);
  check(`「${kind}」那一版有内容时同样一个字的自我说明都不写`,
    view.state === 'ready' && view.note === '' && view.status === undefined, JSON.stringify(view));
});

// --- AI 还没有内容：切过去也要说清楚在等什么，不能空白 ---

const pendingView = resolveTabView(TAB_AI, makeContext({ transcript: RAW, pending: true }), { pending: true });
check('还没跑时说清在等什么', pendingView.state === 'pending' && pendingView.note.includes('整理'), pendingView.note);
check('还没跑时不写 status', pendingView.status === undefined);
check('还没跑时逐字稿那档照常可看', resolveTabView(TAB_RAW, makeContext({ transcript: RAW, pending: true })).text === RAW);

// --- 生成失败：AI 档如实说失败并指路，不拿原文冒充 ---

const failView = resolveTabView(TAB_AI, makeContext({ transcript: RAW, preliminary: FALLBACK }));
check('AI 档在 fallback 下如实说生成失败', failView.state === 'fallback' && failView.status === undefined);
check('AI 档不把原文当 AI 内容显示', failView.text !== RAW && failView.text === '');
check('AI 档的说明带上失败原因', failView.note.includes('原文保真校验'), failView.note);
check('AI 档的说明指路逐字稿', failView.note.includes('逐字稿'), failView.note);
check('逐字稿那档仍给得出完整原话', resolveTabView(TAB_RAW, makeContext({ transcript: RAW, preliminary: FALLBACK })).text === RAW);

// --- 标签：两档都要在，且带上内容量 ---

const tabs = resolveTabs(full);
check('一共两档', tabs.length === 2);
check('标签顺序是 逐字稿 → AI', tabs[0].tab === TAB_RAW && tabs[1].tab === TAB_AI);
check('标签文字分别是 逐字稿 / AI 会议内容', tabs[0].label === '逐字稿' && tabs[1].label === 'AI 会议内容');
check('标签带上各行行数', tabs[0].count === 2 && tabs[1].count >= 1, JSON.stringify(tabs));
check('两档都有内容时都标 hasContent', tabs[0].hasContent && tabs[1].hasContent);

const tabsNoAi = resolveTabs(makeContext({ transcript: RAW }));
check('还没有 AI 内容时 AI 标签仍在（用户要知道有这一档）', tabsNoAi.length === 2 && tabsNoAi[1].hasContent === false);
check('还没有 AI 内容时 AI 标签计数为 0', tabsNoAi[1].count === 0);

// --- tabHasContent 是自动落档的依据 ---

check('tabHasContent 认得出 AI 档有内容', tabHasContent(TAB_AI, ctxOf()) === true);
check('tabHasContent 认得出 fallback 时 AI 档没内容', tabHasContent(TAB_AI, makeContext({ transcript: RAW, preliminary: FALLBACK })) === false);
check('tabHasContent 认出逐字稿档有内容', tabHasContent(TAB_RAW, makeContext({ transcript: RAW, preliminary: FALLBACK })) === true);
const blank = makeContext({});
check('tabHasContent 在两档全空时为 false', !tabHasContent(TAB_RAW, blank) && !tabHasContent(TAB_AI, blank));

// --- resolveShownTab：自动决定 vs 用户手动选 ---
// 守两条容易搞反的规则：
//   auto   —— 不给空面板，AI 没内容就落到逐字稿。
//   手动选 —— 点了哪档就显示哪档，哪怕它是空的。用回落把点击吃掉，
//             等于告诉用户这个标签是坏的；空的 AI 档本来就会说清「生成失败/生成中」。

const autoNoAi = resolveShownTab(TAB_AI, makeContext({ transcript: RAW }), { auto: true });
check('自动模式下 AI 没内容时显示逐字稿', autoNoAi.tab === TAB_RAW);
check('自动模式下高亮跟显示一致', autoNoAi.active === TAB_RAW);

const autoHasAi = resolveShownTab(TAB_AI, ctxOf(), { auto: true });
check('自动模式下 AI 有内容时显示 AI', autoHasAi.tab === TAB_AI && autoHasAi.active === TAB_AI);

const manualEmptyAi = resolveShownTab(TAB_AI, makeContext({ transcript: RAW, preliminary: FALLBACK }), { auto: false });
check('手动点 AI 且没内容时，仍然显示 AI 档', manualEmptyAi.tab === TAB_AI, manualEmptyAi.tab);
check('手动选的那档会高亮（点了要有反应）', manualEmptyAi.active === TAB_AI);

const manualRaw = resolveShownTab(TAB_RAW, ctxOf(), { auto: false });
check('手动点逐字稿时不被 AI 抢走', manualRaw.tab === TAB_RAW);

check('两档全空时自动模式显示逐字稿', resolveShownTab(TAB_AI, makeContext({}), { auto: true }).tab === TAB_RAW);

// 空的 AI 档必须有话可说，否则「照做显示空档」就成了真的空白
check('空的 AI 档不是空白：说清楚为什么没内容', failView.note.trim().length > 20, failView.note);
check('空的 AI 档指路逐字稿', failView.note.includes('逐字稿'));

// --- 空场次：两档都要有话说 ---

const emptyCtx = makeContext({});
const emptyRaw = resolveTabView(TAB_RAW, emptyCtx);
const emptyAi = resolveTabView(TAB_AI, emptyCtx);
check('空场次的逐字稿档说「还没有转写内容」', emptyRaw.state === 'empty' && emptyRaw.text.includes('还没有转写'));
check('空场次的 AI 档也说得出话', emptyAi.note.length > 0 && emptyAi.state === 'empty');
check('空场次的 AI 档可写（说明里点出可以直接写）', emptyAi.note.includes('直接'), emptyAi.note);

// --- 每一条路径的文字都必须是字符串 ---

[rawView, aiView, pendingView, failView, emptyRaw, emptyAi].forEach((view, i) => {
  check(`第 ${i + 1} 种视图的正文/说明都是字符串`,
    typeof view.text === 'string' && typeof view.note === 'string');
});

// --- 标签栏里不许再出现状态文案（结构级的守门） ---
// 上面断的是「有内容时说明为空」，这里断「就算有人把说明搬回标签栏也过不了」：
// 标签栏模板里除了两档标签，不该有第二个承载文字的节点。

const mainSrc = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const barHtml = mainSrc.slice(mainSrc.indexOf('preliminary-tabbar'), mainSrc.indexOf('board-panes'));
check('标签栏模板里只有标签', barHtml.includes('preliminary-tabs') && !barHtml.includes('preliminary-status'),
  barHtml.trim().slice(0, 160));
check('代码里不再有标签栏状态元素',
  !mainSrc.includes('preliminaryStatus') && !mainSrc.includes('preliminary-status'));
check('没有把 view.status 写回 DOM 的地方', !mainSrc.includes('view.status'));

// --- 「同稿重跑」必须被认出来（force=1 按钮的命门） ---
// 指纹只认逐字稿内容。强制重跑时逐字稿没改 → 指纹一样，只有 updatedAt 会变。
// 这一组就是守着「只比指纹 → 新结果送不上来、按钮卡在处理中」那个 bug。

const FP = 'sha256-abc';
const run1 = { text: '第一版', status: 'ready', sourceFingerprint: FP, updatedAt: '2026-01-01T00:00:00.000Z' };
const run2 = { text: '第二版', status: 'ready', sourceFingerprint: FP, updatedAt: '2026-01-01T00:01:00.000Z' };
const otherTranscript = { text: '别的稿', status: 'ready', sourceFingerprint: 'sha256-def', updatedAt: '2026-01-01T00:02:00.000Z' };

check('同稿重跑（指纹同、updatedAt 变）认得出是新结果',
  preliminaryChanged(run2, run1) === true);
check('转写更新（指纹变）认得出是新结果',
  preliminaryChanged(otherTranscript, run1) === true);
check('同一份值再取一次不算变化（否则每 2 秒重挂一次编辑器）',
  preliminaryChanged(run1, { ...run1 }) === false);
check('之前没有过、现在有了算变化', preliminaryChanged(run1, null) === true);
check('什么都没取到就不算变化', preliminaryChanged(null, run1) === false);
check('失败结果（fallback 也带新 updatedAt）同样认得出',
  preliminaryChanged({ ...run1, status: 'fallback', updatedAt: '2026-01-01T00:03:00.000Z' }, run1) === true);

// --- 接线：main.js 必须用 preliminaryChanged，不能退回只比指纹 ---
check('轮询里用的是 preliminaryChanged',
  mainSrc.includes('preliminaryChanged(board.preliminary, preliminary)'));
check('轮询里不再残留只比 sourceFingerprint 的旧判定',
  !mainSrc.includes('board.preliminary.sourceFingerprint !== preliminary?.sourceFingerprint'));

// --- makeContext 不吞掉原始输入（UI 依赖它算行数和状态） ---

const mc = makeContext({ transcript: RAW, document: DOC, preliminary: LOCAL, pending: true });
check('makeContext 保留 transcript', mc.transcript === RAW);
check('makeContext 挑出正文那一档', mc.aiKind === 'document' && mc.aiText === DOC);
check('makeContext 带上模型名和 pending', mc.aiModel === 'minicpm5-meeting' && mc.pending === true);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
