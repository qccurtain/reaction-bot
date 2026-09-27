// ============================================================================
// Per-user neutral baseline. Collects ~10s of blendshape samples while the
// user holds a neutral face, then exposes mean/std per signal so the state
// engine can compare "current" against "this person's normal" rather than
// a fixed absolute threshold.
//
// Also reused (with shorter duration/minSamples) as a generic sample burst
// collector for optional expression calibration -- see
// expressionCalibration.js. The mean/std/band machinery is identical; only
// how long we collect for and what the samples mean differs.
// ============================================================================

import { CONFIG } from "./config.js";

export class BaselineCollector {
  constructor({ durationMs, minSamples } = {}) {
    this.durationMs = durationMs ?? CONFIG.calibration.durationMs;
    this.minSamples = minSamples ?? CONFIG.calibration.minSamples;
    this.reset();
  }

  reset() {
    this.samples = []; // array of blendshape maps
    this.startedAt = null;
    this.done = false;
    this.mean = {};
    this.std = {};
  }

  start() {
    this.reset();
    this.startedAt = performance.now();
  }

  get progress() {
    if (!this.startedAt) return 0;
    const elapsed = performance.now() - this.startedAt;
    return Math.max(0, Math.min(1, elapsed / this.durationMs));
  }

  get elapsedMs() {
    if (!this.startedAt) return 0;
    return performance.now() - this.startedAt;
  }

  // Call once per detection frame while calibrating and face is present.
  // Returns true once calibration has collected enough time+samples.
  addSample(blendshapes) {
    if (this.done) return true;
    this.samples.push(blendshapes);
    const timeUp = this.elapsedMs >= this.durationMs;
    const enoughSamples = this.samples.length >= this.minSamples;
    if (timeUp && enoughSamples) {
      this._computeStats();
      this.done = true;
    }
    return this.done;
  }

  // Face disappeared mid-calibration: don't record bad data, just pause the
  // clock by nudging startedAt forward so elapsed time excludes the gap.
  pauseFor(gapMs) {
    if (this.startedAt) this.startedAt += gapMs;
  }

  _computeStats() {
    const names = new Set();
    for (const s of this.samples) for (const k of Object.keys(s)) names.add(k);

    for (const name of names) {
      const values = this.samples.map((s) => s[name] ?? 0);
      const mean = values.reduce((a, b) => a + b, 0) / values.length;
      const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
      this.mean[name] = mean;
      this.std[name] = Math.sqrt(variance);
    }
  }

  // Public: the noise-band width for a signal, i.e. how much this person's
  // OWN neutral-hold data jittered (floored so a near-zero-variance signal
  // still gets a sane minimum). Used both by significance() below and by
  // expressionCalibration.js as the "generic expected amplitude" reference
  // for a full-strength expression.
  band(name) {
    const floor = CONFIG.calibration.minNoiseBand[name] ?? CONFIG.calibration.minNoiseBand.default;
    const std = this.std[name] ?? 0;
    return Math.max(floor, std * CONFIG.calibration.bandStdMultiplier);
  }

  // Raw delta from this person's neutral baseline for a signal.
  delta(name, rawValue) {
    const mean = this.mean[name] ?? 0;
    return rawValue - mean;
  }

  // "How many noise-bands above baseline", clamped to 0..1. This is the
  // main normalized unit state-scoring functions consume.
  significance(name, rawValue) {
    const d = this.delta(name, rawValue);
    return Math.max(0, Math.min(1, d / this.band(name)));
  }

  getMean(name) {
    return this.mean[name] ?? 0;
  }
}
