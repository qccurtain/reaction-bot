// ============================================================================
// Heuristic meme-state classifier.
//
// Pipeline (per spec):
//   camera signals -> normalize vs personal baseline -> temporal smoothing
//   -> candidate state -> persistence check -> current meme state
//
// This module intentionally contains NO magic numbers -- every threshold and
// duration is read from config.js so the rules can be retuned without
// touching this logic. See README.md "Where thresholds live" for a map.
//
// These are visible-reaction classifications for entertainment, not
// psychological or emotional diagnoses.
// ============================================================================

import { CONFIG, STATES, STATE_PRIORITY, TERM_SIGNALS } from "./config.js";

function avg(...vals) {
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}
function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}
function toDeg(rad) {
  return (rad * 180) / Math.PI;
}

// Generic enter/exit persistence tracker shared by every discrete state.
// `confirmed` only flips true after `score` stays >= enterThreshold for
// minDurationMs, and only flips back false after it stays < exitThreshold
// for exitGraceMs. This is what prevents rapid flickering.
class PersistenceGate {
  constructor(minDurationMs, exitGraceMs) {
    this.minDurationMs = minDurationMs;
    this.exitGraceMs = exitGraceMs;
    this.aboveSince = null;
    this.belowSince = null;
    this.confirmed = false;
    this.candidateSince = null; // how long this has been *trying* to enter
  }

  update(now, isAboveEnter, isBelowExit) {
    if (!this.confirmed) {
      if (isAboveEnter) {
        if (this.aboveSince === null) this.aboveSince = now;
        this.candidateSince = this.aboveSince;
        if (now - this.aboveSince >= this.minDurationMs) {
          this.confirmed = true;
          this.belowSince = null;
        }
      } else {
        this.aboveSince = null;
        this.candidateSince = null;
      }
    } else {
      if (isBelowExit) {
        if (this.belowSince === null) this.belowSince = now;
        if (now - this.belowSince >= this.exitGraceMs) {
          this.confirmed = false;
          this.aboveSince = null;
          this.belowSince = null;
        }
      } else {
        this.belowSince = null;
      }
    }
    return this.confirmed;
  }

  candidateDurationMs(now) {
    if (this.confirmed) return now - (this.aboveSince ?? now);
    if (this.candidateSince === null) return 0;
    return now - this.candidateSince;
  }
}

export class StateEngine {
  constructor(baseline, exprCalibrator = null) {
    this.baseline = baseline;
    this.exprCalibrator = exprCalibrator; // optional; see expressionCalibration.js
    this.fastEma = {};
    this.slowEma = {};
    this.prevRaw = {};
    this.prevRoll = 0;
    this.activityLevel = 0;

    this.sessionStartAt = null;
    this.sessionPausedAccum = 0;
    this._pauseStartedAt = null;

    this.lowActivityStart = null; // LOCKED_IN candidate window
    this.veryLowActivityStart = null; // DEAD_INSIDE candidate window
    this._lockedInGraceUntilFalse = null;
    this._deadInsideGraceUntilFalse = null;
    this.lockedInConfirmed = false;
    this.deadInsideConfirmed = false;

    const s = CONFIG.states;
    this.gates = {
      [STATES.SHOCKED]: new PersistenceGate(s.SHOCKED.minDurationMs, s.SHOCKED.exitGraceMs),
      [STATES.HAPPY]: new PersistenceGate(s.HAPPY.minDurationMs, s.HAPPY.exitGraceMs),
      [STATES.TILTED]: new PersistenceGate(s.TILTED.minDurationMs, s.TILTED.exitGraceMs),
      [STATES.CONFUSED]: new PersistenceGate(s.CONFUSED.minDurationMs, s.CONFUSED.exitGraceMs),
    };

    this.activeState = STATES.NEUTRAL;
    this.activeSince = performance.now();
    this.lastCandidate = STATES.NEUTRAL;
  }

  beginSession() {
    this.reset();
    this._pauseStartedAt = null;
    this.sessionStartAt = performance.now();
    this.sessionPausedAccum = 0;
  }

  pause() {
    this.freezeGates();
    if (this._pauseStartedAt == null) this._pauseStartedAt = performance.now();
  }

  resume() {
    if (this._pauseStartedAt != null) {
      this.sessionPausedAccum += performance.now() - this._pauseStartedAt;
      this._pauseStartedAt = null;
    }
  }

