/**
 * 声音仪表：把「每 4096 采样算一次 RMS、直接写 width」改成录音设备上的电平表。
 *
 * 三个手感的来源，缺一个就退回「会跳的横条」：
 *   1) 快起慢落 —— 声音冲上来一帧到位，落下去按指数包络慢慢收。
 *      纯跟手写 width 会随每个音频块（约 85ms）阶跃，看起来一格一格闪；
 *      而把它交给 CSS transition 又会和「每帧都要写」的意图打架（见下方性能说明）。
 *   2) 峰值保持 —— 一条从左端铺到峰值位置的灰色延迟条，冲到历史最高点后
 *      停约 PEAK_HOLD_MS，再慢慢滑回。这是纯横条给不了的信息：你一眼能看出「刚才那句
 *      最响到哪、比现在响多少」，并能看见它和红色实时条的时间差。
 *   3) 静音干净归零 + 等宽数字读数实时跳 —— 不残留、不抖动、可读。
 *
 * 性能（对齐 ui-interaction-spec 的「性能硬约束」）：
 *   音频回调约 11.7 次/秒，而动画要 60fps 才不闪。所以音频回调**只写 state**，
 *   全部 DOM 写入集中在 rAF 里，且每帧只碰 transform / width / textContent——
 *   不读布局属性（避免强制同步重排）、不碰会触发整屏重绘的层。
 *   同时把 #levelMeterBar 的 CSS transition 去掉：JS 每帧写 width 时，
 *   那 80ms 过渡会让每一次写入都从「上一次的中间值」重新起步，结果是常年追不上、
 *   显示值恒低于真实电平（经典的 transition 与 rAF 打架）。
 */

// 快起慢落：attack 系数取大（几乎一帧到位），release 系数取小（指数回落）。
// 这两个数是手感常数，不是「精调」——改大 release 会变迟钝，改小会看不清句子间隔。
// ATTACK 用 0.85 而不是 1.0：给一点点点惯性，纯 1.0 在块与块之间会看到硬跳变，
// 看起来像画面撕裂；0.85 下 2~3 帧到顶，肉眼已经是「瞬间」。
const ATTACK = 0.85;   // 上升：每帧向目标靠拢 85%
const RELEASE = 0.18;  // 下降：每帧回落 18%（约 250ms 回到视觉零，句间停顿看得清）

// 归零阈值（百分比）。低于它就是「视觉上的零」，直接贴 0：
// 指数回落永远逼近而不到达，没有这个夹断，静音时会一直吊在 1~3% 的位置，
// 看起来像电平条「卡住不归零」。一个像素在 300px 宽的尺子上约等于 0.33%，
// 取 0.6% 略高于一像素，保证肉眼看到的是干净归零而不是残留细线。
const ZERO_PCT = 0.6;

const PEAK_HOLD_MS = 1000;   // 峰值标记在最高点停住的时间
const PEAK_FALL_PER_SEC = 55; // 停住之后每秒回落多少个百分点（约 1.8s 滑到底）

// 实时条的颜色跟随这一段包络的生命周期：开始回落后仍保持红色，
// 直到实时条真正归零；灰色只用于峰值轨迹。不能用一个短暂的静音窗口，
// 否则条还在回落时就会先变灰，形成截图中的「红条变灰」。

/** 仪表运行时状态：全部是百分比（0~100），不存 RMS，避免每帧重复做对数映射 */
const meter = {
  level: 0,        // 平滑后的当前电平（画横条）
  peak: 0,         // 峰值标记位置
  peakHeldAt: 0,   // 峰值最后一次被刷新的时间戳
  target: 0,       // 音频回调写进来的最新目标（未平滑）
  tone: '',        // 音频回调判定的染色档位（'' / 'speech' / 'loud'）
  toneLatched: '', // 实际写到条上的档位（回落到零前保持，见 applyTone）
  toneAt: 0,       // 最近一次「有声音」的时间戳（保留状态字段便于调试）
  tick: 0,         // VAD 阈值刻度位置（整条尺子的百分比，由 settings.js 同步）
  active: false,   // 是否在录音（rAF 循环的开关）
  rafId: 0,
  lastTs: 0,
  el: null,        // { bar, peakEl, invEl }
};

