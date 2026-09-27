// ============================================================================
// Central configuration: every tunable threshold/duration lives here.
// Nothing in stateEngine.js should hardcode a number that belongs here.
// ============================================================================

export const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";

export const WASM_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.21/wasm";

export const STATES = {
  NEUTRAL: "NEUTRAL",
  SHOCKED: "SHOCKED",
  HAPPY: "HAPPY",
  CONFUSED: "CONFUSED",
  TILTED: "TILTED",
  LOCKED_IN: "LOCKED_IN",
  DEAD_INSIDE: "DEAD_INSIDE",
};

// Order matters: first match wins when multiple states qualify simultaneously.
// A fast SHOCKED spike must be able to interrupt a slow LOCKED_IN/DEAD_INSIDE.
// NOTE: DEAD_INSIDE is ranked ABOVE LOCKED_IN even though the GDD-style spec
// listed LOCKED_IN first. Reason: DEAD_INSIDE's condition is strictly a
// longer/lower-activity superset of LOCKED_IN's condition, so by the time
// DEAD_INSIDE's evidence window is satisfied, LOCKED_IN's would already be
// true too -- with LOCKED_IN ranked higher, DEAD_INSIDE would never surface.
// Flip this array if you want the opposite behavior; nothing else depends on
// the order besides this list.
export const STATE_PRIORITY = [
  STATES.SHOCKED,
  STATES.HAPPY,
  STATES.TILTED,
  STATES.CONFUSED,
  STATES.DEAD_INSIDE,
  STATES.LOCKED_IN,
  STATES.NEUTRAL,
];

export const CONFIG = {
  // ---- inference pacing ----
  fps: {
    targetInferenceFps: 12, // aim for this many detectForVideo() calls/sec
    minInferenceFps: 6, // never throttle below this even if device is slow
    // if the rolling avg processing time per frame exceeds this fraction of
    // the frame budget, back off toward minInferenceFps.
    overloadFrameTimeRatio: 0.8,
  },

  // ---- signal smoothing ----
  smoothing: {
    fastAlpha: 0.55, // responsive EMA, used for "is this happening right now"
    slowAlpha: 0.06, // slow EMA, used as a rolling reference for "sudden change"
  },

  // ---- calibration ----
  calibration: {
    durationMs: 10000,
    minSamples: 30, // must collect at least this many valid frames
    // noise floor: even a blendshape with ~0 variance during calibration
    // gets at least this much "band" so tiny sensor jitter isn't flagged.
    minNoiseBand: {
      default: 0.05,
      eyeWideLeft: 0.04,
      eyeWideRight: 0.04,
      jawOpen: 0.05,
      browInnerUp: 0.06,
      mouthSmileLeft: 0.06,
      mouthSmileRight: 0.06,
    },
    // band = max(minNoiseBand, std * bandStdMultiplier)
    bandStdMultiplier: 2.5,
  },

  // ---- session-level gating ----
  session: {
    // LOCKED_IN must not fire just because calibration left you stable.
    // Require this much active (post-calibration) time before it's eligible.
    lockedInEligibleAfterMs: 15000,
  },

  // ---- activity/variance tracking (feeds LOCKED_IN / DEAD_INSIDE) ----
  activity: {
    // EMA alpha for the "how much is the face moving" meter
    alpha: 0.15,
    // blendshapes sampled for the activity meter, and their weights
    weights: {
      eyeBlinkLeft: 1.0,
      eyeBlinkRight: 1.0,
      jawOpen: 1.2,
      mouthSmileLeft: 1.0,
      mouthSmileRight: 1.0,
      browDownLeft: 0.8,
      browDownRight: 0.8,
      browInnerUp: 0.8,
      eyeSquintLeft: 0.6,
      eyeSquintRight: 0.6,
    },
    headTiltWeight: 1.5, // extra weight for head-rotation delta (radians)
  },

  states: {
    SHOCKED: {
      enterThreshold: 0.5,
      exitThreshold: 0.28,
      minDurationMs: 350, // fast to enter (spec: ~300-800ms)
      exitGraceMs: 250, // and quick to decay
      weights: {
        eyeWideLeft: 0.22,
        eyeWideRight: 0.22,
        jawOpen: 0.2,
        browInnerUp: 0.16,
        suddenChange: 0.2, // fast-EMA vs slow-EMA jump on eyeWide/jawOpen
      },
      // Real-world observation: many people's eyeWide blendshape barely
      // moves even on a genuine surprised reaction, while browInnerUp
      // (eyebrow raise) is a much more reliable "surprise" tell. This is a
      // second, independent qualifying path (OR'd with the primary weighted
      // score above): a meaningful brow raise PLUS at least one supporting
      // change (eye widen, jaw drop, or a sudden-change spike) also counts
      // as SHOCKED. Requiring the second signal keeps this from firing on
      // solo jaw movement (talking/chewing) alone.
      altPath: {
        browThreshold: 0.6,
        supportThreshold: 0.3,
      },
    },

    HAPPY: {
      enterThreshold: 0.45,
      exitThreshold: 0.3,
      minDurationMs: 900, // spec: ~700-1200ms
      exitGraceMs: 500,
      weights: {
        smile: 0.55, // avg(mouthSmileLeft, mouthSmileRight)
        cheekSquint: 0.25,
        laughBonus: 0.2, // jawOpen, only counted when smile is already present
      },
    },

    TILTED: {
      // conservative: false positives worse than misses
      enterThreshold: 0.6,
      exitThreshold: 0.4,
      minDurationMs: 2000, // spec: ~1.5-2.5s
      exitGraceMs: 800,
      weights: {
        browDown: 0.3, // avg(browDownLeft, browDownRight)
        eyeSquint: 0.25,
        mouthPress: 0.25,
        mouthFrown: 0.2,
      },
    },

    CONFUSED: {
      // experimental: require strong sustained evidence or fall to NEUTRAL
      enterThreshold: 0.55,
      exitThreshold: 0.35,
      minDurationMs: 1500, // spec: ~1-2s
      exitGraceMs: 600,
      weights: {
        browAsymmetry: 0.3,
        eyeSquintAsymmetry: 0.25,
        mouthAsymmetry: 0.2,
        headTilt: 0.25, // abs head roll angle
      },
      headTiltMaxDeg: 14, // angle (deg) that maxes out the headTilt signal
    },

    LOCKED_IN: {
      minDurationMs: 5000, // spec: ~4-6s
      activityThreshold: 0.14, // activity meter must stay below this
      eyeOpenMax: 0.35, // eyeBlink signal must stay below this (eyes open)
      mouthClosedMax: 0.35, // jawOpen signal must stay below this
    },

    DEAD_INSIDE: {
      minDurationMs: 8500, // spec: ~7-10s, and must exceed LOCKED_IN's window
      activityThreshold: 0.06, // stricter (lower) than LOCKED_IN's
    },
  },
};

