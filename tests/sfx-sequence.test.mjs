import assert from 'node:assert/strict';

// 不启动桌面 App，用最小 WebAudio 桩复现真实时序：
// 按住说话结束音 → 该句粘贴（不重复响）→ 下一句连续听写粘贴（必须响）。
// 这条链路不会再播一次开始音，因为按住说话松开后底层录音继续。

globalThis.window = {};
globalThis.fetch = async () => ({
  ok: true,
  arrayBuffer: async () => new ArrayBuffer(8),
});

let starts = 0;
const sampleGains = [];
const audioContext = {
  state: 'running',
  currentTime: 0,
  destination: {},
  resume: async () => {},
  decodeAudioData(bytes, done) {
    const buffer = { bytes };
    done(buffer);
    return Promise.resolve(buffer);
  },
  createBufferSource() {
    return {
      buffer: null,
      connect() { return this; },
      start() { starts += 1; },
    };
  },
  createGain() {
    return {
      gain: {
        setValueAtTime(value) { sampleGains.push(value); },
      },
      connect() { return this; },
    };
  },
};

const { state } = await import('../src/js/state.js');
state.sfxOn = true;
state.audioCtx = audioContext;

const { SAMPLE_VOLUME, playStart, playStop, playPaste } = await import('../src/js/sfx.js');
const settleAudio = () => new Promise(resolve => setTimeout(resolve, 0));

playStart();
await settleAudio();
assert.equal(starts, 1, '开始录音播放一次开始音');

playStop({ suppressNextPaste: false });
await settleAudio();
assert.equal(starts, 2, '按住说话松手播放一次结束音');

playPaste({ suppress: true });
await settleAudio();
assert.equal(starts, 2, '紧跟结束音的快捷键句粘贴不重复响');

playPaste();
await settleAudio();
assert.equal(starts, 3, '下一句连续听写粘贴必须恢复声音');

// 手动停止录音的老行为也要保留：如果停录后返回最后一句，只压掉那一次重复音。
playStop();
await settleAudio();
assert.equal(starts, 4, '手动停录播放结束音');
playPaste();
await settleAudio();
assert.equal(starts, 4, '停录后紧跟的最后一句粘贴不重复响');
playPaste();
await settleAudio();
assert.equal(starts, 5, '手动停录的静音也只能消费一次');
assert.equal(SAMPLE_VOLUME, 0.6, '开始音与结束音统一降到原音量的 60%');
assert.equal(sampleGains.length, starts, '每次真正播放 WAV 都必须经过音量节点');
assert.ok(sampleGains.every(value => value === SAMPLE_VOLUME), '开始、结束与粘贴复用音的音量一致');

console.log('sfx sequence tests passed');
