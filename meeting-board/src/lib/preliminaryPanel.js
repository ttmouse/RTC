// 白板上只有两样东西：`逐字稿` 和 `AI 会议内容`。
//
// **没有第三个「笔记区」。** AI 会议内容那一档本身就是白板正文（可编辑），由模型生成：
// 现在用本地模型垫一版，以后可以换成更聪明的模型整篇替换。所以每场会议只有两样东西——
// 逐字稿 + AI 会议内容，正好对应两个标签页。
//
// 抽成纯函数是因为这里的 bug 全是「显示错了来源」：把没整理过的原话当成 AI 稿、
// 或者模型还没跑却让人以为已经跑完了。它跟 DOM 无关，所以能直接断言，不用起浏览器。
//
// 三个来源要分清楚，历史上混过一次：
//   document —— 白板正文本身（已保存）。外部/更聪明的模型写的，或用户自己改的。**它就是 AI 会议内容。**
//   analysis —— 外部分析结果（结构化）。白板正文还没有时，拿它生成一版垫上。
//   local    —— 本地模型整理的逐字稿（preliminary 字段）。最先有的那一版，会随转写更新。
// 陷阱是 `status: 'fallback'`：那时 preliminary.text 存的是**原文**（服务端把 transcript
// 抄了进去），所以「有 preliminary」不等于「有 AI 稿」。

export const TAB_RAW = 'raw';
export const TAB_AI = 'ai';

/** 本地模型整理的那一版正文。fallback 存的是原文，不算 AI 稿。 */
export function resolveLocalText(preliminary) {
  if (!preliminary || preliminary.status === 'fallback') return '';
  return String(preliminary.text || '').trim() ? String(preliminary.text) : '';
}

/** 本地模型跑过但失败了吗？用来区分「还没跑」和「跑了但失败」——两者的提示不一样。 */
export function localFailed(preliminary) {
  return preliminary?.status === 'fallback';
}

/**
 * 新取到的 preliminary 值不值得覆盖当前显示的那一版。
 *
 * **必须连 updatedAt 一起比，只比 sourceFingerprint 会漏掉「同稿重跑」。**
 * 指纹是逐字稿内容的哈希（见 server.js 的 preliminarySourceFingerprint）：指纹变了
 * = 转写更新了，这是自动整理的触发条件。但「本地 AI 处理」按钮走的是 force=1，
 * 逐字稿一个字都没改，所以重跑出来的指纹和旧版**完全相同**——
 * 只比指纹的话新结果永远送不上来，按钮还会一直卡在「本地 AI 处理中…」。
 * updatedAt 是服务端每跑完一次都会刷新的版本号，用它才认得出一份新结果。
 *
 * 注意这只回答「要不要采用这份值」，不回答「正文该显示谁」：
 * 正文的优先级仍归 resolveAiContent（白板正文 > 外部分析 > 本地模型）。
 * 所以用户手改过正文时，这里即使认出新结果，也不会覆盖用户写的东西。
 */
export function preliminaryChanged(next, prev) {
  if (!next) return false;
  if (!prev) return true;
  return next.sourceFingerprint !== prev.sourceFingerprint
    || next.updatedAt !== prev.updatedAt;
}

/** 逐字稿那一档的正文。 */
export function resolveRawText(transcript) {
  return String(transcript || '');
}

/**
 * AI 会议内容那一档的正文和出处。
 *
 * 优先级：白板正文 > 外部分析生成的那版 > 本地模型那一版。
 *
 * 注意「白板正文」和「本地模型那一版」经常是同一份东西：本地模型整理完会直接把结果写进
 * 白板正文（它和外部 agent 写的是同一样东西）。所以正文正好等于本地模型输出时标成 'local'。
 *
 * **出处只是给程序看的标签，界面一个字都不显示它**：`kind` 用来断言正文取的是哪一份
 * （取错了就会拿 fallback 的原文冒充 AI 稿），不在界面上念。见 resolveTabView 顶上的说明。
 */
export function resolveAiContent({ document: documentText, analysisText, preliminary } = {}) {
  const saved = String(documentText || '').trim();
  const local = resolveLocalText(preliminary);
  if (saved) {
    if (local && String(documentText) === local) return { text: String(documentText), kind: 'local' };
    return { text: String(documentText), kind: 'document' };
  }
  const fromAnalysis = String(analysisText || '').trim();
  if (fromAnalysis) return { text: String(analysisText), kind: 'analysis' };
  if (local) return { text: local, kind: 'local' };
  return { text: '', kind: 'none' };
}