/**
 * 记录 VAD 刻度位置（整条尺子的百分比）。
 * settings.js 拖动/初始化时调一次，之后每帧由仪表复用它去摆反白刻度。
 * 之所以不在 rAF 里现算：拖动条时阈值会变，但录音时它是常量，
 * 每帧重算一遍 20·log10 是白费的。
 */
export function setMeterTick(pct) {
  meter.tick = pct;
}

function els() {
  if (meter.el) return meter.el;
  meter.el = {
    bar: document.getElementById('levelMeterBar'),
    peakEl: document.getElementById('levelMeterPeak'),
    invEl: document.getElementById('levelMeterTickInv'),
  };
  return meter.el;
}

/**
 * 摆反白刻度。它活在 #levelMeterBar 内部，而条本身是 overflow:hidden 的，
 * 所以它只在「条已盖住刻度」时才可见——盖住前的部分由外层深红刻度负责。
 *
 * left 的百分比是相对**条的宽度**算的，而刻度位置是相对**整条尺子**的：
 *   条宽 = level% × 尺宽，刻度 = tick% × 尺宽
 *   ⇒ left(相对条) = tick / level × 100
 * level 为 0 时无从谈起（条宽为 0，放哪都被裁掉），直接藏起来。
 */
function syncTickInverted(level, tick) {
  const { invEl } = els();
  if (!invEl) return;
  // level 太小就藏：此时条本身几乎不可见，反白刻度也没有存在的意义
  if (level <= 0 || tick <= 0 || tick > level) {
    invEl.style.opacity = '0';
    return;
  }
  invEl.style.opacity = '1';
  invEl.style.left = (tick / level * 100).toFixed(2) + '%';
}

/**
 * 音频回调每块调用一次：只记录目标和染色档位，不做任何 DOM 写入。
 * @param {number} rms 当前块的 RMS（线性）
 * @param {number} pct rmsToMeterPct(rms) 的结果（0~100）
 * @param {number} threshold 当前 VAD 阈值（线性），用于染色
 */
export function feedMeter(rms, pct, threshold) {
  meter.target = pct;
  // 只记「这一块有多响」，**不直接改 DOM**。
  // 曾经这里直接写 bar.className，用的是这一块的瞬时 rms——于是声音一停，
  // 条还在慢慢往回缩（67% 宽），颜色却已经瞬间翻成灰色，看起来就像
  // 「红色的实时条在收回途中变成了灰条」。染色必须跟着**画出来的那个电平**走，
  // 所以这里只存档位，真正的 class 由 rAF 按 meter.level 决定（见 applyTone）。
  // 阈值会在拖动刻度时变化，所以三档判定用当下的 threshold，不能预存。
  meter.tone = rms >= threshold
    ? (rms >= threshold * 3 ? 'loud' : 'speech')
    : '';
}

/** 启动仪表（录音开始时调用）。重复调用是幂等的。 */
export function startMeter() {
  if (meter.active) return;
  meter.active = true;
  meter.lastTs = 0;
  meter.rafId = requestAnimationFrame(tick);
}

/** 停表并归零：把电平、峰值、读数一起清干净，不留上一段的残影。 */
export function resetMeter() {
  meter.active = false;
  if (meter.rafId) cancelAnimationFrame(meter.rafId);
  meter.rafId = 0;
  meter.level = 0;
  meter.peak = 0;
  meter.target = 0;
  meter.tone = '';
  meter.toneLatched = '';
  meter.toneAt = 0;
  meter.peakHeldAt = 0;
  const { bar, peakEl, invEl } = els();
  if (bar) {
    bar.style.width = '0%';
    bar.className = '';
  }
  // 条归零后被裁光，反白刻度要一起藏起来——否则它会停在上一段的位置上
  if (invEl) invEl.style.opacity = '0';
  if (peakEl) {
    // 峰值段用 left + width 描述一个区间，归零时两样都要清，
    // 否则色带会停在上一段的位置上（它比一根线更容易看出来）
    peakEl.style.left = '0%';
    peakEl.style.width = '0';
    peakEl.style.opacity = '0';
  }
}

