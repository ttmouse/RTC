import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 按住说话「空按」不能上屏。
 *
 * 背景：用户按了快捷键却没说活（或只说了一个没成形的音），松手后 SenseVoice 会把那片
 * 静音幻觉成 "Okay." / "The." 之类的英文并直接上屏（2026-09-20 实测连续出现多条）。
 * 修法见 asr_local/server.py：按住期间统计人声证据，整段不足 MIN_VOICE_EVIDENCE_MS 就丢弃。
 *
 * 这里驱动真实的 python 会话对象（不加载模型，recognize 被替身接管），验证的是行为而不是
 * 源码文本——静态检查看不出「这段静音到底有没有被送进模型」。
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');

const script = String.raw`
import asyncio, importlib.util, json, sys
import numpy as np

spec = importlib.util.spec_from_file_location("asr_server", "asr_local/server.py")
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)


class FakeWs:
    def __init__(self):
        self.events = []

    async def send(self, msg):
        self.events.append(json.loads(msg))


class FakeEngine:
    async def load(self, engine, qwen3_dir=None):
        return None

    async def recognize(self, engine, pcm, qwen3_dir=None):
        return "替身识别结果"


def pcm_silence(ms):
    return np.zeros(int(16000 * ms / 1000), dtype=np.int16).tobytes()


def pcm_tone(ms, amp=0.05):
    n = int(16000 * ms / 1000)
    t = np.arange(n) / 16000.0
    return (amp * np.sin(2 * np.pi * 220 * t) * 32767).astype(np.int16).tobytes()


def new_session(push_to_talk):
    ws = FakeWs()
    s = mod.Session(ws, "t", FakeEngine(), "sensevoice")
    s.push_to_talk = push_to_talk
    s.rms_threshold = 0.0015
    s.silence_cut_ms = 500
    return s, ws


async def run(chunks, push_to_talk=True, reason="manual_release"):
    s, ws = new_session(push_to_talk)
    for c in chunks:
        await s.feed_audio(c)
    await s.flush_segment(final=True, reason=reason)
    return [e for e in ws.events if e["header"]["event"] == "result-generated"]


async def case(name, cond):
    print(("  ✓ " if cond else "  ✗ ") + name)
    return cond


async def main():
    results = []
    results.append(await case(
        "按住不开口（1 秒静音）不上屏",
        len(await run([pcm_silence(1000)])) == 0,
    ))
    results.append(await case(
        "按住只碰到一下（单个 32ms 脉冲）不上屏",
        len(await run([pcm_tone(32, 0.3)])) == 0,
    ))
    results.append(await case(
        "按住确实说了话（500ms）照常出结果",
        len(await run([pcm_tone(500, 0.05)])) == 1,
    ))
    results.append(await case(
        "短短一句（100ms，够人声证据）不被吞",
        len(await run([pcm_tone(100, 0.05)])) == 1,
    ))
    results.append(await case(
        "上一条的静音不该把人声证据带进下一条",
        len(await run([pcm_silence(400), pcm_tone(400, 0.05)])) == 1,
    ))
    results.append(await case(
        "常态录音（未按快捷键）仍按原门槛丢弃纯静音",
        len(await run([pcm_silence(1500)], push_to_talk=False, reason="silence_timeout")) == 0,
    ))
    results.append(await case(
        "常态录音（未按快捷键）连续说话照常出结果",
        len(await run([pcm_tone(700, 0.05)], push_to_talk=False, reason="silence_timeout")) == 1,
    ))
    sys.exit(0 if all(results) else 1)


asyncio.run(main())
`;

const result = spawnSync('python3', ['-'], {
  cwd: repo,
  input: script,
  encoding: 'utf8',
});

process.stdout.write(result.stdout || '');
if (result.stderr) process.stderr.write(result.stderr);

assert.notEqual(result.status, null, 'python3 没能启动（按住说话人声证据测试需要 numpy）');
assert.equal(result.status, 0, '按住说话空按过滤：有人声证据的判据不符合预期');
assert.match(result.stdout, /✓ 按住不开口（1 秒静音）不上屏/);

console.log('manual hallucination guard tests passed');
