import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

globalThis.document = {
  readyState: 'complete',
  addEventListener() {},
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
};
globalThis.window = { addEventListener() {}, __TAURI__: null };
globalThis.WebSocket = class WebSocket { static OPEN = 1; };

const { state, normalizePushToTalkKey, pushToTalkKeyLabel } = await import('../src/js/state.js');
const { flushPushToTalkSegment, discardPushToTalkSegment, pasteEnabledForResult } = await import('../src/js/asr.js');

let passed = 0;
function check(name, condition) {
  assert.ok(condition, name);
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function readySocket() {
  const sent = [];
  state.asrWs = { readyState: WebSocket.OPEN, send: value => sent.push(value) };
  state.asrReady = true;
  state.pushToTalkFlushPending = false;
  state.pcmSendBuffer = [];
  return sent;
}

state.asrEngine = 'sensevoice';
let sent = readySocket();
flushPushToTalkSegment();
check('本地引擎松开时发送 flush-segment，不结束热连接', JSON.parse(sent[0]).header.action === 'flush-segment');
check('本地冲刷后连接仍可继续接下一句', state.asrReady === true);

state.asrEngine = 'bailian';
sent = readySocket();
flushPushToTalkSegment();
check('百炼松开时发送 finish-task', JSON.parse(sent[0]).header.action === 'finish-task');
check('百炼任务结束后先标记为未就绪，避免音频误发给旧任务', state.asrReady === false);

state.asrWs = null;
state.asrReady = false;
state.pushToTalkFlushPending = false;
flushPushToTalkSegment();
check('短句说完时连接还没就绪，会记住稍后立即提交', state.pushToTalkFlushPending === true);

state.asrEngine = 'sensevoice';
sent = readySocket();
state.pcmSendBuffer = [new Int16Array([1, 2])];
discardPushToTalkSegment();
check('组合键会丢弃本地当前段，而不是提交识别', JSON.parse(sent[0]).header.action === 'discard-segment');
check('组合键取消时也会清掉尚未发送的音频', state.pcmSendBuffer.length === 0);
check('左右修饰键配置保留物理按键身份', normalizePushToTalkKey('right-control') === 'right-control');
check('未知快捷键安全回落到左 Option', pushToTalkKeyLabel('not-a-key') === '左 ⌥');

state.autoPaste = false;
state.autoPasteApps = ['SomeOtherApp'];
check('主界面自动粘贴关闭且应用不在名单时，快捷键句仍强制粘贴',
  pasteEnabledForResult({ name: 'CurrentApp' }, true) === true);
check('相同条件下普通连续录音仍不粘贴',
  pasteEnabledForResult({ name: 'CurrentApp' }, false) === false);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(root, 'src/index.html'), 'utf8');
