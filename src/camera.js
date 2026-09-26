// ============================================================================
// Front camera access. Nothing here ever sends a frame anywhere -- the
// MediaStream is only ever attached to a local <video> element and read by
// faceTracker.js via canvas/video pixels handed straight to the on-device
// WASM model. No frame is written to disk, canvas.toDataURL, or a network
// request.
// ============================================================================

let currentStream = null;

export async function startFrontCamera(videoEl) {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error(
      "Camera API unavailable. This page must be served over HTTPS (or localhost) in a modern mobile browser."
    );
  }

  const constraints = {
    audio: false,
    video: {
      facingMode: { ideal: "user" },
      width: { ideal: 640 },
      height: { ideal: 480 },
    },
  };

  const stream = await navigator.mediaDevices.getUserMedia(constraints);
  currentStream = stream;

  videoEl.srcObject = stream;
  videoEl.muted = true;
  videoEl.playsInline = true;

  await new Promise((resolve) => {
    if (videoEl.readyState >= 2) return resolve();
    videoEl.onloadedmetadata = () => resolve();
  });
  await videoEl.play();

  return stream;
}

export function stopCamera() {
  if (currentStream) {
    for (const track of currentStream.getTracks()) track.stop();
    currentStream = null;
  }
}

export function isCameraActive() {
  return !!currentStream;
}
