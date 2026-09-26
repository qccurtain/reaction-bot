// ============================================================================
// App glue: wires camera + faceTracker + baseline + stateEngine + ui together.
// No frame ever leaves this device: the video element feeds the on-device
// WASM model directly, and only numeric blendshape scores (never pixels)
// flow into the rest of the app.
// ============================================================================

import { startFrontCamera, stopCamera } from "./camera.js";
import { initFaceLandmarker, startDetectionLoop, stopDetectionLoop } from "./faceTracker.js";
import { BaselineCollector } from "./baseline.js";
import { StateEngine } from "./stateEngine.js";
import * as ui from "./ui.js";

const baseline = new BaselineCollector();
const stateEngine = new StateEngine(baseline);

let appState = "idle"; // idle | starting | calibrating | running | paused
let lastFrameTs = null;
let lastBreakdown = {};

function beginCalibration() {
  appState = "calibrating";
  baseline.start();
  lastFrameTs = null;
  ui.setStatus("Calibrating…");
  ui.setCalibrationText("Calibrating neutral face… 0% — hold a normal, relaxed expression");
  ui.setStateDisplay("CALIBRATING", null);
  ui.setButtons({ started: true, calibrating: true, paused: false });
}

function onDetectionResult(payload) {
  ui.setFacePresent(payload.present);

  if (appState === "calibrating") {
    if (payload.present) {
      const done = baseline.addSample(payload.blendshapes);
      ui.setCalibrationText(`Calibrating neutral face… ${Math.round(baseline.progress * 100)}%`);
      if (done) {
        appState = "running";
        stateEngine.beginSession();
        ui.setCalibrationText("");
        ui.setStatus("Running");
        ui.setButtons({ started: true, calibrating: false, paused: false });
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
  stateEngine.reset();
  beginCalibration();
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
  appState = "running";
  stateEngine.resume();
  startDetectionLoop(ui.dom.video, onDetectionResult);
  ui.setStatus("Running");
  ui.setButtons({ started: true, calibrating: false, paused: false });
}

function onReset() {
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

ui.onButtons({ onStart, onRecalibrate, onPause, onResume, onReset, onToggleDebug, onInspect });
ui.setInspectState("SHOCKED");
ui.setButtons({ started: false, calibrating: false, paused: false });

window.addEventListener("beforeunload", () => {
  stopDetectionLoop();
  stopCamera();
});