const main = fs.readFileSync(path.join(root, 'src/js/main.js'), 'utf8');
const audio = fs.readFileSync(path.join(root, 'src/js/audio.js'), 'utf8');
const asr = fs.readFileSync(path.join(root, 'src/js/asr.js'), 'utf8');
const settings = fs.readFileSync(path.join(root, 'src/js/settings.js'), 'utf8');
const clipboard = fs.readFileSync(path.join(root, 'src/js/clipboard.js'), 'utf8');
const sfx = fs.readFileSync(path.join(root, 'src/js/sfx.js'), 'utf8');
const python = fs.readFileSync(path.join(root, 'asr_local/server.py'), 'utf8');
const rust = fs.readFileSync(path.join(root, 'src-tauri/src/lib.rs'), 'utf8');
check('前端监听统一的左右修饰键事件', main.includes("listen('rtc:modifier-key', handleModifierKey)"));
check('快捷键录制不会在设置保存前改动生效值', main.includes('pushToTalkKeyDraft') && main.includes('state.pushToTalkKey = normalizePushToTalkKey(pushToTalkKeyDraft)'));
check('主界面不再放按住说话开关', !html.includes('id="ftPushToTalk"') && !main.includes("$('ftPushToTalk')"));
check('按住说话开关与快捷键统一放在设置页', html.includes('id="pushToTalkEnabledToggle"') && html.includes('id="pushToTalkShortcutBtn"'));
check('按住说话开关复用设置页已有开关样式', /class="settingsToggle" id="pushToTalkEnabledToggle"/.test(html));
check('录制快捷键会自动开启设置草稿', /pushToTalkKeyDraft = normalizePushToTalkKey\(key\)[\s\S]{0,180}pushToTalkEnabledDraft = true/.test(main));
check('设置保存才让开关和快捷键一起生效', /state\.pushToTalkKey = normalizePushToTalkKey\(pushToTalkKeyDraft\)[\s\S]{0,160}setPushToTalk\(pushToTalkEnabledDraft/.test(main));
check('设置页开关不再由主界面同步函数接管', !settings.includes('ftPushToTalk'));
check('普通组合键会取消本次按住说话', main.includes("keyState === 'chord'") && main.includes('cancelPushToTalkRec'));
check('本地服务实现主动冲刷控制消息', /action == "flush-segment"[\s\S]{0,240}manual_release/.test(python));
check('本地服务实现主动丢弃控制消息', /action == "discard-segment"[\s\S]{0,300}self\.buf\.clear/.test(python));
check('WebSocket 入口把冲刷/丢弃/切换手动断句/阈值更新消息交给当前识别会话', /action in \("finish-task", "flush-segment", "discard-segment", "set-manual-segment", "set-vad-threshold"\)[\s\S]{0,180}session\.handle_json\(msg\)/.test(python));
check('只有 finish-task 会销毁当前识别会话', /if action == "finish-task":[\s\S]{0,80}session = None/.test(python));
check('按住期间的停顿不会触发静音自动提交', /not self\.push_to_talk and self\.silence_ms >= self\.silence_cut_ms/.test(python));
check('本地按住期间不做切句过滤，每一帧都直接进缓冲', /if self\.push_to_talk:[\s\S]{0,900}self\.buf\.extend\(frame_bytes\)[\s\S]{0,30}continue/.test(python));
// 每帧都进缓冲 ≠ 每段都上屏：按住不开口时那片静音会被 SenseVoice 幻觉成 "Okay." / "The."
// 之类的英文（2026-09-20 实测），所以按住期间仍要统计人声证据，松手时据此丢弃空按。
check('本地按住期间仍统计人声证据（空按靠它拦住）', /if self\.push_to_talk:[\s\S]{0,900}self\.seg_active_ms \+= frame_ms/.test(python));
check('本地按住松手不要求最短发声时长，但要求整段有人声证据',
  /voice_evidence = active_ms >= MIN_VOICE_EVIDENCE_MS/.test(python)
  && /passes_min_speech = buffered_ms > 0 and voice_evidence/.test(python));
check('本地按住空按时整段丢弃并说清原因', /空按：整段无人声证据/.test(python));
check('云端按住期间不走 vadSend 门槛而直接发送 PCM', /if \(state\.pushToTalkManual\)[\s\S]{0,300}sendPCM\(pcm\)[\s\S]{0,80}else[\s\S]{0,80}vadSend\(down, pcm\)/.test(audio));
check('按住说话保留用户主动说出的短文本', asr.includes('state.noiseFilter && !pushToTalkResult'));
check('按住说话时阈值刻度隐藏且不可拖动', settings.includes("classList.toggle('threshold-disabled', state.pushToTalkManual)") && main.includes('if (state.pushToTalkManual) return'));

// ---- 2026-09-20：按住说话与常态 VAD 录音共存 ----
// 用户要的是「叠加」而不是「二选一」：按住时只把这一句的句尾交给手，松开立刻回到
// VAD 自动断句。下面这几条锁住这个语义，防止回退成「开开关就把常态录音关掉」。
const pttFn = (from, to) => {
  const start = main.indexOf(from);
  const end = main.indexOf(to, start);
  return start >= 0 && end > start ? main.slice(start, end) : '';
};
const setPttFn = pttFn('function setPushToTalk', 'const PUSH_TO_TALK_HOLD_DELAY_MS');
check('打开按住说话开关不再停掉常态录音',
  setPttFn.length > 0 && !/stopRec\(|stopPushToTalkRec\(|disconnectBailian\(/.test(setPttFn));
const startPttFn = pttFn('async function startPushToTalk', 'function beginPushToTalk');
check('按下只把「这一段」交给手动，不重启录音',
  /state\.pushToTalkManual = true/.test(startPttFn)
    && /beginPushToTalkSegment\(\)/.test(startPttFn)
    && !/stopRec\(|stopPushToTalkRec\(/.test(startPttFn));
const beginPttFn = pttFn('function beginPushToTalk', 'function endPushToTalk');
check('物理键按下立即点亮菜单栏，不等 180ms 或 VAD', (() => {
  const activeAt = beginPttFn.indexOf('state.pushToTalkVisualActive = true');
  const renderAt = beginPttFn.indexOf('renderRunStatus()');
  const timerAt = beginPttFn.indexOf('setTimeout');
  return activeAt >= 0 && renderAt > activeAt && timerAt > renderAt;
})());
const endPttFn = pttFn('function endPushToTalk', 'function handleModifierKey');
check('松开只冲刷当前句，录音继续（松开后回到常态）',
  /flushPushToTalkSegment\(\)/.test(endPttFn) && !/stopRec\(|stopCapture\(/.test(endPttFn));
check('物理键松开立即撤回菜单栏点亮，不等识别结果', (() => {
  const inactiveAt = endPttFn.indexOf('state.pushToTalkVisualActive = false');
  const renderAt = endPttFn.indexOf('renderRunStatus()');
  const flushAt = endPttFn.indexOf('flushPushToTalkSegment()');
  return inactiveAt >= 0 && renderAt > inactiveAt && flushAt > renderAt;
})());
check('松手只清理等待定时器，不提前取消已经开始的手动段',
  /clearTimeout\(pushToTalkStartTimer\)/.test(endPttFn) && !/cancelPushToTalkStart\(/.test(endPttFn));
check('未在录音时按下快捷键会替你转入常态', /await toggleRecording\(\)/.test(startPttFn));
check('按住说话每一句都有开始音，首次自动开录时不重复播放',
  /if \(!pushToTalkOwnsRecording\) playStart\(\)/.test(startPttFn));
check('松手提交当前句前播放结束音', (() => {
  const soundAt = endPttFn.indexOf('playStop({ suppressNextPaste: false })');
  const flushAt = endPttFn.indexOf('flushPushToTalkSegment()');
  return soundAt >= 0 && flushAt > soundAt;
})());
check('连续听写的粘贴成功音仍保留',
  /const afterPaste = \(status, source\)[\s\S]{0,600}playPaste\(\{ suppress: suppressSound \}\)/.test(clipboard)
    && /export function playPaste\(\{ suppress = false \} = \{\}\)[\s\S]{0,220}suppressNextPasteSound = false;[\s\S]{0,120}playSample\('stop'\)/.test(sfx)
    && asr.includes('suppressPasteSound: forcePaste'));
check('按住说话的最终结果携带独立粘贴身份，不依赖结果返回时的界面状态',
  python.includes('"manual_segment": manual_segment')
    && asr.includes('sentence.manual_segment === true')
    && asr.includes('state.pushToTalkPasteTaskId'));
check('快捷键句强制粘贴，普通句仍服从自动粘贴规则',
  /export function pasteEnabledForResult\(target, forcePaste = false\)[\s\S]{0,160}forcePaste \|\| shouldAutoPaste\(target\)/.test(asr));
check('本地服务端支持会话中途切换手动断句',
  /action == "set-manual-segment"[\s\S]{0,500}self\.push_to_talk = bool/.test(python));
check('控制消息白名单与 handle_json 认的动作不脱节（漏一个就是「发了但没生效」）', (() => {
  const route = python.match(/elif action in \(([^)]*)\)/);
  if (!route) return false;
  const routed = new Set([...route[1].matchAll(/"([a-z-]+)"/g)].map(m => m[1]));
  const handled = new Set([...python.matchAll(/action == "([a-z-]+)"/g)].map(m => m[1]));
  routed.add('run-task');   // 入口单独处理，不进白名单
  return routed.size === handled.size && [...routed].every(a => handled.has(a));
})());
check('先冲刷、后把断句权交回 VAD（轻声短词不被最小发声门槛丢掉）', (() => {
  const start = asr.indexOf('export function flushPushToTalkSegment');
  const fn = start < 0 ? '' : asr.slice(start, asr.indexOf('export function', start + 10));
  const flushAt = fn.indexOf("'flush-segment'");
  const backAt = fn.indexOf('sendManualSegment(false)');
  return flushAt >= 0 && backAt > flushAt;
})());
check('桌面端按 keyCode 区分左右 Control 与 Option', [58, 59, 61, 62].every(code => rust.includes(`${code} => Some`)));
check('桌面端监听修饰键变化和普通键按下', rust.includes('NSEventMask::FlagsChanged | NSEventMask::KeyDown'));
check('桌面端把其它修饰键介入识别为组合键', rust.includes('has_other_modifier') && rust.includes('emit_chord(app)'));
check('桌面端排除 Caps Lock 映射出的 Shift+Control+Option+Command 组合',
  rust.includes('Shift+Control+Option+Command')
    && rust.includes('NSEventModifierFlags::Shift')
    && rust.includes('NSEventModifierFlags::Command'));
check('桌面端对未知物理修饰键但已有修饰标志的事件也按组合键处理',
  /let Some\(\(key, own_flag\)\) = modifier_from_event\(event\) else/.test(rust)
    && /if has_any_modifier\(flags\) \{\s*emit_chord\(app\);/.test(rust));
check('桌面端不再注册固定的 Option+Space', !rust.includes('Modifiers::ALT), Code::Space'));

console.log(`\n${passed} passed, 0 failed`);