// ============================================================================
// Optional personal expression calibration (SHOCKED/HAPPY/TILTED only).
//
// This is an OPT-IN layer on top of everything above. When the user skips it
// (or a given profile), that state's scoring uses the exact default weights
// and generic neutral-noise banding from CONFIG.states -- nothing here
// changes unless the user explicitly records a profile. See
// expressionCalibration.js for how these are applied.
// ============================================================================

// Maps a state's per-signal "term" (as used in that state's `weights` object)
// to the raw MediaPipe blendshape category name(s) that make it up. A term
// with two names is the avg(left, right) pattern already used in
// stateEngine.js scoring.
export const TERM_SIGNALS = {
  eyeWideLeft: ["eyeWideLeft"],
  eyeWideRight: ["eyeWideRight"],
  jawOpen: ["jawOpen"],
  browInnerUp: ["browInnerUp"],
  smile: ["mouthSmileLeft", "mouthSmileRight"],
  cheekSquint: ["cheekSquintLeft", "cheekSquintRight"],
  browDown: ["browDownLeft", "browDownRight"],
  eyeSquint: ["eyeSquintLeft", "eyeSquintRight"],
  mouthPress: ["mouthPressLeft", "mouthPressRight"],
  mouthFrown: ["mouthFrownLeft", "mouthFrownRight"],
};

// Which terms each optional calibration profile samples, and which state it
// personalizes. Deliberately only 3 profiles (matching "natural
// smile/surprise/frown") -- CONFUSED has no calibration profile and always
// uses its default (asymmetry-based) scoring, since asymmetry isn't
// something a single posed expression can usefully calibrate.
export const EXPRESSION_PROFILES = {
  SURPRISE: {
    state: STATES.SHOCKED,
    terms: ["eyeWideLeft", "eyeWideRight", "jawOpen", "browInnerUp"],
    label: "a natural SURPRISED face",
  },
  SMILE: {
    state: STATES.HAPPY,
    terms: ["smile", "cheekSquint"],
    label: "a natural SMILE",
  },
  FROWN: {
    state: STATES.TILTED,
    terms: ["browDown", "eyeSquint", "mouthPress", "mouthFrown"],
    label: "a natural FROWN / tense face",
  },
};

export const STATE_TO_PROFILE = Object.fromEntries(
  Object.entries(EXPRESSION_PROFILES).map(([profile, def]) => [def.state, profile])
);

export const EXPRESSION_CALIBRATION = {
  durationMs: 2500, // shorter than neutral's 10s -- holding an intense
  // expression for a full 10s is unnatural and tiring.
  minSamples: 15,

  // A calibration burst is REJECTED (not silently accepted as a weak
  // expression) unless at least one of its terms separates from the
  // person's neutral baseline by at least this fraction of the generic
  // "expected" band for that term. Below this, we genuinely can't tell the
  // attempt apart from their resting face.
  rejectSalienceThreshold: 0.5,

  // Personalized banding: sig() reaches 1.0 once the live signal reaches
  // this fraction of the person's OWN calibrated peak amplitude for that
  // term, floored by the generic neutral noise band. This cannot amplify
  // noise by shrinking the neutral band; recognition gains come from weights.
  bandMargin: 0.8,

  // Weight redistribution: within a calibrated profile's covered terms,
  // weight shifts toward whichever term(s) that specific person showed the
  // most separation on (relative to their own strongest term), and away
  // from ones they barely moved -- while the total weight budget for that
  // subset of terms is conserved exactly, so the enter/exit thresholds stay
  // meaningful. minRetention keeps every covered term at least partially
  // alive so one noisy calibration burst can't permanently zero a channel.
  reweight: {
    minRetention: 0.15,
    salienceCap: 3,
  },
};
