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
├── index.html                  # UI shell (camera preview, state display, debug panel)
├── styles.css                  # dark mobile-first styling
├── src/
│   ├── config.js                # ALL tunable thresholds/durations live here
│   ├── camera.js                 # getUserMedia front camera, nothing else
│   ├── faceTracker.js            # MediaPipe FaceLandmarker wrapper + throttled loop
│   ├── baseline.js               # 10s neutral calibration, per-signal mean/std
│   ├── expressionCalibration.js  # OPTIONAL personal expression calibration (v0.2)
│   ├── stateEngine.js            # normalize -> smooth -> candidate -> persistence -> state
│   ├── ui.js                     # DOM rendering only, no logic
│   └── main.js                   # wires everything together, app lifecycle + calibration flow
└── test-harness.html            # dev-only synthetic regression tests (see §12)
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

## 6. Optional personal expression calibration (v0.2)

Real phone testing showed the original single-neutral-baseline design needed
very exaggerated expressions to trigger TILTED/CONFUSED, and that SHOCKED's
`eyeWide` blendshape barely moves for some people even on a genuine
surprised reaction. Two fixes landed for this, both **additive** — skip them
entirely and the original default scoring is untouched, byte-for-byte:

**1. SHOCKED alt-path (always on, no calibration needed).** A meaningful
brow raise (`browInnerUp`) plus at least one supporting change (eye widen,
jaw drop, or a sudden-change spike) now also qualifies as SHOCKED,
independent of the primary weighted score. This directly matches the report
that a real surprised reaction moved `browInnerUp` a lot and `eyeWide`
almost not at all. Solo jaw movement (e.g. talking) still doesn't qualify,
since it never raises the brow. See `config.js` → `states.SHOCKED.altPath`.

**2. Optional per-expression calibration (opt-in, after neutral).** After
the 10s neutral calibration, the user is asked (skippable) to briefly make a
natural SURPRISE / SMILE / FROWN. Each capture:
- Runs through `src/expressionCalibration.js`, reusing the same
  `BaselineCollector` machinery as neutral (just a shorter ~2.5s window).
- Is **rejected** (with a Retry/Skip/Cancel prompt) if it doesn't separate
  meaningfully from the person's own neutral baseline on ANY of that
  expression's signals — a flat/indistinguishable attempt is never silently
  accepted as "their strong expression."
- If accepted, **redistributes that state's scoring weight** toward
  whichever signal(s) *that specific person* demonstrably moves, away from
  ones they don't — while conserving the exact same total weight budget, so
  the enter/exit thresholds stay meaningful (this is `personalizeWeights()`
  in `expressionCalibration.js`). It also personalizes the normalization
  band per signal so reaching ~80% of *their own* calibrated peak reads as
  fully significant.

**Why this design, not just "lower the threshold":** the real failure mode
wasn't noise — it was that TILTED/CONFUSED's weighted-sum formulas require
several signals to move in agreement, and a real posed attempt often only
convincingly moves one or two. Globally lowering the threshold would fix
that person at the cost of raising false positives for everyone else.
Reweighting toward *that person's own demonstrated* signals fixes it without
touching the shared default thresholds at all.

**Trade-offs / what this does NOT do:**
- It's still a heuristic, not a classifier — it reweights among the SAME
  fixed feature set, it doesn't learn a new decision boundary.
- `CONFUSED` has no calibration profile (asymmetry can't usefully be
  "posed" the same way) and remains default-only/experimental.
- One noisy calibration burst can only shift so much: `minRetention` (0.15)
  keeps every signal at least partially alive so a fluke zero-movement
  capture can't permanently zero a channel — but this also means
  personalization won't always be enough to cross a conservative threshold
  by itself. See the regression tests in §12 for a case where it
  provably helps (crosses a threshold the default formula structurally
  cannot) versus the real anecdotal report, which may need `config.js`
  tuning on top.
- **Numeric calibration is saved on this browser.** Neutral statistics and
  accepted expression amplitudes are restored after reloading. Camera frames
  and video are never saved or uploaded. Use Clear Saved Calibration to remove
  the saved copy. See v0.2.2 below for storage limitations.

**Also fixed alongside this:** the debug panel's "Candidate state" used to
just echo whatever was already confirmed/active, which was useless for
tuning. It now shows the real leading contender — including one that's
still mid-way through its persistence timer and hasn't confirmed yet — with
its own progress (`1.2s / 2.0s`), separately from the big confirmed `state`
display. And a stale-timer bug was fixed: face-loss, Pause, and
(re)calibration all now clear each state's in-progress accumulation timer
(`StateEngine.freezeGates()`) before frames resume, so a multi-second gap
can no longer cause an instant false-confirm the moment tracking picks back
up.

## 7. Browser compatibility notes

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

## 8. Known limitations

- **Head-pose angles are approximate.** `faceTracker.js` decomposes the
  facial transformation matrix into rough roll/pitch/yaw — good enough as a
  coarse "head tilt" signal, not a calibrated pose estimate.
- **Single face only** (`numFaces: 1`) — a second face in frame is ignored.
- **Lighting-sensitive**, like all camera-based face tracking — very dark or
  backlit rooms degrade blendshape quality before they degrade the state
  logic.
- **CONFUSED and DEAD_INSIDE are the least reliable states** by design — see
  §11.
