// ============================================================================
// App glue: wires camera + faceTracker + baseline + expressionCalibration +
// stateEngine + ui together. No frame ever leaves this device: the video
// element feeds the on-device WASM model directly, and only numeric
// blendshape scores (never pixels) flow into the rest of the app.
// ============================================================================

import { startFrontCamera, stopCamera } from "./camera.js";
import { initFaceLandmarker, startDetectionLoop, stopDetectionLoop } from "./faceTracker.js";
import { BaselineCollector } from "./baseline.js";
import { ExpressionCalibrator } from "./expressionCalibration.js";
import { StateEngine } from "./stateEngine.js";
import { EXPRESSION_PROFILES } from "./config.js";
import * as ui from "./ui.js";

const baseline = new BaselineCollector();
const exprCalibrator = new ExpressionCalibrator(baseline);
const stateEngine = new StateEngine(baseline, exprCalibrator);

const EXPR_QUEUE = Object.keys(EXPRESSION_PROFILES); // ["SURPRISE", "SMILE", "FROWN"]

// appState: idle | starting | calibrating | expr_offer | expr_capturing |
//           expr_rejected | running | paused
let appState = "idle";
let lastFrameTs = null;
let lastBreakdown = {};

// ---- optional expression-calibration flow state ----
let exprIndex = 0;
let currentBurst = null;
let lastExprFrameTs = null;

function leaveRunning() {
  stateEngine.pause();
}

function enterRunning() {
  appState = "running";
  stateEngine.freezeGates(); // never let a calibration/pause gap false-confirm on resume
  stateEngine.resume();
  ui.hideExprFlow();
  ui.setCalibrationText("");
  ui.setStatus("Running");
  ui.setButtons({ started: true, calibrating: false, paused: false });
}

function beginCalibration() {
  appState = "calibrating";
  baseline.start();
  lastFrameTs = null;
  ui.hideExprFlow();
  ui.setStatus("Calibrating…");
  ui.setCalibrationText("Calibrating neutral face… 0% — hold a normal, relaxed expression");
  ui.setStateDisplay("CALIBRATING", null);
  ui.setButtons({ started: true, calibrating: true, paused: false });
}

function offerExpressionCalibration() {
  appState = "expr_offer";
  ui.setStatus("Optional personalization");
  ui.setCalibrationText("");
  ui.showExprFlow({
    text:
      "Optional: personalize SHOCKED / HAPPY / TILTED detection using a few of your own expressions? " +
      "Takes about 15 seconds. This never leaves your session — nothing is uploaded or saved after you close the page.",
    buttons: [{ label: "Start Personalizing" }, { label: "Skip" }],
  });
}

function prepareExprCapture() {
  appState = "expr_ready";
  ui.setButtons({ started: true, calibrating: true, paused: false });
  const profile = EXPRESSION_PROFILES[EXPR_QUEUE[exprIndex]];
  ui.showExprFlow({
    text: `(${exprIndex + 1}/${EXPR_QUEUE.length}) Relax first, then make ${profile.label}. Tap Record when ready.`,
    buttons: [{ label: "Record" }, { label: "Skip this one" }, { label: "Cancel remaining" }],
  });
}

function startExprCapture() {
  ui.setButtons({ started: true, calibrating: true, paused: false });
  appState = "expr_capturing";
  const profileName = EXPR_QUEUE[exprIndex];
  currentBurst = exprCalibrator.createBurstCollector();
  currentBurst.start();
  lastExprFrameTs = null;
  renderExprProgress(profileName, 0);
}

function renderExprProgress(profileName, pct) {
  const profile = EXPRESSION_PROFILES[profileName];
  ui.showExprFlow({
    text: `(${exprIndex + 1}/${EXPR_QUEUE.length}) Make ${profile.label} and hold it… ${Math.round(pct * 100)}%`,
    buttons: [undefined, undefined, { label: "Cancel" }],
  });
}

function advanceExprQueue() {
  exprIndex++;
  if (exprIndex >= EXPR_QUEUE.length) {
    finishExpressionFlow();
  } else {
    prepareExprCapture();
  }
}

function finishExpressionFlow() {
  currentBurst = null;
  enterRunning();
}

function handleExprBurstDone(profileName) {
  const evalResult = exprCalibrator.evaluateBurst(profileName, currentBurst);
  currentBurst = null;
  if (evalResult.accepted) {
    exprCalibrator.commit(evalResult);
    appState = "expr_capturing"; // brief confirmation, still non-interactive
    const profile = EXPRESSION_PROFILES[profileName];
    ui.showExprFlow({ text: `Got it — ${profile.label} calibrated. ✓`, buttons: [] });
    setTimeout(advanceExprQueue, 900);
  } else {
    appState = "expr_rejected";
    const profile = EXPRESSION_PROFILES[profileName];
    ui.showExprFlow({
      text: `That sample did not show clear ${profileName === 'SMILE' ? 'mouth-corner lift' : profileName === 'FROWN' ? 'brow or lip tension beyond squinting' : 'surprise signals'}. Relax, then retry naturally, or skip this one.`,
      buttons: [{ label: "Retry" }, { label: "Skip this one" }, { label: "Cancel remaining" }],
    });
  }
}

