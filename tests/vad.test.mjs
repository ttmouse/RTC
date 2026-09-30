import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveVADThreshold } from '../src/js/state.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

const index = read('src/index.html');
const state = read('src/js/state.js');
const settings = read('src/js/settings.js');
const asr = read('src/js/asr.js');
const main = read('src/js/main.js');
const python = read('asr_local/server.py');
const server = read('server.js');

assert.ok(!index.includes('id="vadMode"'), '设置页不再暴露自动/手动 VAD 模式');
assert.ok(!/^\s*vadMode:/m.test(state), '运行状态只保留一个实际阈值');
assert.ok(!fs.existsSync(path.join(root, 'src/js/vad.js')), '自适应噪声估计模块已删除');
assert.ok(!python.includes('noise_floor') && !python.includes('noise_samples'), '本地引擎不再自行估计噪声底');
assert.ok(!python.includes('vad_mode'), '本地引擎只使用主界面刻度对应的阈值');
assert.match(asr, /action:\s*'set-vad-threshold'/, '前端可在录音中把新阈值发给本地引擎');
// 百炼的句尾由百炼自己的 VAD 定（sentence_end）。前端曾经另有一套写死的音量门槛
// （Int16 RMS<300 连续 16 块 ≈1.37 秒）把还没说完的半句提前定稿，症状是一句话在
// 列表里变成多条越来越长的记录（2026-09-20 实测 4 条，间隔精确 1.365 秒）。不许加回来。
assert.ok(!/checkSilence|SILENCE_THRESH|SILENCE_FRAMES/.test(asr), '前端不再按音量门槛提前定稿');
assert.ok(!/^\s*silenceChunks:/m.test(state), '运行状态不再保留静音计数');
assert.match(python, /action == "set-vad-threshold"/, '本地引擎能立即接收新阈值');
assert.match(main, /setThresholdFromClientX[\s\S]{0,500}sendVADThreshold\(/, '拖动主界面刻度会立即同步本地引擎');
assert.deepEqual(resolveVADThreshold({ vadMode: 'auto', vadThreshold: 0.031 }), { threshold: 0.006, legacyMode: true }, '旧自动模式不继承临时环境阈值');
assert.deepEqual(resolveVADThreshold({ vadMode: 'manual', vadThreshold: 0.012 }), { threshold: 0.012, legacyMode: true }, '旧手动模式保留用户刻度');
assert.deepEqual(resolveVADThreshold({ vadThreshold: 0.009 }), { threshold: 0.009, legacyMode: false }, '新版配置直接保留主界面刻度');
assert.match(server, /partial\.settings\.vadMode === null[\s\S]{0,120}delete next\.settings\.vadMode/, '迁移后从磁盘配置删掉已废弃的模式字段');
assert.match(asr, /event === 'task-started'[\s\S]{0,160}state\.asrWs !== ws[\s\S]{0,300}sendVADThreshold\(ws,[\s\S]{0,140}flushBufferedPCM\(ws\)/, '连接期间拖动的新阈值会绑定当前连接、并在积压音频前补发');

console.log('15 passed, 0 failed');
