import { clampVADThreshold, VAD_THRESHOLD_MIN, VAD_THRESHOLD_MAX } from './state.js';

// 自适应 VAD：只用低能量帧估计噪声底，避免把说话声当成环境噪声。
// 阈值 = 噪声底与安全间隔中较大的一个，并限制在现有 VAD 范围内。
export class AdaptiveVAD {
  constructor({ threshold = 0.006, mode = 'auto', min = VAD_THRESHOLD_MIN, max = VAD_THRESHOLD_MAX } = {}) {
    this.manualThreshold = clampVADThreshold(threshold);
    this.threshold = this.manualThreshold;
    this.mode = mode === 'manual' ? 'manual' : 'auto';
    this.min = min;
    this.max = max;
    this.reset();
  }

  reset() {
    this.noiseFloor = 0;
    this.samples = [];
    this.frames = 0;
    this.speechFrames = 0;
    this.threshold = this.mode === 'manual' ? this.manualThreshold : this.threshold;
  }

  setMode(mode) {
    this.mode = mode === 'manual' ? 'manual' : 'auto';
    if (this.mode === 'manual') this.threshold = this.manualThreshold;
  }

  setManualThreshold(value) {
    this.manualThreshold = clampVADThreshold(value);
    if (this.mode === 'manual') this.threshold = this.manualThreshold;
  }

  update(rms) {
    if (!(rms >= 0) || this.mode === 'manual') return this.threshold;
    this.frames++;
    // 只吸收明显低于当前门槛的帧；说话帧不会抬高噪声底。
    const quiet = this.noiseFloor === 0 || rms < Math.max(this.threshold * 0.85, this.noiseFloor * 1.35);
    if (quiet) {
      this.samples.push(rms);
      if (this.samples.length > 48) this.samples.shift();
      const sorted = [...this.samples].sort((a, b) => a - b);
      const p25 = sorted[Math.floor((sorted.length - 1) * 0.25)] || rms;
      this.noiseFloor = this.noiseFloor === 0 ? p25 : this.noiseFloor * 0.92 + p25 * 0.08;
      this.threshold = clampVADThreshold(Math.max(this.noiseFloor * 2.8, this.noiseFloor + 0.0025));
    } else {
      this.speechFrames++;
    }
    return this.threshold;
  }
}

export function createAdaptiveVAD(options) {
  return new AdaptiveVAD(options);
}
