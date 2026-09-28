// Only numeric summaries are saved locally. No samples, images, or network requests.
import { TERM_SIGNALS, EXPRESSION_PROFILES, CONFIG } from './config.js';
const KEY = 'reaction-bot.calibration.v1';
const VERSION = 1;
const requiredSignals = [...new Set([...Object.values(TERM_SIGNALS).flat(), ...Object.keys(CONFIG.activity.weights)])];
const validNumber = v => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
function cleanMap(value, required) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Invalid map');
  if (!required.every(k => validNumber(value[k]))) throw Error('Missing numeric signal');
  const entries = Object.entries(value);
  if (entries.length > 100 || !entries.every(([k,v]) => /^[a-zA-Z][a-zA-Z0-9]*$/.test(k) && validNumber(v))) throw Error('Invalid signals');
  return Object.fromEntries(entries);
}
export function readCalibration(storage) {
  try {
    const raw = (storage ?? globalThis.localStorage).getItem(KEY);
    if (!raw) return { status: 'empty' };
    if (raw.length > 30000) return { status: 'invalid' };
    const data = JSON.parse(raw);
    if (data.version !== VERSION) return { status: 'invalid' };
    const mean = cleanMap(data.mean, requiredSignals);
    const std = cleanMap(data.std, requiredSignals);
    const profiles = {};
    if (!data.profiles || typeof data.profiles !== 'object' || Array.isArray(data.profiles)) throw Error('Invalid profiles');
    for (const [name, terms] of Object.entries(data.profiles)) {
      if (!Object.hasOwn(EXPRESSION_PROFILES, name)) throw Error('Unknown profile');
      profiles[name] = cleanMap(terms, EXPRESSION_PROFILES[name].terms);
    }
    return { status: 'loaded', data: { mean, std, profiles } };
  } catch { return { status: 'unavailable' }; }
}
export function restoreCalibration(data, baseline, calibrator) {
  baseline.reset();
  baseline.mean = { ...data.mean };
  baseline.std = { ...data.std };
  baseline.done = true;
  calibrator.clearAll();
  // Re-evaluate stored amplitudes under current rules, never restore executable weights.
  for (const [name, terms] of Object.entries(data.profiles)) {
    const mean = { ...baseline.mean };
    for (const [term, amp] of Object.entries(terms)) {
      for (const signal of TERM_SIGNALS[term] ?? []) mean[signal] = Math.min(1, baseline.mean[signal] + amp);
    }
    const result = calibrator.evaluateBurst(name, { mean });
    if (result.accepted) calibrator.commit(result);
  }
}
export function saveCalibration(baseline, calibrator, storage) {
  try {
    if (!baseline.done) return false;
    const profiles = {};
    for (const [name, profile] of Object.entries(calibrator.profiles)) {
      if (profile.accepted) profiles[name] = cleanMap(profile.ampByTerm, EXPRESSION_PROFILES[name].terms);
    }
    const data = { version: VERSION, mean: cleanMap(baseline.mean, requiredSignals), std: cleanMap(baseline.std, requiredSignals), profiles };
    (storage ?? globalThis.localStorage).setItem(KEY, JSON.stringify(data));
    return true;
  } catch { return false; }
}
export function clearCalibration(storage) {
  try { (storage ?? globalThis.localStorage).removeItem(KEY); return true; }
  catch { return false; }
}
