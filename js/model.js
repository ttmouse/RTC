// 模型管理：与本地 ASR 服务的 HTTP 管理端口（默认 8933）通信
// 支持 SenseVoice 和 Qwen3 双模型的状态展示、一键下载、进度轮询、重载、在访达中显示

import { state, normalizeEngine } from './state.js';

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

export async function reloadModel(type) {
  try {
    return await apiPost('/model/reload', { type });
  } catch (e) {
    return { reloading: false, error: e.message || String(e) };
  }
}

export async function revealInFinder(path) {
  try {
    if (window.__TAURI__ && window.__TAURI__.shell) {
      await window.__TAURI__.shell.open(path);
    }
  } catch (e) {
    console.warn('[model] reveal failed:', e);
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

function renderCard(card, info) {
  const statusEl = $(card, '.model-status');
  const dlBtn = $(card, '.model-download-btn');
  const reloadBtn = $(card, '.model-reload-btn');
  const revealBtn = $(card, '.model-reveal-btn');
  const progressWrap = $(card, '.model-progress');
  const progressFill = $(card, '.model-progress-fill');
  const progressText = $(card, '.model-progress-text');
  const type = card.dataset.model;
  const inUse = normalizeEngine(state.asrEngine) === type;
  const inUseTag = inUse ? ' · 使用中' : '';

  stopProgress(type);
  progressWrap.classList.add('hidden');

  if (info.exists) {
    statusEl.textContent = `已就绪 · ${fmtSize(info.size_bytes)}${inUseTag}`;
    statusEl.style.color = '';
    dlBtn.textContent = '重新下载';
    dlBtn.classList.remove('hidden');
    reloadBtn.classList.remove('hidden');
  } else {
    statusEl.textContent = `未下载${inUseTag}`;
    statusEl.style.color = '';
    dlBtn.textContent = '下载模型';
    dlBtn.classList.remove('hidden');
    reloadBtn.classList.add('hidden');
  }

  // 下载按钮
  dlBtn.onclick = async () => {
    const qwen3Dir = document.getElementById('qwen3ModelDir')?.value?.trim() || '';
    dlBtn.disabled = true;
    dlBtn.textContent = '准备中...';
    const res = await startModelDownload(type, qwen3Dir);
    if (res.started === false) {
      statusEl.textContent = '下载启动失败：' + (res.reason || res.error || '未知');
      statusEl.style.color = 'var(--seal)';
      dlBtn.disabled = false;
      dlBtn.textContent = info.exists ? '重新下载' : '下载模型';
      return;
    }
    progressWrap.classList.remove('hidden');
    reloadBtn.classList.add('hidden');
    progressTimers[type] = setInterval(async () => {
      const p = await getModelProgress(type);
      if (progressFill) progressFill.style.width = (p.progress || 0) + '%';
      if (progressText) progressText.textContent = (p.progress || 0) + '%';
      if (p.message) statusEl.textContent = p.message;
      if (p.status === 'done') {
        stopProgress(type);
        statusEl.textContent = '下载完成，模型已就绪';
        statusEl.style.color = '';
        dlBtn.disabled = false;
        dlBtn.textContent = '重新下载';
        reloadBtn.classList.remove('hidden');
        setTimeout(() => progressWrap.classList.add('hidden'), 1500);
      } else if (p.status === 'error') {
        stopProgress(type);
        statusEl.textContent = '下载失败：' + (p.message || '未知错误');
        statusEl.style.color = 'var(--seal)';
        dlBtn.disabled = false;
        dlBtn.textContent = '重试';
        progressWrap.classList.add('hidden');
      }
    }, 500);
  };

  // 重载按钮
  reloadBtn.onclick = async () => {
    reloadBtn.disabled = true;
    reloadBtn.textContent = '重载中...';
    await reloadModel(type);
    setTimeout(() => {
      reloadBtn.disabled = false;
      reloadBtn.textContent = '重载';
      renderAll();
    }, 2500);
  };

  // 在访达中显示
  revealBtn.onclick = () => {
    if (info.model_dir) revealInFinder(info.model_dir);
  };
}

/**
 * 渲染所有模型卡片。由 main.js 在打开设置面板时调用。
 */
export async function renderModelStatus() {
  const cards = document.querySelectorAll('.model-card');
  if (!cards.length) return;

  const qwen3Dir = document.getElementById('qwen3ModelDir')?.value?.trim() || '';
  const data = await getModelStatus(qwen3Dir);

  if (data.error) {
    cards.forEach(card => {
      const statusEl = $(card, '.model-status');
      if (statusEl) {
        statusEl.textContent = '无法连接本地模型服务（' + data.error + '）';
        statusEl.style.color = 'var(--seal)';
      }
    });
    return;
  }

  cards.forEach(card => {
    const type = card.dataset.model;
    const info = data[type];
    if (info) renderCard(card, info);
  });
}

// 供 reload 按钮回调
async function renderAll() {
  await renderModelStatus();
}
