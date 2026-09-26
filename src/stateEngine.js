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

import { CONFIG, STATES, STATE_PRIORITY } from "./config.js";

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
  constructor(baseline) {
    this.baseline = baseline;
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
    this.sessionStartAt = performance.now();
    this.sessionPausedAccum = 0;
  }

  pause() {
    this._pauseStartedAt = performance.now();
  }

  resume() {
    if (this._pauseStartedAt) {
      this.sessionPausedAccum += performance.now() - this._pauseStartedAt;
      this._pauseStartedAt = null;
    }
  }

  get sessionActiveMs() {
    if (!this.sessionStartAt) return 0;
    return performance.now() - this.sessionStartAt - this.sessionPausedAccum;
  }

  reset() {
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

  raw(name, blendshapes) {
    return blendshapes[name] ?? 0;
  }

  sig(name) {
    return this.baseline.significance(name, this.fastEma[name] ?? 0);
  }

  update({ present, blendshapes, headAngles }) {
    const now = performance.now();
    const cfg = CONFIG.states;

    if (!present) {
      // No face: don't accumulate bogus evidence, and don't let a brief
      // dropout count as "stillness" toward LOCKED_IN/DEAD_INSIDE.
      this.lowActivityStart = null;
      this.veryLowActivityStart = null;
      return this._finalize(now, { present: false, breakdown: {}, activity: this.activityLevel });
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

    // SHOCKED
    const suddenNames = ["eyeWideLeft", "eyeWideRight", "jawOpen"];
    const suddenChange =
      avg(...suddenNames.map((n) => clamp01(((this.fastEma[n] ?? 0) - (this.slowEma[n] ?? 0)) / 0.15)));
    const shockedW = cfg.SHOCKED.weights;
    const shockedScore =
      shockedW.eyeWideLeft * sig("eyeWideLeft") +
      shockedW.eyeWideRight * sig("eyeWideRight") +
      shockedW.jawOpen * sig("jawOpen") +
      shockedW.browInnerUp * sig("browInnerUp") +
      shockedW.suddenChange * suddenChange;

    // HAPPY
    const smile = avg(sig("mouthSmileLeft"), sig("mouthSmileRight"));
    const cheekSquint = avg(sig("cheekSquintLeft"), sig("cheekSquintRight"));
    const laughBonus = smile > 0.3 ? sig("jawOpen") : 0;
    const happyW = cfg.HAPPY.weights;
    const happyScore = happyW.smile * smile + happyW.cheekSquint * cheekSquint + happyW.laughBonus * laughBonus;

    // TILTED
    const browDown = avg(sig("browDownLeft"), sig("browDownRight"));
    const eyeSquint = avg(sig("eyeSquintLeft"), sig("eyeSquintRight"));
    const mouthPress = avg(sig("mouthPressLeft"), sig("mouthPressRight"));
    const mouthFrown = avg(sig("mouthFrownLeft"), sig("mouthFrownRight"));
    const tiltedW = cfg.TILTED.weights;
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
    this.gates[STATES.SHOCKED].update(now, shockedScore >= cfg.SHOCKED.enterThreshold, shockedScore < cfg.SHOCKED.exitThreshold);
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

    const scores = {
      [STATES.SHOCKED]: shockedScore,
      [STATES.HAPPY]: happyScore,
      [STATES.TILTED]: tiltedScore,
      [STATES.CONFUSED]: confusedScore,
      [STATES.LOCKED_IN]: lockedInReady ? 1 : 0,
      [STATES.DEAD_INSIDE]: deadInsideReady ? 1 : 0,
      [STATES.NEUTRAL]: 1 - clamp01(Math.max(shockedScore, happyScore, tiltedScore, confusedScore)),
    };

    let candidateState = STATES.NEUTRAL;
    for (const name of STATE_PRIORITY) {
      if (name === STATES.NEUTRAL) continue;
      if (confirmedMap[name]) {
        candidateState = name;
        break;
      }
    }

    if (candidateState !== this.activeState) {
      this.activeState = candidateState;
      this.activeSince = now;
    }

    const breakdown = {
      SHOCKED: { score: shockedScore, eyeWideLeft: sig("eyeWideLeft"), eyeWideRight: sig("eyeWideRight"), jawOpen: sig("jawOpen"), browInnerUp: sig("browInnerUp"), suddenChange },
      HAPPY: { score: happyScore, smile, cheekSquint, laughBonus },
      TILTED: { score: tiltedScore, browDown, eyeSquint, mouthPress, mouthFrown },
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
      candidateDurations: Object.fromEntries(
        Object.entries(this.gates).map(([k, g]) => [k, g.candidateDurationMs(now)])
      ),
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
      state: this.activeState,
      confidence,
      candidate: extra.present === false ? STATES.NEUTRAL : this.activeState,
      activeDurationMs: now - this.activeSince,
      sessionActiveMs: this.sessionActiveMs,
      ...extra,
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
