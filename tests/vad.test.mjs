import assert from 'node:assert/strict';
import { AdaptiveVAD } from '../src/js/vad.js';

const vad = new AdaptiveVAD({ mode: 'auto', threshold: 0.006 });
for (let i = 0; i < 48; i++) vad.update(0.004);
assert.ok(vad.threshold > 0.006, '自动模式应提高到高于环境底噪');
assert.ok(vad.threshold <= 0.05, '阈值必须有上限');
const thresholdAfterNoise = vad.threshold;
for (let i = 0; i < 20; i++) vad.update(0.03);
assert.equal(vad.threshold, thresholdAfterNoise, '说话帧不应把噪声底继续抬高');

const manual = new AdaptiveVAD({ mode: 'manual', threshold: 0.012 });
for (let i = 0; i < 40; i++) manual.update(0.001);
assert.equal(manual.threshold, 0.012, '手动模式必须保持用户阈值');
manual.setMode('auto');
manual.update(0.004);
assert.ok(manual.threshold > 0, '切换自动后应恢复计算');
console.log('4 passed, 0 failed');
