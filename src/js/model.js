// 模型管理：与本地 ASR 服务的 HTTP 管理端口（默认 8933）通信
// 支持 SenseVoice 和 Qwen3 双模型的状态展示、一键下载、进度轮询、重载、在访达中显示

import { state, normalizeEngine, isLocalEngine } from './state.js';
import { refreshModelStateLabels } from './settings.js';
import { renderRunStatus } from './ui.js';

const MODEL_API = 'http://127.0.0.1:8933';
const progressTimers = {};  // model_type -> interval id

// ---------- API ----------

async function apiGet(path) {
  const r = await fetch(MODEL_API + path);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

async function apiPost(path, body) {
  const r = await fetch(MODEL_API + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  return r.json();
}

export async function getModelStatus(qwen3Dir) {
  const q = qwen3Dir ? `?qwen3_dir=${encodeURIComponent(qwen3Dir)}` : '';
  try {
    return await apiGet('/model/status' + q);
  } catch (e) {
    return { error: e.message || String(e) };
  }
}

export async function startModelDownload(type, qwen3Dir) {
  try {
    return await apiPost('/model/download', { type, qwen3_dir: qwen3Dir });
  } catch (e) {
    return { started: false, error: e.message || String(e) };
  }
}

// ---------- 模型服务可达性（主界面状态区的数据源） ----------
//
// 本地引擎（SenseVoice / Qwen3）的识别依赖本机的 python 模型服务：
// asr_local/server.py 一个进程同时提供 8932（识别 WS）和 8933（模型管理 HTTP）。
// 它没起来时，设置页的引擎状态行写的是「模型服务未启动」，而主界面以前照样
// 显示「就绪」——用户可以录一整场会，一个字都不会出，事后才发现什么都没存。
// 这正是 core-product-principles 第 3 条（界面上每个状态只能有一个真实来源）
// 要禁的假状态。所以探测结论写进 state，由 ui.js 的状态机统一渲染，
// 设置页和主界面永远说同一句话。
//
// 探测与判定刻意分开：第一次失败不算数。应用冷启动时 python 侧还要加载依赖与模型，
// 这段时间连不上 8933 是正常的（Rust 侧给本地 ASR 的是 30 秒），
// 必须「过了启动宽限」且「连续两次失败」才认定未启动，否则开局会闪一个假警报。

const PROBE_OK_MS = 10000;    // 服务正常：也保持 10 秒一次的校准（本地请求成本≈ 0）
const PROBE_FAIL_MS = 5000;   // 连不上：快速重试，服务一起来就立刻转回「就绪」
const PROBE_GRACE_MS = 20000; // 冷启动宽限：这段时间里的失败只记数、不报异常

let probeTimer = null;
let probeFailStreak = 0;
const probeStartedAt = Date.now();

/** 把探测结论写进 state；只有本地引擎才关心它，百炼一律置 null（不显示异常） */
function applyModelServiceState(reachable) {
  const v = isLocalEngine(normalizeEngine(state.asrEngine)) ? reachable : null;
  if (state.modelServiceOk === v) return;
  state.modelServiceOk = v;
  renderRunStatus();
  refreshSettingsIfOpen();
}

// 设置页开着的时候，服务状态一变就重渲染它。
// 否则这一页会停在旧结论上：用户在终端把服务拉起来（或服务又挂了），设置页还挂着
// 「模型服务未启动」和那个重启按钮——正是本项目最忌的假状态，而且它长得和真的一模一样。
let settingsRefreshInFlight = false;

function refreshSettingsIfOpen() {
  const page = document.getElementById('settingsPage');
  if (!page || page.classList.contains('hidden')) return;
  if (settingsRefreshInFlight) return;   // 重渲染自己也会探测，别叠罗汉
  settingsRefreshInFlight = true;
  Promise.resolve(renderModelStatus()).finally(() => { settingsRefreshInFlight = false; });
}

/**
 * 探测一次本机模型服务，并把结论写进 state。
 * 设置页的 renderModelStatus 和主界面的看护循环都走这一个函数，
 * 保证「设置页说的」和「主界面说的」是同一次探测的结论。
 */
export async function probeModelService(qwen3Dir) {
  const dir = qwen3Dir !== undefined ? qwen3Dir : (state.qwen3ModelDir || '');
  const data = await getModelStatus(dir);
  probeFailStreak = data.error ? probeFailStreak + 1 : 0;
  const confirmed = !data.error ||
    (probeFailStreak >= 2 && Date.now() - probeStartedAt > PROBE_GRACE_MS);
  if (confirmed) applyModelServiceState(!data.error);
  return data;
}

/**
 * 启动模型服务看护：探测一次，再按结果决定下次探测间隔。
 * 只在启动时调一次；切换引擎时由 changeEngine 直接调 probeModelService 立即重探
 * （否则切到本地引擎后要等最多 1 分钟才出现异常提示）。
 */
export function watchModelService() {
  const tick = async () => {
    const data = await probeModelService();
    clearTimeout(probeTimer);
    probeTimer = setTimeout(tick, data.error ? PROBE_FAIL_MS : PROBE_OK_MS);
  };
  void tick();
}

export async function getModelProgress(type) {
  try {
    return await apiGet('/model/progress?type=' + encodeURIComponent(type));
  } catch (e) {
    return { status: 'error', message: e.message || String(e) };
  }
}

// ---------- 渲染 ----------

function fmtSize(bytes) {
  if (!bytes) return '0 MB';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(0) + ' MB';
}

function $(card, sel) { return card.querySelector(sel); }

function stopProgress(type) {
  if (progressTimers[type]) {
    clearInterval(progressTimers[type]);
    delete progressTimers[type];
  }
}

/**
 * 单个模型的状态短语：`已就绪 · 228 MB` / `未下载` / 下载中的临时文案。
 * 不含「使用中」——那是引擎选中态，由 settings.js 在选项行统一加，避免出现两遍。
 */
function modelStatusText(type) {
  const info = modelInfo[type];
  if (!info) return '';
  if (info.message) return info.message;   // 下载中 / 失败等临时状态
  return info.exists ? `已就绪 · ${fmtSize(info.size_bytes)}` : '未下载';
}

/** 把状态（含错误态）推给引擎选项行——本文件不再直接操作设置页 DOM */
function pushModelStateLabels() {
  const states = {};
  const modes = {};
  document.querySelectorAll('.pick[data-model]').forEach((card) => {
    const t = card.dataset.model;
    if (!t) return;
    const text = modelStatusText(t);
    if (text) states[t] = text;
    if (modelInfo[t] && modelInfo[t].error) modes[t] = 'error';
  });
  refreshModelStateLabels(states, modes);
}

/** 设置某个模型的临时状态文案（下载进度、失败原因等） */
function setModelMessage(type, message, isError = false) {
  if (!modelInfo[type]) modelInfo[type] = {};
  modelInfo[type].message = message;
  modelInfo[type].error = isError;
  pushModelStateLabels();
}

/** 清掉临时状态，回到「已就绪 / 未下载」 */
function clearModelMessage(type, exists) {
  if (!modelInfo[type]) modelInfo[type] = {};
  modelInfo[type].message = null;
  modelInfo[type].error = false;
  if (typeof exists === 'boolean') modelInfo[type].exists = exists;
  pushModelStateLabels();
}

// 最近一次拿到的模型状态，供 modelStatusText 复用（避免重复请求）
const modelInfo = {};

function renderCard(card, info) {
  const dlBtn = $(card, '.model-download-btn');
  const progressWrap = $(card, '.model-progress');
  const progressFill = $(card, '.model-progress-fill');
  const progressText = $(card, '.model-progress-text');
  const type = card.dataset.model;
  modelInfo[type] = info;

  // 进度条渲染：indeterminate=true 时清掉 inline 宽度，让 CSS 的扫动宽度生效
  const setProgress = ({ percent = 0, indeterminate = false, label = '' } = {}) => {
    progressWrap.classList.toggle('indeterminate', indeterminate);
    if (indeterminate) {
      if (progressFill) progressFill.style.width = '';
      if (progressText) progressText.textContent = label || '处理中';
      return;
    }
    const p = Math.max(0, Math.min(100, percent));
    if (progressFill) progressFill.style.width = p + '%';
    if (progressText) progressText.textContent = p.toFixed(0) + '%';
  };

  stopProgress(type);
  progressWrap.classList.add('hidden');
  progressWrap.classList.remove('indeterminate');

  // 已就绪就没有可做的动作了，不再摆一个「重新下载」；只有缺模型时才给下载入口
  dlBtn.textContent = '下载模型';
  dlBtn.classList.toggle('hidden', !!info.exists);
  // 状态文案（含使用中标记）刚变，引擎选项上的标记跟着更新
  pushModelStateLabels();

  // 下载按钮
  dlBtn.onclick = async () => {
    const qwen3Dir = document.getElementById('qwen3ModelDir')?.value?.trim() || '';
    dlBtn.disabled = true;
    dlBtn.textContent = '准备中...';
    const res = await startModelDownload(type, qwen3Dir);
    if (res.started === false) {
      setModelMessage(type, '下载启动失败：' + (res.reason || res.error || '未知'), true);
      dlBtn.disabled = false;
      dlBtn.textContent = info.exists ? '重新下载' : '下载模型';
      return;
    }
    progressWrap.classList.remove('hidden');
    progressTimers[type] = setInterval(async () => {
      const p = await getModelProgress(type);
      const pct = p.progress || 0;
      if (p.status === 'extracting') {
        // 解压：总量未知，用不确定态避免看起来像卡在 100%
        setProgress({ indeterminate: true, label: '解压中' });
      } else {
        setProgress({ percent: pct });
      }
      if (p.message) setModelMessage(type, p.message);
      if (p.status === 'done') {
        stopProgress(type);
        clearModelMessage(type, true);
        dlBtn.disabled = false;
        dlBtn.classList.add('hidden');   // 已就绪，无需再下载
        setTimeout(() => {
          progressWrap.classList.add('hidden');
          progressWrap.classList.remove('indeterminate');
        }, 1500);
      } else if (p.status === 'error') {
        stopProgress(type);
        setModelMessage(type, '下载失败：' + (p.message || '未知错误'), true);
        dlBtn.disabled = false;
        dlBtn.textContent = '重试';
        dlBtn.classList.remove('hidden');
        progressWrap.classList.add('hidden');
        progressWrap.classList.remove('indeterminate');
      }
    }, 500);
  };

}

/**
 * 渲染所有模型卡片。由 main.js 在打开设置面板时调用。
 */
export async function renderModelStatus() {
  const cards = document.querySelectorAll('.pick[data-model]');
  const qwen3Dir = document.getElementById('qwen3ModelDir')?.value?.trim() || '';
  // 探测走 probeModelService：主界面状态区和这里的说法必须来自同一次结论
  const data = await probeModelService(qwen3Dir);
  if (!cards.length) return;

  if (data.error) {
    // fetch 失败 = 本地模型服务（8933）未启动。可能是 python3 缺失、依赖缺失
    // 导致进程退出，或服务端口被占用。
    // 这里必须跟主界面状态区共用同一条判定（state.modelServiceOk，含冷启动宽限）：
    // 设置页自己看到一次失败就报异常的话，应用刚起来的那十几秒里两个页面会互相矛盾
    // （一个说未启动、一个说就绪），而那时候连不上本来就是正常的。
    // 确认之前只说「检测中」；确认后才报异常并标错——不带 error 态的话
    // 「使用中 · 模型服务未启动」是常态色，跟「已就绪」长得一样，等于没说。
    const down = state.modelServiceOk === false;
    const text = down ? '模型服务未启动' : '检测中…';
    refreshModelStateLabels(
      { sensevoice: text, qwen3: text },
      down ? { sensevoice: 'error', qwen3: 'error' } : {},
    );
    // 确认没在跑的时候，必须给出下一步：只写「模型服务未启动」等于把用户丢在死路上
    if (down) await renderServiceDownBox();
    else clearServiceDownBox();
    return;
  }
  clearServiceDownBox();

  // 服务在跑但推理依赖缺失：模型可下载、识别不可用 —— 与「服务未启动」区别呈现
  const env = data.environment;
  if (env && !env.ready) renderEnvironmentWarning(env);
  else clearEnvironmentWarning();

  cards.forEach(card => {
    const type = card.dataset.model;
    const info = data[type];
    if (info) renderCard(card, info);
  });
  pushModelStateLabels();
}

/** 环境缺失提示：缺哪些模块 + 可直接复制执行的安装命令（Python 侧探测后返回） */
function renderEnvironmentWarning(env) {
  const pick = document.querySelector('.pick[data-model]');
  const group = pick?.closest('.s-group');
  if (!group) return;

  let box = group.querySelector('.model-env-warning');
  if (!box) {
    box = document.createElement('div');
    box.className = 'fd model-env-warning';
    box.style.color = 'var(--seal)';
    // 父节点用 .enginePick（.pick 的直接父节点）：见 renderServiceDownBox 里的同款说明
    pick.parentElement.insertBefore(box, pick);
  }

  const missing = (env.missing_deps || []).join(', ');
  box.textContent = '';
  box.append(`本地识别不可用：当前 Python（${env.python_path}）缺少 ${missing}。请在终端执行 `);

  const cmd = document.createElement('code');
  cmd.textContent = env.install_command;
  cmd.style.cssText = 'user-select:all;cursor:text;';
  box.append(cmd, ' 后重启本应用。模型下载与状态检测不受影响。');
}

function clearEnvironmentWarning() {
  document.querySelectorAll('.model-env-warning').forEach(el => el.remove());
}

// ---------- 「模型服务未启动」的恢复入口 ----------
//
// 状态文字只说出了问题，用户下一步得知道两件事：为什么坏了、怎么弄回来。这条链路以前是断的：
// 主界面状态区的提示写着「打开设置 →「识别方式」可以看到原因和修复命令」，可设置页在服务连不上
// 时只写四个字「模型服务未启动」——原因（python 的 stderr）全被吞在 Rust 侧，动作也没有
// （Rust 只在启动时拉起一次，之后没有任何看护）。用户唯一能做的是退出重开应用，而如果原因是
// 缺依赖或者端口被占用，重开多少次都一样。
//
// 所以这里补上两件事：原因翻成人话（Rust 侧留的日志尾部）+ 一个「重启模型服务」按钮。

/**
 * python 日志尾部 → 一句人话（能对上原因时附带可复制的处理命令）。
 * 认不出来的不猜，如实回最后一行；一行日志都没有就返回空原因，由调用方另说。
 */
export function explainServiceFailure(lines = []) {
  const text = lines.join('\n');
  const last = [...lines].reverse().find(l => l.trim()) || '';
  const noModule = text.match(/No module named\s+['"]?([\w.\-]+)/);
  if (noModule) {
    return {
      reason: `缺少 Python 依赖（${noModule[1]}），服务一起来就退了`,
      fix: 'python3 -m pip install sherpa-onnx numpy websockets',
    };
  }
  if (/Address already in use|\[Errno 48\]/.test(text)) {
    return {
      reason: '端口被别的程序占着（本机识别要用 8932 和 8933）',
      fix: 'lsof -nP -iTCP:8932,8933 -sTCP:LISTEN',
    };
  }
  if (/MemoryError|Cannot allocate memory|Killed/.test(text)) {
    return { reason: '内存不够，进程被系统杀掉了', fix: '' };
  }
  if (/No such file or directory/.test(text) && /\.onnx|model/i.test(text)) {
    return { reason: '模型文件缺失或路径不对（下面两张模型卡片可以重新下载）', fix: '' };
  }
  return { reason: last, fix: '' };
}

/** Tauri 命令调用；网页版（npm run dev:web）没有进程可管，返回 null。 */
function invokeTauri(cmd, args) {
  const invoke = window.__TAURI__?.core?.invoke;
  return invoke ? invoke(cmd, args) : Promise.resolve(null);
}

function clearServiceDownBox() {
  document.querySelectorAll('.model-service-down').forEach(el => el.remove());
}

/**
 * 「模型服务未启动」的说明 + 恢复入口，插在「识别方式」第一张卡片之前。
 * 结构只建一次，之后只更新文字（打开设置、重探、重启回来都会走到这里）。
 */
async function renderServiceDownBox() {
  const pick = document.querySelector('.pick[data-model]');
  const group = pick?.closest('.s-group');
  if (!group) return;
  // 插在 .enginePick 里、第一张模型卡片之前：.pick 不是 .s-group 的直接子节点，
  // 拿 .s-group 当父节点 insertBefore 会抛 NotFoundError（整块提示根本渲染不出来）。
  const slot = pick.parentElement;

  let box = group.querySelector('.model-service-down');
  if (!box) {
    box = document.createElement('div');
    box.className = 'fd model-service-down';
    const title = document.createElement('div');
    title.className = 'msd-title';
    title.textContent = '本机识别服务没有在运行（127.0.0.1:8933），现在录音不会出字';
    const desc = document.createElement('div');
    desc.className = 'msd-desc';
    desc.textContent = '本地引擎的识别靠它。这个服务由本应用在启动时拉起，中途退出不会自己回来。';
    const reason = document.createElement('div');
    reason.className = 'msd-reason';
    const actions = document.createElement('div');
    actions.className = 'msd-actions';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'sbtn sm';
    btn.textContent = '重启模型服务';
    const stateEl = document.createElement('span');
    stateEl.className = 'msd-state';
    actions.append(btn, stateEl);
    const log = document.createElement('details');
    log.className = 'msd-log';
    const logSum = document.createElement('summary');
    logSum.textContent = '查看服务日志';
    const logPre = document.createElement('pre');
    log.append(logSum, logPre);
    box.append(title, desc, reason, actions, log);
    slot.insertBefore(box, pick);
    box._refs = { reason, btn, stateEl, log, logPre };
    btn.onclick = () => restartLocalService(box);
  }

  const { reason: reasonEl, btn, stateEl, log, logPre } = box._refs;
  const st = await invokeTauri('local_asr_status').catch(() => null);
  const lines = (st && st.log_tail) || [];
  const { reason: why, fix } = explainServiceFailure(lines);

  // 原因分四种说法，一种都不许含糊：说不出来就如实说「没有日志」，不编原因
  let text;
  if (!st) {
    text = '网页版没有重启入口：在终端重新运行 npm run dev（或直接跑 python3 asr_local/server.py）';
  } else if (!st.managed) {
    text = '这个服务不是本应用启动的（开发模式复用了终端里的进程）：请到启动它的终端里把服务重新拉起来';
  } else if (why) {
    text = why;
  } else if (st.running) {
    text = `进程还在（PID ${st.pid}），但 8933 没有响应——多半卡在加载模型`;
  } else {
    text = '进程已经退出，而且没有留下日志';
  }

  reasonEl.textContent = text;
  if (fix) {
    reasonEl.append('：');
    const code = document.createElement('code');
    code.textContent = fix;
    code.style.cssText = 'user-select:all;cursor:text;';
    reasonEl.append(code);
  }

  // 进程不是本应用起的就别摆一个点了只会报错的按钮
  btn.classList.toggle('hidden', !st || !st.managed);
  stateEl.textContent = '';
  stateEl.classList.remove('up-offline');
  log.classList.toggle('hidden', !lines.length);
  logPre.textContent = lines.join('\n');
}

/** 「重启模型服务」：拉起新进程 → 交给同一条探针确认 → 失败则把新的日志尾部带回来 */
async function restartLocalService(box) {
  const { btn, stateEl } = box._refs;
  btn.disabled = true;
  btn.textContent = '正在重启…';
  stateEl.classList.remove('up-offline');
  stateEl.textContent = '模型加载通常几秒，最长等 30 秒';

  try {
    await invokeTauri('restart_local_asr');
    stateEl.textContent = '已启动，正在确认…';
  } catch (e) {
    stateEl.classList.add('up-offline');
    stateEl.textContent = '重启失败：' + (e && (e.message || String(e)) || '未知原因');
  }

  // 重启的结论只认探针这一处：成功会自己转回「就绪」并收起这块，
  // 失败则重新取一次状态——日志尾部多半就是这次崩溃的原因
  await probeModelService();
  await renderModelStatus();
  btn.disabled = false;
  btn.textContent = '重启模型服务';
}
