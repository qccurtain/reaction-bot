// ============================================================================
// Pure DOM glue. No business logic lives here -- it just renders whatever
// main.js hands it and reports user interactions back via callbacks.
// ============================================================================

const el = (id) => document.getElementById(id);

export const dom = {
  video: el("video"),
  faceDot: el("faceDot"),
  statusBadge: el("statusBadge"),
  stateText: el("stateText"),
  confidenceText: el("confidenceText"),
  calibrationText: el("calibrationText"),
  btnStart: el("btnStart"),
  btnRecalibrate: el("btnRecalibrate"),
  btnPause: el("btnPause"),
  btnResume: el("btnResume"),
  btnDebug: el("btnDebug"),
  btnReset: el("btnReset"),
  debugPanel: el("debugPanel"),
  dbgFps: el("dbgFps"),
  dbgFace: el("dbgFace"),
  dbgCandidate: el("dbgCandidate"),
  dbgCandidateDur: el("dbgCandidateDur"),
  dbgActiveDur: el("dbgActiveDur"),
  dbgSession: el("dbgSession"),
  dbgActivity: el("dbgActivity"),
  dbgRoll: el("dbgRoll"),
  dbgBlendshapes: el("dbgBlendshapes"),
  dbgInspectTitle: el("dbgInspectTitle"),
  dbgInspect: el("dbgInspect"),
  stateChips: document.querySelectorAll(".chip"),
};

const STATE_CLASS_PREFIX = "state-";

export function setStatus(text) {
  dom.statusBadge.textContent = text;
}

export function setFacePresent(present) {
  dom.faceDot.classList.toggle("present", !!present);
}

export function setCalibrationText(text) {
  dom.calibrationText.textContent = text;
}

export function setStateDisplay(stateName, confidence) {
  dom.stateText.textContent = stateName;
  dom.stateText.className = "state-text " + STATE_CLASS_PREFIX + stateName;
  dom.confidenceText.textContent =
    confidence == null ? "Confidence: --" : `Confidence: ${Math.round(confidence * 100)}%`;
}

export function setButtons({ started, calibrating, paused }) {
  dom.btnStart.disabled = started;
  dom.btnStart.textContent = started ? "Camera Running" : "Start Camera";
  dom.btnRecalibrate.disabled = !started || calibrating;
  dom.btnPause.hidden = paused;
  dom.btnPause.disabled = !started || calibrating;
  dom.btnResume.hidden = !paused;
  dom.btnResume.disabled = !started;
  dom.btnReset.disabled = !started;
}

export function toggleDebugPanel(forceShow) {
  const show = forceShow ?? dom.debugPanel.hidden;
  dom.debugPanel.hidden = !show;
  dom.btnDebug.textContent = show ? "Hide Debug" : "Show Debug";
  return show;
}

function fmtMs(ms) {
  return `${(ms / 1000).toFixed(1)}s`;
}

const BLENDSHAPE_DEBUG_KEYS = [
  ["eyeWideLeft", "eyeWide L"],
  ["eyeWideRight", "eyeWide R"],
  ["jawOpen", "jawOpen"],
  ["mouthSmileLeft", "smile L"],
  ["mouthSmileRight", "smile R"],
  ["browDownLeft", "browDown L"],
  ["browDownRight", "browDown R"],
  ["browInnerUp", "browInnerUp"],
  ["eyeSquintLeft", "eyeSquint L"],
  ["eyeSquintRight", "eyeSquint R"],
  ["mouthPressLeft", "mouthPress L"],
  ["mouthPressRight", "mouthPress R"],
  ["mouthFrownLeft", "mouthFrown L"],
  ["mouthFrownRight", "mouthFrown R"],
  ["cheekSquintLeft", "cheekSquint L"],
  ["cheekSquintRight", "cheekSquint R"],
];

export function renderDebug(result) {
  dom.dbgFps.textContent = result.fps ? result.fps.toFixed(1) : "--";
  dom.dbgFace.textContent = result.present ? "yes" : "no";
  dom.dbgCandidate.textContent = result.candidate ?? "--";
  const cand = result.candidateDurations?.[result.state];
  dom.dbgCandidateDur.textContent = cand != null ? fmtMs(cand) : "--";
  dom.dbgActiveDur.textContent = fmtMs(result.activeDurationMs ?? 0);
  dom.dbgSession.textContent = fmtMs(result.sessionActiveMs ?? 0);
  dom.dbgActivity.textContent = (result.activity ?? 0).toFixed(3);
  dom.dbgRoll.textContent = result.rollDeg != null ? result.rollDeg.toFixed(1) : "--";

  if (result.fastEma) {
    dom.dbgBlendshapes.innerHTML = BLENDSHAPE_DEBUG_KEYS.map(([key, label]) => {
      const v = result.fastEma[key];
      return `<div><span>${label}</span><span>${v != null ? v.toFixed(2) : "--"}</span></div>`;
    }).join("");
  }
}

let inspectState = null;
export function setInspectState(stateName) {
  inspectState = stateName;
  dom.stateChips.forEach((c) => c.classList.toggle("active-inspect", c.dataset.state === stateName));
  dom.dbgInspectTitle.textContent = `Inspect: ${stateName}`;
}

export function renderInspect(breakdown) {
  if (!inspectState || !breakdown) return;
  const data = breakdown[inspectState];
  dom.dbgInspect.textContent = data ? JSON.stringify(data, null, 2) : "(no data yet)";
}

export function onButtons(handlers) {
  dom.btnStart.addEventListener("click", handlers.onStart);
  dom.btnRecalibrate.addEventListener("click", handlers.onRecalibrate);
  dom.btnPause.addEventListener("click", handlers.onPause);
  dom.btnResume.addEventListener("click", handlers.onResume);
  dom.btnDebug.addEventListener("click", handlers.onToggleDebug);
  dom.btnReset.addEventListener("click", handlers.onReset);
  dom.stateChips.forEach((chip) => chip.addEventListener("click", () => handlers.onInspect(chip.dataset.state)));
}
