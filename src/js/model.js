// 模型管理：与本地 ASR 服务的 HTTP 管理端口（默认 8933）通信
// 支持 SenseVoice 和 Qwen3 双模型的状态展示、一键下载、进度轮询、重载、在访达中显示

import { state, normalizeEngine } from './state.js';
import { refreshModelStateLabels } from './settings.js';

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
  if (!cards.length) return;

  const qwen3Dir = document.getElementById('qwen3ModelDir')?.value?.trim() || '';
  const data = await getModelStatus(qwen3Dir);

  if (data.error) {
    // fetch 失败 = 本地模型服务（8933）未启动。可能是 python3 缺失、依赖缺失
    // 导致进程退出，或服务端口被占用 —— 给出可操作指引，而非裸的 "Load failed"。
    const hint = `本地模型服务未启动（127.0.0.1:8933）：${data.error}。` +
      '请在终端执行 /opt/homebrew/bin/python3 -m pip install sherpa-onnx numpy websockets ' +
      '后重启本应用；若已安装，请确认 /opt/homebrew/bin/python3 存在。';
    // 服务未启动：状态统一显示在引擎选项行（卡片内已无状态行）
    refreshModelStateLabels({ sensevoice: '模型服务未启动', qwen3: '模型服务未启动' });
    return;
  }

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
    group.insertBefore(box, pick);
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