  get sessionActiveMs() {
    if (this.sessionStartAt == null) return 0;
    return (this._pauseStartedAt ?? performance.now()) - this.sessionStartAt - this.sessionPausedAccum;
  }

  reset() {
    this.fastEma = {};
    this.slowEma = {};
    this.prevRaw = {};
    this.prevRoll = 0;
    this.activityLevel = 0;
    this._lockedInGraceUntilFalse = null;
    this._deadInsideGraceUntilFalse = null;
    this.activeState = STATES.NEUTRAL;
    this.activeSince = performance.now();
    for (const g of Object.values(this.gates)) {
      g.aboveSince = null;
      g.belowSince = null;
      g.confirmed = false;
      g.candidateSince = null;
    }
    this.lowActivityStart = null;
    this.veryLowActivityStart = null;
    this.lockedInConfirmed = false;
    this.deadInsideConfirmed = false;
  }

  // Lighter than reset(): only clears the IN-PROGRESS timers (a gate's
  // aboveSince/belowSince/candidateSince, and the LOCKED_IN/DEAD_INSIDE
  // low-activity start times), leaving `confirmed` flags and `activeState`
  // untouched. This is what must run after any gap where update() wasn't
  // called with fresh evidence -- a face-loss frame, a pause, a
  // (re)calibration interlude -- so that once real frames resume, a gate
  // doesn't see `now - staleAboveSince >= minDurationMs` and instantly
  // false-confirm purely because wall-clock time passed while nobody was
  // watching. Safe to call every single frame the face is missing; it does
  // NOT reset `confirmed`, so a state that was already active/displayed
  // doesn't flicker off just because of one dropped frame.
  freezeGates() {
    for (const g of Object.values(this.gates)) {
      g.aboveSince = null;
      g.belowSince = null;
      g.candidateSince = null;
    }
    this.lowActivityStart = null;
    this.veryLowActivityStart = null;
  }

  raw(name, blendshapes) {
    return blendshapes[name] ?? 0;
  }

  sig(name) {
    return this.baseline.significance(name, this.fastEma[name] ?? 0);
  }

  // Scores a state's named "term" (see TERM_SIGNALS in config.js). When
  // `personalBand` is null (no accepted calibration for this term), this is
  // BYTE-FOR-BYTE the original formula: a single raw significance() call for
  // a 1-name term, or an average of two independent significance() calls for
  // an avg(left,right) term -- i.e. the untouched default path. Only when a
  // personal band is supplied does it switch to the "average the raw values
  // first, then normalize once" personalized formula.
  termSig(term, personalBand) {
    const names = TERM_SIGNALS[term];
    if (names.length === 1) {
      const name = names[0];
      if (personalBand == null) return this.sig(name);
      const raw = this.fastEma[name] ?? 0;
      const delta = raw - this.baseline.getMean(name);
      const band = Math.max(this.baseline.band(name), personalBand);
      return clamp01(delta / band);
    }
    if (personalBand == null) {
      return avg(...names.map((n) => this.sig(n)));
    }
    const avgRaw = avg(...names.map((n) => this.fastEma[n] ?? 0));
    const avgMean = avg(...names.map((n) => this.baseline.getMean(n)));
    const genericBandAvg = avg(...names.map((n) => this.baseline.band(n)));
    const band = Math.max(genericBandAvg, personalBand);
    return clamp01((avgRaw - avgMean) / band);
  }