/** 把原始数据整理成后面几个函数认的上下文，省得每个函数都拆一遍。 */
export function makeContext({ transcript, document: documentText, analysisText, preliminary, pending = false } = {}) {
  const ai = resolveAiContent({ document: documentText, analysisText, preliminary });
  return {
    transcript: resolveRawText(transcript),
    aiText: ai.text,
    aiKind: ai.kind,
    aiModel: preliminary?.model || '',
    aiError: preliminary?.error ? String(preliminary.error) : '',
    aiFailed: localFailed(preliminary),
    pending,
  };
}

/** 某一档此刻有没有内容。UI 用它决定标签要不要置灰。 */
export function tabHasContent(tab, ctx) {
  return tab === TAB_AI ? !!ctx.aiText.trim() : !!ctx.transcript.trim();
}

/**
 * 默认打开哪一档。
 *
 * AI 会议内容是白板的正主，有就先看它；没有才落到逐字稿——不让人对着空白等模型。
 */
export function resolveDefaultTab(ctx) {
  return ctx.aiText.trim() ? TAB_AI : TAB_RAW;
}

/**
 * 真正该显示哪一档。两种情形必须分开，这是这个函数存在的全部理由：
 *
 * 1. **没有人为选择时**（auto）——按内容决定，不给空白。
 * 2. **用户明确点了某一档**（!auto）——就给他看那一档，哪怕它还没内容。
 *    空的 AI 档不是空白：它会说清「生成中 / 生成失败 / 还没有」，而且能直接在上面写。
 *    用自动回落把用户的点击吃掉，等于告诉他这个标签是坏的。
 */
export function resolveShownTab(want, ctx, { auto = false } = {}) {
  const shown = (!auto || tabHasContent(want, ctx)) ? want : resolveDefaultTab(ctx);
  return { tab: shown, active: shown };
}

/**
 * 两档的标签文字。都带上内容行数——否则用户切过去之前不知道值不值得切。
 * 数量按非空行算，和看到的行数一致。
 */
export function resolveTabs(ctx) {
  const lines = (value) => (value ? value.split('\n').filter((line) => line.trim()).length : 0);
  return [
    { tab: TAB_RAW, label: '逐字稿', count: lines(ctx.transcript), hasContent: !!ctx.transcript.trim() },
    { tab: TAB_AI, label: 'AI 会议内容', count: lines(ctx.aiText), hasContent: !!ctx.aiText.trim() },
  ];
}

/**
 * 某一档的完整视图：正文、底部说明、给 CSS 用的 data 值。
 * UI 只负责「把值塞进去」，判断都留在这里。
 *
 * **有内容就只给内容，一个字的说明也不写。** 这一档是什么、能不能改、是谁生成的，
 * 都不是用户此刻要读的东西：「能不能编辑」顶栏的「编辑」按钮已经在说，出处属于实现细节。
 * 说明只在**没有内容**的时候出现——那时它是唯一能回答「为什么空着、还要不要等」的东西。
 * 所以 view 里没有 `status` 这一栏：过去它会被摆在标签栏右侧（离内容最远、最显眼的地方），
 * 写着「可直接编辑」「本地模型 · xxx」「未整理」这类自我说明。别把它加回来。
 *
 * 注意 AI 那一档的 text 只用来判断有没有内容 / 数行数：它的正文由编辑器呈现（能直接改），
 * 不走 textContent。真正塞进 <pre> 的只有逐字稿。
 */
export function resolveTabView(tab, ctx, { pending = false } = {}) {
  if (tab === TAB_AI) {
    if (ctx.aiText.trim()) {
      return { tab: TAB_AI, state: 'ready', note: '', text: ctx.aiText };
    }
    if (ctx.aiFailed) {
      return {
        tab: TAB_AI,
        state: 'fallback',
        note: `本地模型没跑成功（${ctx.aiError.slice(0, 80) || '未通过原文保真校验'}）。逐字稿不受影响，也可以直接在这里写。`,
        text: '',
      };
    }
    return {
      tab: TAB_AI,
      state: pending ? 'pending' : 'empty',
      note: pending
        ? '正在整理这场会议的转写，整理好会自动出现在这里；不想等也可以直接在这里写。'
        : '本地模型整理完成后会出现在这里；也可以直接在这里写，逐字稿那一档随时可看。',
      text: '',
    };
  }

  if (ctx.transcript.trim()) {
    return { tab: TAB_RAW, state: 'raw', note: '', text: ctx.transcript };
  }
  return {
    tab: TAB_RAW,
    state: pending ? 'pending' : 'empty',
    note: pending ? '正在读取这场会议的转写…' : '开始说话后，逐字稿会出现在这里，不需要等 AI。',
    text: pending ? '正在读取这场会议的转写…' : '这场会议还没有转写内容。',
  };
}
