import { fetchLocalConfig, patchLocalConfig } from './storage.js';

const LEGACY_KEYS = [
  'rtc_asr_settings',
  'rtc_asr_cost',
  'rtc_correction_rules',
  'rtc_transcript_history',
  'rtc_transcript_local_migrated_v1',
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
