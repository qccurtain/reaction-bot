// ============================================================================
// Optional personal expression calibration.
//
// This is layered ON TOP of the neutral BaselineCollector, never a
// replacement for it. If the user skips this entirely (or skips/rejects a
// specific profile), StateEngine's scoring for that state is byte-for-byte
// the original default-weights/generic-band formula -- nothing below this
// comment path ever runs for that state. See config.js
// "Optional personal expression calibration" for the tunable constants.
//
// Data lives only in memory for this page session (a plain instance field on
// this class) -- never written to storage, never sent anywhere.
// ============================================================================

import { EXPRESSION_PROFILES, EXPRESSION_CALIBRATION, TERM_SIGNALS, STATE_TO_PROFILE } from "./config.js";
import { BaselineCollector } from "./baseline.js";

function avgOf(names, map) {
  return names.reduce((sum, n) => sum + (map[n] ?? 0), 0) / names.length;
}

// Redistributes weight, within just the covered terms, toward whichever
// term(s) this person separated from neutral the most (relative to their own
// strongest term), while conserving the exact original weight sum for that
// covered subset. Terms not covered by the profile (e.g. SHOCKED's
// `suddenChange`, HAPPY's `laughBonus`) are returned completely untouched.
// Exported for the regression tests.
export function personalizeWeights(defaultWeights, salienceByTerm, opts = EXPRESSION_CALIBRATION.reweight) {
  const { minRetention, salienceCap } = opts;
  const covered = Object.keys(defaultWeights).filter((t) => salienceByTerm[t] !== undefined);
  if (covered.length === 0) return { ...defaultWeights };

  const maxSalience = Math.max(...covered.map((t) => salienceByTerm[t]), 1e-6);
  const subBudget = covered.reduce((s, t) => s + defaultWeights[t], 0);

  const raw = {};
  for (const t of covered) {
    const relative = Math.min(salienceCap, salienceByTerm[t] / maxSalience);
    raw[t] = defaultWeights[t] * Math.max(minRetention, relative);
  }
  const totalRaw = covered.reduce((s, t) => s + raw[t], 0);
  const scale = totalRaw > 0 ? subBudget / totalRaw : 1;

  const out = { ...defaultWeights };
  for (const t of covered) out[t] = raw[t] * scale;
  return out;
}

export class ExpressionCalibrator {
  constructor(neutralBaseline) {
    this.baseline = neutralBaseline;
    this.profiles = {}; // profileName -> { accepted, ampByTerm, salienceByTerm, maxSalience }
  }

  // A fresh burst collector for the given profile, sized per
  // EXPRESSION_CALIBRATION (shorter than the 10s neutral capture).
  createBurstCollector() {
    return new BaselineCollector({
      durationMs: EXPRESSION_CALIBRATION.durationMs,
      minSamples: EXPRESSION_CALIBRATION.minSamples,
    });
  }

  // Call once a burst collector reports `done`. Does NOT commit anything --
  // returns an evaluation the caller (main.js) uses to decide accept/retry.
  evaluateBurst(profileName, burst) {
    const profile = EXPRESSION_PROFILES[profileName];
    const ampByTerm = {};
    const salienceByTerm = {};
    let maxSalience = 0;

    for (const term of profile.terms) {
      const names = TERM_SIGNALS[term];
      const burstAvg = avgOf(names, burst.mean);
      const neutralAvg = avgOf(names, this.baseline.mean);
      const amp = Math.max(0, burstAvg - neutralAvg);
      const genericExpected = avgOf(
        names,
        Object.fromEntries(names.map((n) => [n, this.baseline.band(n)]))
      );
      const salience = genericExpected > 0 ? amp / genericExpected : 0;
      ampByTerm[term] = amp;
      salienceByTerm[term] = salience;
      maxSalience = Math.max(maxSalience, salience);
    }

    const accepted = maxSalience >= EXPRESSION_CALIBRATION.rejectSalienceThreshold;
    return { profileName, accepted, maxSalience, ampByTerm, salienceByTerm };
  }

  commit(evalResult) {
    this.profiles[evalResult.profileName] = evalResult;
  }

  clear(profileName) {
    delete this.profiles[profileName];
  }

  clearAll() {
    this.profiles = {};
  }

  isCalibrated(profileName) {
    return !!this.profiles[profileName]?.accepted;
  }

  hasAnyCalibration() {
    return Object.values(this.profiles).some((p) => p.accepted);
  }

  _profileFor(stateName) {
    const name = STATE_TO_PROFILE[stateName];
    return name ? this.profiles[name] : undefined;
  }

  // Returns personalized weights for a state's default weights, or the
  // exact same object reference back if no accepted calibration exists for
  // it -- callers can treat "personalized or not" as fully transparent.
  getWeights(stateName, defaultWeights) {
    const prof = this._profileFor(stateName);
    if (!prof || !prof.accepted) return defaultWeights;
    return personalizeWeights(defaultWeights, prof.salienceByTerm, EXPRESSION_CALIBRATION.reweight);
  }

  // Returns a personalized band for a term (a number), or null to mean
  // "no personalization available, use the generic band". The state engine
  // takes max(generic, personal), preserving the neutral noise floor.
  // A larger personal band reduces sensitivity; weight redistribution is
  // what can improve recognition when only a subset of signals moves.
  getPersonalBand(stateName, term) {
    const prof = this._profileFor(stateName);
    if (!prof || !prof.accepted) return null;
    const amp = prof.ampByTerm[term];
    if (amp === undefined) return null;
    return amp * EXPRESSION_CALIBRATION.bandMargin;
  }
}