function onDetectionResult(payload) {
  ui.setFacePresent(payload.present);

  if (appState === "calibrating") {
    if (payload.present) {
      const done = baseline.addSample(payload.blendshapes);
      ui.setCalibrationText(`Calibrating neutral face… ${Math.round(baseline.progress * 100)}%`);
      if (done) {
        // A fresh neutral baseline invalidates any previously-calibrated
        // expression profiles (they were measured relative to the OLD
        // baseline's mean) -- clear them and let the user optionally redo it.
        exprCalibrator.clearAll();
        stateEngine.beginSession();
        stateEngine.pause(); // resumed once the (optional) offer flow ends
        exprIndex = 0;
        offerExpressionCalibration();
      }
    } else {
      // Face missing mid-calibration: pause the clock instead of recording
      // garbage samples, so the 10s only counts *valid* neutral-face time.
      if (lastFrameTs != null) baseline.pauseFor(payload.timestamp - lastFrameTs);
      ui.setCalibrationText("Face not detected — center your face in frame");
    }
    lastFrameTs = payload.timestamp;
    return;
  }

  if (appState === "expr_capturing" && currentBurst) {
    const profileName = EXPR_QUEUE[exprIndex];
    if (payload.present) {
      const done = currentBurst.addSample(payload.blendshapes);
      if (done) {
        handleExprBurstDone(profileName);
      } else {
        renderExprProgress(profileName, currentBurst.progress);
      }
    } else {
      if (lastExprFrameTs != null) currentBurst.pauseFor(payload.timestamp - lastExprFrameTs);
      ui.showExprFlow({
        text: `Face not detected — center your face in frame to keep calibrating.`,
        buttons: [undefined, undefined, { label: "Cancel" }],
      });
    }
    lastExprFrameTs = payload.timestamp;
    return;
  }

  if (appState === "expr_offer" || appState === "expr_rejected") {
    return; // waiting on a button click; camera preview stays live
  }

  if (appState === "running") {
    const result = stateEngine.update(payload);
    lastBreakdown = result.breakdown ?? lastBreakdown;
    ui.setStateDisplay(result.state, result.confidence);
    ui.renderDebug({
      ...result,
      fps: payload.fps,
      fastEma: stateEngine.fastEma,
      rollDeg: result.rollDeg,
    });
    ui.renderInspect(lastBreakdown);
  }
}

let startAttempt = 0;

async function onStart() {
  const attempt = ++startAttempt;
  try {
    appState = "starting";
    ui.setStatus("Requesting camera…");
    ui.dom.btnStart.disabled = true;

    // Camera permission and the (slower) model download happen in parallel,
    // but if the camera prompt is denied quickly, ignore late progress
    // messages from the still-loading model so they don't clobber the error.
    const guardedProgress = (msg) => {
      if (attempt === startAttempt && appState === "starting") ui.setStatus(msg);
    };

    await Promise.all([startFrontCamera(ui.dom.video), initFaceLandmarker(guardedProgress)]);
    if (attempt !== startAttempt) return; // a newer attempt superseded this one

    ui.setStatus("Camera ready");
    startDetectionLoop(ui.dom.video, onDetectionResult);
    beginCalibration();
  } catch (err) {
    if (attempt !== startAttempt) return;
    console.error(err);
    ui.setStatus("Error: " + (err?.message ?? "could not start camera"));
    ui.dom.btnStart.disabled = false;
    appState = "idle";
  }
}

function onRecalibrate() {
  if (appState !== "running") return;
  leaveRunning();
  stateEngine.reset();
  beginCalibration();
}

function onPersonalize() {
  if (appState !== "running") return;
  leaveRunning();
  exprCalibrator.clearAll();
  exprIndex = 0;
  prepareExprCapture();
}

function onPause() {
  if (appState !== "running") return;
  appState = "paused";
  stopDetectionLoop();
  stateEngine.pause();
  ui.setStatus("Paused");
  ui.setButtons({ started: true, calibrating: false, paused: true });
}

function onResume() {
  if (appState !== "paused") return;
  startDetectionLoop(ui.dom.video, onDetectionResult);
  enterRunning();
}

function onReset() {
  if (appState !== "running" && appState !== "paused") return;
  stateEngine.reset();
  ui.setStateDisplay("NEUTRAL", null);
}

function onToggleDebug() {
  ui.toggleDebugPanel();
}

function onInspect(stateName) {
  ui.setInspectState(stateName);
  ui.renderInspect(lastBreakdown);
}

// Generic handler for the 3-button expression-flow panel; which action each
// slot performs depends on the current sub-state (offer vs capturing vs
// rejected), matching whatever showExprFlow() most recently rendered there.
function onExprButton(slot) {
  if (appState === "expr_ready") {
    if (slot === "A") startExprCapture();
    else if (slot === "B") advanceExprQueue();
    else if (slot === "C") finishExpressionFlow();
    return;
  }
  if (appState === "expr_offer") {
    if (slot === "A") {
      prepareExprCapture();
    } else if (slot === "B") {
      finishExpressionFlow(); // skip all
    }
    return;
  }
  if (appState === "expr_capturing") {
    if (slot === "C") {
      currentBurst = null;
      finishExpressionFlow(); // cancel mid-burst, keep whatever was already accepted
    }
    return;
  }
  if (appState === "expr_rejected") {
    if (slot === "A") {
      prepareExprCapture(); // retry this profile
    } else if (slot === "B") {
      advanceExprQueue(); // skip just this one
    } else if (slot === "C") {
      finishExpressionFlow(); // cancel remaining, keep what's already accepted
    }
  }
}

ui.onButtons({ onStart, onRecalibrate, onPersonalize, onPause, onResume, onReset, onToggleDebug, onInspect, onExprButton });
ui.setInspectState("SHOCKED");
ui.setButtons({ started: false, calibrating: false, paused: false });

window.addEventListener("beforeunload", () => {
  stopDetectionLoop();
  stopCamera();
});
