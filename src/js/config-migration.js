import { fetchLocalConfig, patchLocalConfig } from './storage.js';

// 只列「确实被读取并迁移过」的键。
//
// 原来这里还包含 `rtc_transcript_history` 和 `rtc_transcript_local_migrated_v1`：
// 它们从未被读过，却被无条件 removeItem 删掉——也就是「不迁移，只销毁」。
// 老版本的转写历史存在 localStorage 里，从那个版本升级上来的用户，历史会在启动时
// 静默消失（服务端 JSONL 里当然也没有，因为从没写过去）。不确定格式就别删：
// 留着是占几 KB，删掉是不可恢复的数据丢失。
const LEGACY_KEYS = [
  'rtc_asr_settings',
  'rtc_asr_cost',
  'rtc_correction_rules',
];

function readLegacySettings() {
  try {
    const raw = localStorage.getItem('rtc_asr_settings');
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

export async function migrateLegacyLocalConfig() {
  let legacyValues = null;
  try {
    legacyValues = {
      settings: readLegacySettings(),
      totalDuration: Number(localStorage.getItem('rtc_asr_cost')) || 0,
      correctionRules: localStorage.getItem('rtc_correction_rules'),
    };
  } catch (e) {
    legacyValues = null;
  }

  const hasLegacyValues = legacyValues && (
    legacyValues.settings ||
    legacyValues.totalDuration > 0 ||
    legacyValues.correctionRules
  );

  if (hasLegacyValues) {
    const config = await fetchLocalConfig();
    const patch = {};
    if (!config.settings && legacyValues.settings) {
      patch.settings = legacyValues.settings;
    }
    if (config.totalDuration == null && legacyValues.totalDuration > 0) {
      patch.totalDuration = legacyValues.totalDuration;
    }
    if (!config.correctionRules && legacyValues.correctionRules) {
      patch.correctionRules = legacyValues.correctionRules;
    }
    if (Object.keys(patch).length) {
      await patchLocalConfig(patch);
    }
  }

  try {
    for (const key of LEGACY_KEYS) {
      localStorage.removeItem(key);
    }
  } catch (e) {}
}