- The activity meter that gates `LOCKED_IN`/`DEAD_INSIDE` combines
  frame-to-frame movement AND deviation-from-baseline (so a frozen non-
  neutral face — e.g. a held scowl — doesn't get miscounted as "zoned out
  stillness"). This is still a coarse heuristic, tuned via the synthetic
  test harness rather than real faces — expect to retune `config.js`
  `activity.weights` / `states.LOCKED_IN` / `states.DEAD_INSIDE` after
  watching the debug panel on a real phone.

## 9. How the heuristic state logic works

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

## 10. Where thresholds/durations live

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

## 11. Which states are solid vs. fragile

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

## 12. Dev-only synthetic test harness

`test-harness.html` (not linked from `index.html`, not part of the shipped
app) feeds fabricated blendshape sequences through `baseline.js` +
`expressionCalibration.js` + `stateEngine.js` with a mocked clock (so it runs
instantly, with no real waiting), to sanity-check the state machine and the
personalization logic without a camera. Open it the same way
(`http://localhost:<port>/test-harness.html`, using whatever port your local
server is on) to re-run it after changing `config.js`; it prints real
`PASS`/`FAIL` lines per assertion plus a final tally, not just descriptive
logs. **This does NOT replace real-phone testing** — it only proves the
state-machine and personalization wiring behave the way they're designed to
on synthetic input; it says nothing about whether MediaPipe's real blendshape
output on a real face will actually reach these numbers.

It currently checks (9 sections, 33 assertions as of this write-up):
1. **Default path unaffected** — SHOCKED/HAPPY/TILTED/DEAD_INSIDE all still
   fire and decay within their spec'd windows with calibration skipped
   entirely (byte-for-byte the original formulas).
2. **Calibration rejection** — a burst indistinguishable from neutral is
   rejected, and a rejected result never gets treated as calibrated even if
   `commit()` is called on it.
3. **Calibration measurably helps a real shortfall** — a controlled 2-of-4
   -signal TILTED attempt that the DEFAULT formula can structurally never
   cross (max achievable score is below the enter threshold even at full
   signal strength) DOES cross once that person's own calibration data
   redistributes weight toward the two channels they actually use.
4. **High resting/neutral values don't false-trigger** — a person whose
   resting `eyeSquint` is 0.29 (not near 0) sitting at their own neutral
   does not read as TILTED.
5. **Candidate vs. confirmed state are distinct** — a state's `candidateState`
   (and its live progress toward `minDurationMs`) shows up WHILE it's still
   accumulating evidence, before `state` (the confirmed/displayed state)
   changes — this is the fix for the "candidate always equals state" bug.
6. **Stale timers don't survive gaps** — a face-loss dropout and a
   `freezeGates()` call (what happens around a Pause/recalibration) both
   correctly discard in-progress evidence, so a multi-second gap can't
   instantly false-confirm the moment tracking resumes.
7. **LOCKED_IN/DEAD_INSIDE/interrupt regression** — unchanged from the
   original v0.1 suite.
8. **SHOCKED alt-path** — fires on brow-raise-without-eyeWide (matching the
   real phone report), and does NOT fire on solo jaw movement (talking).
9. **`personalizeWeights()` unit checks** — uncovered terms are left
   byte-identical, total weight budget is exactly conserved, equal salience
   leaves weights unchanged.

## 13. What to record manually during phone testing

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
- **New in v0.2**: with the optional expression calibration completed, does
  TILTED/SHOCKED actually cross now on the same expressions that previously
  failed? Try the SAME exaggeration level you used in earlier testing (don't
  compensate by making it even more exaggerated) — the point is checking
  whether personalization closed the gap on its own.
- Try a **deliberately weak/lazy** attempt during expression calibration
  (barely move your face) and confirm you get the "couldn't tell that apart
  from neutral" rejection prompt, not a silently-accepted weak profile.
- Try **Recalibrate Neutral** and confirm any previously-calibrated
  expression profiles are cleared (offered again, not silently reused
  against a new baseline) — and that **Pause → Resume** and a brief
  face-loss (look away for a few seconds) don't cause an instant/incorrect
  state the moment you look back.

## Privacy

Face processing runs 100% locally in the browser via WASM. The camera
`MediaStream` is only ever attached to a local `<video>` element and read
frame-by-frame by the on-device model (`faceTracker.js`) — no frame is ever
drawn to a canvas for export, written to disk, or sent over the network. No
analytics, no remote face-recognition service, no paid API.


### Review corrections (v0.2)
Personal bands are floored by the neutral noise band and can reduce sensitivity; weight redistribution provides the personalization gain. Skipping personalization retains default weights, but the new surprise alternate path still applies. Re-personalizing clears all old profiles. Session restart clears smoothing and timers; pause excludes elapsed time and clears pending evidence. Synthetic results are not phone validation.


### v0.2.1 false-positive guards
HAPPY now requires mouth-corner lift above neutral; jaw opening contributes no smile score. TILTED requires brow or lip tension, never squint alone. Calibration rejects profiles missing these defining signals and waits for Record before each pose. These stricter guards can miss subtle expressions; skip a rejected profile rather than forcing it. Regression tests cover jaw/weak-smile cross-talk, squint-dominated profiles and genuine smiles/frowns.


### v0.2.2 — upper-face evidence and saved calibration
SHOCKED requires a meaningful eyebrow raise or eye widening beyond neutral, regardless of personalized jaw weights. Jaw-only surprise samples are rejected. Calibration summaries (neutral mean/std and accepted expression amplitudes) are saved in localStorage on this browser only, never uploaded. Start Camera restores them without redoing calibration. Recalibrate when person, lighting or camera position changes. Clear Saved Calibration removes the saved copy; an active session keeps its current calibration until closed or recalibrated. Private browsing, blocked storage or clearing site data may remove/prevent persistence. Invalid or incompatible records are ignored. Existing v0.2.1 sessions were memory-only; calibrate once in v0.2.2 to save.
