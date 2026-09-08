import { state } from './state.js';
import { $ } from './ui.js';
import { fetchLocalConfig, saveLocalConfig } from './storage.js';

export const DEFAULT_RULES = `美塔提示词 => Meta Prompt
菲格马 => figma
(正种表达式|策个当时) => 正则表达式
(正州|郑哲|正者|症者) => 正则
录入正者 => 录入正则
(promt|proment|proement|promon|Proment) => prompt
(提生词|提审什吗|提系|提诗词|提誓词) => 提示词
(土豆子|兔豆s|代办) => todos
(ca手|co手|咳索|科索|抠诉|可诉|可说) => Cursor
(D不是这|Deep塞|Deepick|deepick|deepake|第不是|deipick|deipt|depsick|deeps|G不ick|d不tick|de不的天|deept) => DeepSeek
(geh) => GitHub
(typepe|taber|typeap) => Tab
发不 => 发布
(层疾|层绩) => 层级
(RP) => RPA
(拓肯) => Token
P脸 => PDF
(Ttter|推tter|推特|ttter|腿特) => Twitter
(TK|tktok) => TikTok
(GVT|恰的GBT|掐个鸡不T|恰克GPT|恰的GPT) => ChatGPT
Face事book => Facebook
faceacebook => Facebook
(布拉德) => Claude
克劳德扣的 => Claude Code
克劳德 => Claude
(B锁|vissor|A琐) => Vercel
(Iloud|Icloud) => iCloud
纸代理 => 子代理
兜包 => 豆包
豆宝 => 豆包
公公库 => 公共库
(4月标|4月表) => 私有表
(散念|散面胶囊) => 闪念胶囊
图度 => Todo
书界面 => 输入界面
(圆认子|原认知) => 元认知
(纸袋里|纸袋理|子弹里|只代理|指代理) => 子代理
(浮沉|浮城|复层) => 浮层
(4例|视例|4E|是力|四例) => 示例
(徒生徒) => 文生图
纹身图 => 文生图
图标扩 => 图标库
(陈浸是|陈浸式|陈建设|曾浸是) => 沉浸式
(阅南|月亮玩) => 越南
荔支 => leads
(广化|光化) => 转化
细神 => 细分
(异花石) => 优化师
大额全 => 大而全
清单题 => 清单体
36G => 36计
(付存|付成|福成) => 浮层
(喊高|韩高|含高|梵高) => 行高
(参口) => 窗口
(侧通|测通) => 测试
(小售) => 销售
T示 => 提示
(皮量|疲量) => 批量
(行举|韩距|韩剧) => 行距
(调房) => 投放
(设美|色媒|设煤|涉媒|色眉|涉煤|色美) => 社媒
(变变) => 裂变
(内比) => 类似
(鉴力) => 建立
(库层) => 库存
转文门 => 转文本
(爱孔|图标|I孔|挨孔) => icon
筛phone => 筛选
手查 => 走查
文站 => 网站
录径 => 路径
写警 => 写进
费种 => 汇总
冬字 => 动效
3巧 => 技巧
受惠版 => 收费版
木兰迪 => 莫兰迪
法问 => 访问
夫妻端 => 服务器端
公共会 => 公共库
公共户 => 公共库
(插界面板|插见面板|插这面板|插节面板|插件密码) => 插件面板
(申音) => 声音
申音输入 => 声音输入
闪电锁 => 闪电说
前科中心 => 线索中心
千杯味头 => 潜客中心
绘画列表 => 会话列表
(他去|爬去) => 爬取
查取数据 => 爬取数据
任务裁剪 => 任务拆解
无线重复 => 无限重复
拉去 => 拉取
数据员 => 数据源
未调 => 微调
(ray贝|raybase) => rebase
类间距 => 内间距
编距 => 边距
缩列图 => 缩略图
瀑不留 => 瀑布流
受影下 => 受影响
超轻画质 => 超清画质
GS => JS
半生照 => 半身照
半生像 => 半身像
魔型 => 模型
(残句|残剧) => 长句
work tree => worktree`;

export function parseCorrectionRules(text) {
  const lines = text.split('\n');
  const rules = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith('//') || t.startsWith('#')) continue;
    const idx = t.indexOf('=>');
    if (idx < 0) continue;
    const from = t.slice(0, idx).trim();
    const to = t.slice(idx + 2).trim();
    if (from.startsWith('(') && from.endsWith(')')) {
      try { rules.push({ regex: new RegExp(from.slice(1, -1), 'g'), to }); } catch (e) {}
    } else {
      try { rules.push({ regex: new RegExp(from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), to }); } catch (e) {}
    }
  }
  return rules;
}

export function applyCorrection(text) {
  if (!state.correctionEnabled || !state.correctionRules.length) return text;
  let result = text;
  for (const rule of state.correctionRules) {
    result = result.replace(rule.regex, rule.to);
  }
  return result;
}

let correctionWriteTimer = null;

function applyCorrectionRules(text) {
  state.correctionRules = parseCorrectionRules(text);
  $('corrCount').textContent = state.correctionRules.length + ' 条规则';
}

async function persistCorrectionRules(text) {
  const config = await fetchLocalConfig();
  config.correctionRules = text;
  await saveLocalConfig(config);
}

export function saveCorrectionRules(text) {
  applyCorrectionRules(text);
  if (correctionWriteTimer) clearTimeout(correctionWriteTimer);
  correctionWriteTimer = setTimeout(async () => {
    correctionWriteTimer = null;
    try {
      await persistCorrectionRules(text);
    } catch (e) {
      console.error('[config] correction save failed:', e.message || e);
    }
  }, 250);
}

export async function flushCorrectionRules() {
  if (correctionWriteTimer) {
    clearTimeout(correctionWriteTimer);
    correctionWriteTimer = null;
  }
  const text = $('correctionRules').value;
  try {
    await persistCorrectionRules(text);
  } catch (e) {
    console.error('[config] correction flush failed:', e.message || e);
  }
}

export async function loadCorrectionRules() {
  const config = await fetchLocalConfig();
  const saved = config.correctionRules;
  if (typeof saved === 'string' && saved.trim()) {
    $('correctionRules').value = saved;
    applyCorrectionRules(saved);
  } else {
    $('correctionRules').value = DEFAULT_RULES;
    applyCorrectionRules(DEFAULT_RULES);
    try {
      await persistCorrectionRules(DEFAULT_RULES);
    } catch (e) {
      console.error('[config] correction default save failed:', e.message || e);
    }
  }
}
