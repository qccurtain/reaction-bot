// ============================================================================
// Wraps MediaPipe Tasks Vision FaceLandmarker. Loaded from jsDelivr (CDN,
// $0 cost) at a pinned version so behavior doesn't drift under us.
// Runs entirely in the phone's browser via WASM -- no network calls happen
// per-frame, only the one-time model/wasm download on page load (cached by
// the browser afterwards).
// ============================================================================

import { FilesetResolver, FaceLandmarker } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.21";
import { MODEL_URL, WASM_URL, CONFIG } from "./config.js";

let landmarker = null;
let lastVideoTime = -1;
let rafHandle = null;
let lastInferenceAt = 0;
let inferenceIntervalMs = 1000 / CONFIG.fps.targetInferenceFps;

// rolling stats for adaptive throttling + debug FPS readout
const frameTimes = [];
let fpsCounterFrames = 0;
let fpsCounterStart = performance.now();
let lastMeasuredFps = 0;

export async function initFaceLandmarker(onProgress) {
  onProgress?.("Loading vision runtime…");
  const vision = await FilesetResolver.forVisionTasks(WASM_URL);

  onProgress?.("Loading face model…");
  landmarker = await FaceLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath: MODEL_URL,
      delegate: "GPU",
    },
    runningMode: "VIDEO",
    numFaces: 1,
    outputFaceBlendshapes: true,
    outputFacialTransformationMatrixes: true,
    minFaceDetectionConfidence: 0.5,
    minFacePresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  }).catch(async (err) => {
    // GPU delegate isn't available on every mobile browser; fall back to CPU.
    console.warn("GPU delegate failed, retrying with CPU:", err);
    return FaceLandmarker.createFromOptions(vision, {
      baseOptions: { modelAssetPath: MODEL_URL, delegate: "CPU" },
      runningMode: "VIDEO",
      numFaces: 1,
      outputFaceBlendshapes: true,
      outputFacialTransformationMatrixes: true,
      minFaceDetectionConfidence: 0.5,
      minFacePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });
  });

  onProgress?.("Model ready");
  return landmarker;
}

// Extract an approximate head roll/pitch/yaw (radians) from the 4x4
// facial transformation matrix. Column-major, standard MediaPipe convention.
// This is a rough decomposition -- good enough for a "head tilt" signal, not
// a precise pose estimate.
function extractHeadAngles(matrix) {
  if (!matrix || matrix.length < 16) return { roll: 0, pitch: 0, yaw: 0 };
  const m = matrix; // column-major: m[col*4+row]
  const m00 = m[0], m10 = m[1], m20 = m[2];
  const m01 = m[4], m11 = m[5], m21 = m[6];
  const m02 = m[8], m12 = m[9], m22 = m[10];

  const yaw = Math.atan2(-m20, Math.sqrt(m21 * m21 + m22 * m22));
  const pitch = Math.atan2(m21, m22);
  const roll = Math.atan2(m10, m00);
  return { roll, pitch, yaw };
}

function blendshapesToMap(result) {
  const map = {};
  const categories = result?.faceBlendshapes?.[0]?.categories;
  if (!categories) return map;
  for (const c of categories) map[c.categoryName] = c.score;
  return map;
}

/**
 * Starts a throttled detection loop against the given <video> element.
 * `onResult(payload)` is called once per successful inference with:
 *   { present, blendshapes, headAngles, timestamp, fps }
 * Detection is paced to ~targetInferenceFps and backs off automatically if
 * the device is too slow (adaptive, phone-battery-friendly).
 */
export function startDetectionLoop(videoEl, onResult) {
  stopDetectionLoop();

  function loop() {
    rafHandle = requestAnimationFrame(loop);
    const now = performance.now();
    if (now - lastInferenceAt < inferenceIntervalMs) return;
    if (videoEl.currentTime === lastVideoTime) return;
    if (videoEl.readyState < 2) return;

    lastVideoTime = videoEl.currentTime;
    const t0 = performance.now();
    lastInferenceAt = t0;

    let result;
    try {
      result = landmarker.detectForVideo(videoEl, t0);
    } catch (err) {
      console.error("detectForVideo failed:", err);
      return;
    }
    const elapsed = performance.now() - t0;

    // adaptive throttling: if inference is chewing through most of the
    // frame budget, back off toward the min FPS to protect battery/thermals.
    frameTimes.push(elapsed);
    if (frameTimes.length > 20) frameTimes.shift();
    const avg = frameTimes.reduce((a, b) => a + b, 0) / frameTimes.length;
    const budget = 1000 / CONFIG.fps.targetInferenceFps;
    if (avg > budget * CONFIG.fps.overloadFrameTimeRatio) {
      inferenceIntervalMs = Math.min(1000 / CONFIG.fps.minInferenceFps, inferenceIntervalMs * 1.15);
    } else if (inferenceIntervalMs > 1000 / CONFIG.fps.targetInferenceFps) {
      inferenceIntervalMs = Math.max(1000 / CONFIG.fps.targetInferenceFps, inferenceIntervalMs * 0.95);
    }

    fpsCounterFrames++;
    const sinceFpsStart = now - fpsCounterStart;
    if (sinceFpsStart >= 1000) {
      lastMeasuredFps = (fpsCounterFrames * 1000) / sinceFpsStart;
      fpsCounterFrames = 0;
      fpsCounterStart = now;
    }

    const present = (result?.faceBlendshapes?.length ?? 0) > 0;
    const blendshapes = blendshapesToMap(result);
    const matrix = result?.facialTransformationMatrixes?.[0]?.data;
    const headAngles = extractHeadAngles(matrix);

    onResult({
      present,
      blendshapes,
      headAngles,
      timestamp: t0,
      fps: lastMeasuredFps,
      processMs: elapsed,
    });
  }

  rafHandle = requestAnimationFrame(loop);
}

export function stopDetectionLoop() {
  if (rafHandle) cancelAnimationFrame(rafHandle);
  rafHandle = null;
  lastVideoTime = -1;
}
