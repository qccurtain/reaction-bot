# Reaction Bot — v0.1 (validation prototype)

Mobile web page that opens the phone's front camera, runs MediaPipe Face
Landmarker + Blendshapes **entirely on-device**, calibrates a per-user
neutral baseline, and classifies visible facial reactions into streamer-meme
states (`SHOCKED`, `HAPPY`, `CONFUSED`, `TILTED`, `LOCKED_IN`, `DEAD_INSIDE`,
`NEUTRAL`).

**No Twitch integration. No server. No camera frame ever leaves the phone.**
This build only answers one question: *is phone-side MediaPipe good enough
to drive believable meme states?*

## 1. Project structure

```
reaction-bot/
├── index.html            # UI shell (camera preview, state display, debug panel)
├── styles.css            # dark mobile-first styling
├── src/
│   ├── config.js         # ALL tunable thresholds/durations live here
│   ├── camera.js         # getUserMedia front camera, nothing else
│   ├── faceTracker.js    # MediaPipe FaceLandmarker wrapper + throttled loop
│   ├── baseline.js       # 10s neutral calibration, per-signal mean/std
│   ├── stateEngine.js    # normalize -> smooth -> candidate -> persistence -> state
│   ├── ui.js             # DOM rendering only, no logic
│   └── main.js           # wires everything together, app lifecycle
└── test-harness.html     # dev-only synthetic logic test (see §11)
```

No bundler, no framework, no build step. Everything is a plain ES module
loaded by the browser directly. MediaPipe's runtime and model are pulled
from jsDelivr / Google Cloud Storage CDNs at page load (cached by the
browser afterward) — that's the only network activity this page ever does.

## 2. Install dependencies

There are none to install. This is a static site; MediaPipe Tasks Vision is
imported straight from a CDN inside `src/faceTracker.js`:

```js
import { FilesetResolver, FaceLandmarker } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.21";
```

pinned to `0.10.21` so behavior doesn't drift under you. No `npm install`,
no `package.json`, no node_modules.

## 3. Run locally

Camera access requires a "secure context" — `localhost` counts, plain `http://<lan-ip>` does not. From the project folder:

```bash
python -m http.server 8765
```