/**
 * 给电平条染色。**必须跟着画出来的那个电平走**，不能跟着瞬时 rms 走。
 *
 * 这是「红色实时条在收回途中变灰」的根因修复：原先 feedMeter 直接按这一块的
 * 瞬时 rms 写 class，声音一停，条还慢慢往回缩（宽 67%），颜色却已经瞬间翻灰——
 * 看到的就是「实时条正收回呢，颜色没了」。
 *
 * 现在的规则：只要条还有可见宽度，而且上一次收音是「在说话」，就继续用印章红。
 * 用一个「释音保持」窗口让它慢慢褪，而不是一帧翻脸：
 *   - 有声音（tone 非空）→ 记录发声时刻、直接用对应档位
 *   - 静音但条仍在回落 → 保持上一次的档位（红条继续红着往回缩）
 *   - 电平回到 0 → 才清掉颜色 class
 * 这样灰色不会和实时条混在一起，灰色只由峰值轨迹表达延迟的峰值。
 */
function applyTone(level, tone) {
  const { bar } = els();
  if (!bar) return;
  if (level <= 0) {
    meter.toneLatched = '';
    meter.toneAt = 0;
    if (bar.className !== '') bar.className = '';
    return;
  }
  if (tone) {
    // 正在发声：记档位和时刻
    meter.toneLatched = tone;
    meter.toneAt = meter.lastTs;
  } else {
    // 静音时不提前褪色：实时条还在回落，就必须继续保持红色。
    // 只有上面的 level <= 0 分支会清掉 toneLatched。
  }
  if (bar.className !== meter.toneLatched) bar.className = meter.toneLatched;
}

function tick(ts) {
  if (!meter.active) return;
  // 首帧没有上一帧时间戳；用 16.7ms 兜底，避免算出 dt=0 导致峰值回落卡住
  const dt = meter.lastTs ? Math.min(64, ts - meter.lastTs) : 16.7;
  meter.lastTs = ts;

  const { bar, peakEl } = els();

  // —— 快起慢落 ——
  const k = meter.target > meter.level ? ATTACK : RELEASE;
  // 按帧率归一的指数趋近：60fps 下 ATTACK/RELEASE 即上面那两个数，
  // 掉帧时（dt 变大）自动补偿，手感不会因为机器慢就变迟钝
  const a = 1 - Math.pow(1 - k, dt / 16.7);
  meter.level += (meter.target - meter.level) * a;
  // 低于视觉零就贴零——否则静音时会永远吊在 1~3% 不掉干净（原因见 ZERO_PCT 注释）
  if (meter.level < ZERO_PCT) meter.level = 0;

  // —— 峰值保持 ——
  if (meter.level >= meter.peak) {
    meter.peak = meter.level;
    meter.peakHeldAt = ts;
  } else if (ts - meter.peakHeldAt > PEAK_HOLD_MS) {
    meter.peak = Math.max(meter.level, meter.peak - PEAK_FALL_PER_SEC * (dt / 1000));
  }
  if (meter.peak < ZERO_PCT) meter.peak = 0;

  if (bar) bar.style.width = meter.level.toFixed(1) + '%';
  applyTone(meter.level, meter.tone);
  // 反白刻度必须在条的宽度写完之后摆：它靠 level 反推 left（见 syncTickInverted）
  syncTickInverted(meter.level, meter.tick);
  if (peakEl) {
    // 延迟灰条：从左端完整铺到峰值位置。
    // 红色实时条在上层覆盖前段；实时条回落后，灰条自然露出来，
    // 因此两条进度的时间差和当前位置都能同时看见。
    const visible = meter.peak > meter.level + 0.8 && meter.peak > 0.5;
    peakEl.style.left = '0%';
    peakEl.style.width = meter.peak.toFixed(1) + '%';
    peakEl.style.opacity = visible ? '1' : '0';
  }
  meter.rafId = requestAnimationFrame(tick);
}