  update({ present, blendshapes, headAngles }) {
    const now = performance.now();
    const cfg = CONFIG.states;

    if (!present) {
      // No face: don't accumulate bogus evidence. freezeGates() also stops a
      // dropout's wall-clock gap from later reading as "stillness" toward
      // LOCKED_IN/DEAD_INSIDE, or as satisfied minDurationMs on whatever
      // gate happened to be mid-accumulation when the face disappeared.
      this.freezeGates();
      return this._finalize(now, {
        present: false,
        breakdown: {},
        activity: this.activityLevel,
        candidateState: STATES.NEUTRAL,
        candidateDurationMs: 0,
        candidateTargetMs: 0,
      });
    }

    // ---- smoothing ----
    const alphaF = CONFIG.smoothing.fastAlpha;
    const alphaS = CONFIG.smoothing.slowAlpha;
    for (const [name, value] of Object.entries(blendshapes)) {
      this.fastEma[name] = this.fastEma[name] === undefined ? value : alphaF * value + (1 - alphaF) * this.fastEma[name];
      this.slowEma[name] = this.slowEma[name] === undefined ? value : alphaS * value + (1 - alphaS) * this.slowEma[name];
    }

    // ---- activity meter (feeds LOCKED_IN / DEAD_INSIDE) ----
    // Two components, combined with max():
    //   - movement: frame-to-frame delta (catches active gesturing/talking)
    //   - deviation: how far the CURRENT pose sits from this person's
    //     neutral baseline (catches a face frozen in a held expression --
    //     e.g. a sustained scowl has near-zero frame-to-frame delta once it
    //     settles, but should never read as "zoned out neutral stillness").
    // Without the deviation term, a static non-neutral expression would look
    // identical to true relaxed stillness once it stopped changing frame to
    // frame, incorrectly priming LOCKED_IN/DEAD_INSIDE.
    let movementRaw = 0;
    let deviationRaw = 0;
    let weightSum = 0;
    for (const [name, w] of Object.entries(CONFIG.activity.weights)) {
      const cur = blendshapes[name] ?? 0;
      const prev = this.prevRaw[name] ?? cur;
      movementRaw += Math.abs(cur - prev) * w;
      deviationRaw += this.baseline.significance(name, cur) * w;
      weightSum += w;
    }
    const rollDeg = toDeg(headAngles.roll);
    const rollDeltaNorm = clamp01(Math.abs(rollDeg - this.prevRoll) / 10);
    movementRaw += rollDeltaNorm * CONFIG.activity.headTiltWeight;
    weightSum += CONFIG.activity.headTiltWeight;
    movementRaw = movementRaw / weightSum;
    deviationRaw = deviationRaw / (weightSum - CONFIG.activity.headTiltWeight);

    const activityRaw = Math.max(movementRaw, deviationRaw);
    this.activityLevel = CONFIG.activity.alpha * activityRaw + (1 - CONFIG.activity.alpha) * this.activityLevel;
    this.prevRaw = { ...blendshapes };
    this.prevRoll = rollDeg;

    // ---- expressive state scores ----
    const sig = (n) => this.sig(n);
    const ec = this.exprCalibrator;
    const pBand = (state, term) => (ec ? ec.getPersonalBand(state, term) : null);

    // SHOCKED -- primary weighted path (personalized weights/bands if the
    // user completed the optional SURPRISE calibration, else exactly the
    // original default-weights/generic-band formula).
    const suddenNames = ["eyeWideLeft", "eyeWideRight", "jawOpen"];
    const suddenChange =
      avg(...suddenNames.map((n) => clamp01(((this.fastEma[n] ?? 0) - (this.slowEma[n] ?? 0)) / 0.15)));
    const shockedW = ec ? ec.getWeights(STATES.SHOCKED, cfg.SHOCKED.weights) : cfg.SHOCKED.weights;
    const eyeWideLeftSig = this.termSig("eyeWideLeft", pBand(STATES.SHOCKED, "eyeWideLeft"));
    const eyeWideRightSig = this.termSig("eyeWideRight", pBand(STATES.SHOCKED, "eyeWideRight"));
    const jawOpenSigShocked = this.termSig("jawOpen", pBand(STATES.SHOCKED, "jawOpen"));
    const browInnerUpSig = this.termSig("browInnerUp", pBand(STATES.SHOCKED, "browInnerUp"));
    const shockedScore =
      shockedW.eyeWideLeft * eyeWideLeftSig +
      shockedW.eyeWideRight * eyeWideRightSig +
      shockedW.jawOpen * jawOpenSigShocked +
      shockedW.browInnerUp * browInnerUpSig +
      shockedW.suddenChange * suddenChange;

    // SHOCKED -- alternate path: a meaningful brow raise alone is a strong,
    // reliable surprise tell even when eyeWide barely moves (common in
    // practice). Requiring a second supporting signal keeps solo jaw
    // movement (talking/chewing) from qualifying on its own. This runs
    // regardless of calibration -- it's a structural rule, not a threshold
    // tweak, and applies on top of whatever sig values were just computed
    // above (personalized or not).
    const altCfg = cfg.SHOCKED.altPath;
    const shockedAltSupport = Math.max(eyeWideLeftSig, eyeWideRightSig, jawOpenSigShocked, suddenChange);
    const shockedAltQualifies = browInnerUpSig >= altCfg.browThreshold && shockedAltSupport >= altCfg.supportThreshold;

    // HAPPY
    const happyW = ec ? ec.getWeights(STATES.HAPPY, cfg.HAPPY.weights) : cfg.HAPPY.weights;
    const smile = this.termSig("smile", pBand(STATES.HAPPY, "smile"));
    const cheekSquint = this.termSig("cheekSquint", pBand(STATES.HAPPY, "cheekSquint"));
    const laughBonus = smile > 0.3 ? sig("jawOpen") : 0;
    const happyScore = happyW.smile * smile + happyW.cheekSquint * cheekSquint + happyW.laughBonus * laughBonus;

    // TILTED
    const tiltedW = ec ? ec.getWeights(STATES.TILTED, cfg.TILTED.weights) : cfg.TILTED.weights;
    const browDown = this.termSig("browDown", pBand(STATES.TILTED, "browDown"));
    const eyeSquint = this.termSig("eyeSquint", pBand(STATES.TILTED, "eyeSquint"));
    const mouthPress = this.termSig("mouthPress", pBand(STATES.TILTED, "mouthPress"));
    const mouthFrown = this.termSig("mouthFrown", pBand(STATES.TILTED, "mouthFrown"));
    const tiltedScore =
      tiltedW.browDown * browDown + tiltedW.eyeSquint * eyeSquint + tiltedW.mouthPress * mouthPress + tiltedW.mouthFrown * mouthFrown;

    // CONFUSED (experimental)
    const browAsym = avg(
      Math.abs(sig("browDownLeft") - sig("browDownRight")),
      Math.abs(sig("browOuterUpLeft") - sig("browOuterUpRight"))
    );
    const eyeSquintAsym = Math.abs(sig("eyeSquintLeft") - sig("eyeSquintRight"));
    const mouthAsym = avg(
      Math.abs(sig("mouthSmileLeft") - sig("mouthSmileRight")),
      Math.abs(sig("mouthLowerDownLeft") - sig("mouthLowerDownRight"))
    );
    const headTiltSig = clamp01(Math.abs(rollDeg) / cfg.CONFUSED.headTiltMaxDeg);
    const confusedW = cfg.CONFUSED.weights;
    const confusedScore =
      confusedW.browAsymmetry * browAsym +
      confusedW.eyeSquintAsymmetry * eyeSquintAsym +
      confusedW.mouthAsymmetry * mouthAsym +
      confusedW.headTilt * headTiltSig;

    // ---- persistence gates for expressive states ----
    const shockedAboveEnter = shockedScore >= cfg.SHOCKED.enterThreshold || shockedAltQualifies;
    const shockedBelowExit = shockedScore < cfg.SHOCKED.exitThreshold && !shockedAltQualifies;
    this.gates[STATES.SHOCKED].update(now, shockedAboveEnter, shockedBelowExit);
    this.gates[STATES.HAPPY].update(now, happyScore >= cfg.HAPPY.enterThreshold, happyScore < cfg.HAPPY.exitThreshold);
    this.gates[STATES.TILTED].update(now, tiltedScore >= cfg.TILTED.enterThreshold, tiltedScore < cfg.TILTED.exitThreshold);
    this.gates[STATES.CONFUSED].update(now, confusedScore >= cfg.CONFUSED.enterThreshold, confusedScore < cfg.CONFUSED.exitThreshold);

    // ---- LOCKED_IN / DEAD_INSIDE temporal windows ----
    const li = cfg.LOCKED_IN;
    const di = cfg.DEAD_INSIDE;
    const eyesOpen = avg(this.fastEma.eyeBlinkLeft ?? 0, this.fastEma.eyeBlinkRight ?? 0) < li.eyeOpenMax;
    const mouthClosed = (this.fastEma.jawOpen ?? 0) < li.mouthClosedMax;
    const sessionEligible = this.sessionActiveMs >= CONFIG.session.lockedInEligibleAfterMs;

    const lowActivityOk = this.activityLevel < li.activityThreshold && eyesOpen && mouthClosed;
    if (lowActivityOk) {
      if (this.lowActivityStart === null) this.lowActivityStart = now;
    } else {
      this.lowActivityStart = null;
    }
    const lockedInDurationMet = this.lowActivityStart !== null && now - this.lowActivityStart >= li.minDurationMs;
    const lockedInReady = lockedInDurationMet && sessionEligible;

    const veryLowActivityOk = this.activityLevel < di.activityThreshold;
    if (veryLowActivityOk) {
      if (this.veryLowActivityStart === null) this.veryLowActivityStart = now;
    } else {
      this.veryLowActivityStart = null;
    }
    const deadInsideDurationMet = this.veryLowActivityStart !== null && now - this.veryLowActivityStart >= di.minDurationMs;
    const deadInsideReady = deadInsideDurationMet && sessionEligible;

    this.lockedInConfirmed = this._stickyBool(this.lockedInConfirmed, lockedInReady, "_lockedInGraceUntilFalse", now, 800);
    this.deadInsideConfirmed = this._stickyBool(this.deadInsideConfirmed, deadInsideReady, "_deadInsideGraceUntilFalse", now, 800);

    // ---- pick the active state by priority ----
    const confirmedMap = {
      [STATES.SHOCKED]: this.gates[STATES.SHOCKED].confirmed,
      [STATES.HAPPY]: this.gates[STATES.HAPPY].confirmed,
      [STATES.TILTED]: this.gates[STATES.TILTED].confirmed,
      [STATES.CONFUSED]: this.gates[STATES.CONFUSED].confirmed,
      [STATES.DEAD_INSIDE]: this.deadInsideConfirmed,
      [STATES.LOCKED_IN]: this.lockedInConfirmed,
      [STATES.NEUTRAL]: true,
    };

    // Confidence/NEUTRAL-suppression should reflect whichever path actually
    // qualifies -- if SHOCKED confirmed via the alt (brow-raise) path while
    // the primary weighted score stayed low, showing the low primary score
    // as "confidence" would be misleading.
    const shockedEffectiveScore = shockedAltQualifies
      ? Math.max(shockedScore, clamp01((browInnerUpSig + shockedAltSupport) / 2))
      : shockedScore;

    const scores = {
      [STATES.SHOCKED]: shockedEffectiveScore,
      [STATES.HAPPY]: happyScore,
      [STATES.TILTED]: tiltedScore,
      [STATES.CONFUSED]: confusedScore,
      [STATES.LOCKED_IN]: lockedInReady ? 1 : 0,
      [STATES.DEAD_INSIDE]: deadInsideReady ? 1 : 0,
      [STATES.NEUTRAL]: 1 - clamp01(Math.max(shockedEffectiveScore, happyScore, tiltedScore, confusedScore)),
    };

    // The CONFIRMED state (what actually gets displayed as the big state
    // text) -- unchanged logic, just renamed from the old `candidateState`
    // to stop conflating it with the real pending candidate below.
    let confirmedState = STATES.NEUTRAL;
    for (const name of STATE_PRIORITY) {
      if (name === STATES.NEUTRAL) continue;
      if (confirmedMap[name]) {
        confirmedState = name;
        break;
      }
    }

    if (confirmedState !== this.activeState) {
      this.activeState = confirmedState;
      this.activeSince = now;
    }

    // The real PENDING candidate: whatever is currently either mid-way
    // through accumulating enough evidence to confirm, or already confirmed
    // (so its duration keeps growing to reflect "how long has this been
    // true"). This is intentionally independent of `this.activeState` --
    // e.g. while TILTED is 1.2s into its required 2.0s, `state` still
    // correctly reads NEUTRAL (nothing confirmed yet) but `candidateState`
    // shows TILTED with its live progress, which is what the debug panel
    // needs for tuning.
    const pendingOrConfirmed = {
      [STATES.SHOCKED]: this.gates[STATES.SHOCKED].aboveSince !== null || this.gates[STATES.SHOCKED].confirmed,
      [STATES.HAPPY]: this.gates[STATES.HAPPY].aboveSince !== null || this.gates[STATES.HAPPY].confirmed,
      [STATES.TILTED]: this.gates[STATES.TILTED].aboveSince !== null || this.gates[STATES.TILTED].confirmed,
      [STATES.CONFUSED]: this.gates[STATES.CONFUSED].aboveSince !== null || this.gates[STATES.CONFUSED].confirmed,
      [STATES.DEAD_INSIDE]: this.veryLowActivityStart !== null || this.deadInsideConfirmed,
      [STATES.LOCKED_IN]: this.lowActivityStart !== null || this.lockedInConfirmed,
    };
    let candidateState = STATES.NEUTRAL;
    for (const name of STATE_PRIORITY) {
      if (name === STATES.NEUTRAL) continue;
      if (pendingOrConfirmed[name]) {
        candidateState = name;
        break;
      }
    }
    const candidateTargetByState = {
      [STATES.SHOCKED]: cfg.SHOCKED.minDurationMs,
      [STATES.HAPPY]: cfg.HAPPY.minDurationMs,
      [STATES.TILTED]: cfg.TILTED.minDurationMs,
      [STATES.CONFUSED]: cfg.CONFUSED.minDurationMs,
      [STATES.LOCKED_IN]: cfg.LOCKED_IN.minDurationMs,
      [STATES.DEAD_INSIDE]: cfg.DEAD_INSIDE.minDurationMs,
      [STATES.NEUTRAL]: 0,
    };
    let candidateDurationMs = 0;
    if (candidateState === STATES.LOCKED_IN) {
      candidateDurationMs = this.lowActivityStart ? now - this.lowActivityStart : 0;
    } else if (candidateState === STATES.DEAD_INSIDE) {
      candidateDurationMs = this.veryLowActivityStart ? now - this.veryLowActivityStart : 0;
    } else if (candidateState !== STATES.NEUTRAL) {
      candidateDurationMs = this.gates[candidateState].candidateDurationMs(now);
    }

    const breakdown = {
      SHOCKED: {
        score: shockedScore,
        eyeWideLeft: eyeWideLeftSig,
        eyeWideRight: eyeWideRightSig,
        jawOpen: jawOpenSigShocked,
        browInnerUp: browInnerUpSig,
        suddenChange,
        altQualifies: shockedAltQualifies,
        weights: shockedW,
      },
      HAPPY: { score: happyScore, smile, cheekSquint, laughBonus, weights: happyW },
      TILTED: { score: tiltedScore, browDown, eyeSquint, mouthPress, mouthFrown, weights: tiltedW },
      CONFUSED: { score: confusedScore, browAsym, eyeSquintAsym, mouthAsym, headTiltSig },
      LOCKED_IN: { ready: lockedInReady, lowActivityMs: this.lowActivityStart ? now - this.lowActivityStart : 0, eyesOpen, mouthClosed, sessionEligible },
      DEAD_INSIDE: { ready: deadInsideReady, veryLowActivityMs: this.veryLowActivityStart ? now - this.veryLowActivityStart : 0, sessionEligible },
    };

    return this._finalize(now, {
      present: true,
      breakdown,
      scores,
      activity: this.activityLevel,
      rollDeg,
      candidateState,
      candidateDurationMs,
      candidateTargetMs: candidateTargetByState[candidateState] ?? 0,
    });
  }

  _stickyBool(current, wantTrue, graceField, now, graceMs) {
    if (wantTrue) {
      this[graceField] = null;
      return true;
    }
    if (!current) return false;
    if (this[graceField] === null) this[graceField] = now;
    if (now - this[graceField] >= graceMs) {
      this[graceField] = null;
      return false;
    }
    return true;
  }

  _finalize(now, extra) {
    const confidence = this._confidenceFor(this.activeState, extra);
    return {
      state: this.activeState, // confirmed/displayed state
      confidence,
      activeDurationMs: now - this.activeSince,
      sessionActiveMs: this.sessionActiveMs,
      ...extra, // includes candidateState / candidateDurationMs / candidateTargetMs
    };
  }

  _confidenceFor(state, extra) {
    if (!extra.scores) return state === STATES.NEUTRAL ? 1 : 0;
    if (state === STATES.LOCKED_IN) {
      return clamp01(1 - this.activityLevel / CONFIG.states.LOCKED_IN.activityThreshold);
    }
    if (state === STATES.DEAD_INSIDE) {
      return clamp01(1 - this.activityLevel / CONFIG.states.DEAD_INSIDE.activityThreshold);
    }
    return clamp01(extra.scores[state] ?? 0);
  }
}