(any static server works — `npx serve .`, VS Code's Live Server, etc.)
Then open `http://localhost:8765` in a desktop browser to sanity-check the
UI. Your desktop webcam will work here too since localhost is secure.

## 4. Deploy to a free HTTPS static host (for phone testing)

**GitHub Pages** (recommended, $0):

```bash
cd "reaction-bot"
git init
git add index.html styles.css src README.md
git commit -m "Reaction Bot v0.1"
git branch -M main
git remote add origin https://github.com/<you>/reaction-bot.git
git push -u origin main
```

Then in the repo settings: **Settings → Pages → Source → Deploy from branch
→ `main` / root**. Your page will be live at
`https://<you>.github.io/reaction-bot/` (HTTPS by default — required for
`getUserMedia` on a phone).

Any other free static HTTPS host works identically (Cloudflare Pages,
Netlify, Vercel) since there's zero backend.

## 5. Test from a phone

1. Open the deployed HTTPS URL in **mobile Safari (iOS)** or **Chrome
   (Android)**.
2. Tap **Start Camera** → grant the front-camera permission prompt.
3. Hold a relaxed, normal expression for the ~10s calibration bar.
4. Try: smiling/laughing, a sudden wide-eyed "what" face, a tense
   frown/squint, staying still and just watching the screen for 5-10s.
5. Tap **Show Debug** to see live blendshape numbers while you make faces —
   this is the main tool for tuning thresholds in `config.js`.

## 6. Browser compatibility notes

- Requires WebAssembly + `getUserMedia` + ES modules — every current mobile
  Safari/Chrome/Edge/Firefox supports all three.
- Requests the **GPU** MediaPipe delegate first and automatically falls back
  to **CPU** if GPU init fails (some older Android WebViews/GPUs reject it) —
  see `faceTracker.js` `initFaceLandmarker()`.
- Must be served over **HTTPS or localhost**. Camera access silently fails
  (or throws `NotAllowedError`/insecure-context errors) otherwise.
- iOS Safari: the page must be a normal tab, not embedded in an in-app
  webview that blocks camera permissions (e.g. some social-media in-app
  browsers) — open it in actual Safari/Chrome if a link preview fails.

## 7. Known limitations

- **Head-pose angles are approximate.** `faceTracker.js` decomposes the
  facial transformation matrix into rough roll/pitch/yaw — good enough as a
  coarse "head tilt" signal, not a calibrated pose estimate.
- **Single face only** (`numFaces: 1`) — a second face in frame is ignored.
- **Lighting-sensitive**, like all camera-based face tracking — very dark or
  backlit rooms degrade blendshape quality before they degrade the state
  logic.
- **CONFUSED and DEAD_INSIDE are the least reliable states** by design — see
  §10.
- The activity meter that gates `LOCKED_IN`/`DEAD_INSIDE` combines
  frame-to-frame movement AND deviation-from-baseline (so a frozen non-
  neutral face — e.g. a held scowl — doesn't get miscounted as "zoned out
  stillness"). This is still a coarse heuristic, tuned via the synthetic
  test harness rather than real faces — expect to retune `config.js`
  `activity.weights` / `states.LOCKED_IN` / `states.DEAD_INSIDE` after
  watching the debug panel on a real phone.

## 8. How the heuristic state logic works

Pipeline (`stateEngine.js`), run once per inference frame:

```
raw blendshape scores (MediaPipe, 0..1 per category)
  → baseline.significance(name, value):  (value - personalMean) / noiseBand, clamped 0..1
  → exponential smoothing: fastEma (responsive) + slowEma (slow reference, used for "sudden change")
  → per-state weighted score (0..1) from a handful of significance signals
  → PersistenceGate: score must stay >= enterThreshold for minDurationMs to CONFIRM
                       must stay <  exitThreshold for exitGraceMs to UN-confirm (hysteresis, kills flicker)
  → highest-priority CONFIRMED state wins (STATE_PRIORITY in config.js)
  → NEUTRAL is the fallback when nothing else is confirmed
```

`LOCKED_IN` and `DEAD_INSIDE` don't use the same per-frame weighted score —
they watch a rolling **activity meter** (max of frame-to-frame movement and
deviation-from-baseline) and require it to stay below a threshold for
several seconds, *and* require the session to already be
`session.lockedInEligibleAfterMs` old (so calibration's own stillness can't
immediately trigger them). `DEAD_INSIDE` is ranked above `LOCKED_IN` in
`STATE_PRIORITY` — see the comment in `config.js` for why (it's a strict
superset condition, so ranking it lower would make it unreachable). A
`SHOCKED` spike still interrupts either one immediately, since priority
order always wins over whatever's currently active.

Confidence is **not** a calibrated probability — it's the same 0..1 weighted
score (or, for the two temporal states, `1 - activityLevel/threshold`) shown
directly to the user. Treat it as a tuning dial, not a scientific measure.

None of this claims to detect real emotions — it labels **visible facial
configurations** (wide eyes + open jaw = "SHOCKED"), the same way a caption
generator would.

## 9. Where thresholds/durations live

Everything is in **`src/config.js`**, one object:

- `CONFIG.smoothing` — EMA alphas (fast/slow)
- `CONFIG.calibration` — duration, min samples, per-signal noise floors
- `CONFIG.session.lockedInEligibleAfterMs` — anti-"instant LOCKED_IN" gate
- `CONFIG.activity` — the movement/deviation meter's per-signal weights
- `CONFIG.states.<STATE>` — `enterThreshold`, `exitThreshold`,
  `minDurationMs`, `exitGraceMs`, and the signal `weights` for that state's
  score function
- `STATE_PRIORITY` — the ordered list that resolves ties/interrupts

The scoring *formulas* live in `stateEngine.js` (e.g. "HAPPY = smile +
cheekSquint + laugh bonus"), but every number that formula depends on is a
lookup into `CONFIG`, not a literal. Retuning is edit-`config.js`-only for
every case except changing which signals a state listens to at all.

## 10. Which states are solid vs. fragile

**Technically straightforward / worked immediately in synthetic testing:**
- `SHOCKED` — wide eyes + jaw drop is a big, fast, unambiguous blendshape
  signal. This is the one most likely to read well on a real phone.
- `HAPPY` — smile blendshapes are strong and MediaPipe's smile detection is
  generally reliable.
- `TILTED` — brow-down + squint + mouth press is a clear combined signal
  when genuinely held; conservative thresholds keep false positives low.
- `LOCKED_IN` / `DEAD_INSIDE` — mechanically simple (just watch a variance
  meter over time) but **semantically fuzzy**: "stillness" isn't the same
  as "engagement" or "checked out." Expect to retune constantly against
  real footage of actually zoning out vs. actually concentrating.

**Heuristic / fragile, flagged explicitly per the brief:**
- `CONFUSED` — this is the weakest state. Facial asymmetry is subtle,
  webcam-grade blendshape noise is easily comparable in magnitude to real
  asymmetry signal, and "confused" doesn't have one obvious facial
  signature the way surprise or smiling do. The conservative thresholds
  mean it will likely **under-trigger** (fall back to NEUTRAL) far more
  than it over-triggers — that's the intended, safer failure mode, but it
  also means don't expect it to feel very responsive yet.
- `DEAD_INSIDE` vs `LOCKED_IN` — the split is a single stricter
  threshold + longer duration on the same underlying signal. In practice
  these two will likely need the most manual retuning of any pair here.

## 11. Dev-only synthetic test harness

`test-harness.html` (not linked from `index.html`, not part of the shipped
app) feeds fabricated blendshape sequences through `baseline.js` +
`stateEngine.js` with a mocked clock, to sanity-check the state machine
without a camera. Open it the same way (`http://localhost:8765/test-harness.html`)
to re-run it after changing `config.js`. It currently checks: SHOCKED fires
fast and decays fast, HAPPY/TILTED/CONFUSED fire within their spec'd
windows, CONFUSED doesn't false-positive on mild asymmetry, LOCKED_IN
respects the session-eligibility gate, DEAD_INSIDE requires longer/lower
activity than LOCKED_IN, and SHOCKED correctly interrupts LOCKED_IN. This
does **not** replace real-phone testing — it only proves the state-machine
wiring is internally consistent.

## 12. What to record manually during phone testing

For each attempt, note: the state shown, the confidence %, and the debug
blendshape values, so thresholds can be adjusted from real numbers instead
of guesses. Suggested test log columns:

| expression attempted | expected state | actual state | confidence | time-to-trigger | notes (lighting, phone angle) |

Specifically worth capturing:
- A genuine, undirected "surprised" reaction (something startles you) vs. a
  posed one — does the fast-change component of SHOCKED actually fire
  faster on genuine surprise?
- Several different people's calibration — does the personal-baseline
  normalization actually make TILTED/CONFUSED usable across different
  resting faces, or does one person's "resting frown" still false-positive?
- A real "zoning out while gaming" session — what does LOCKED_IN vs
  DEAD_INSIDE actually look like in the debug panel's activity meter over
  5-10 minutes?
- False positives during normal talking/eating/adjusting glasses — these
  are the most likely real-world flicker sources not covered by the
  synthetic tests.

## Privacy

Face processing runs 100% locally in the browser via WASM. The camera
`MediaStream` is only ever attached to a local `<video>` element and read
frame-by-frame by the on-device model (`faceTracker.js`) — no frame is ever
drawn to a canvas for export, written to disk, or sent over the network. No
analytics, no remote face-recognition service, no paid API.
