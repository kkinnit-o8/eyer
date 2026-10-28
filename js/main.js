import { Tracker } from "./tracker.js";
import { Calibration } from "./calibration.js";
import { fitGazeModel, GazeEstimator } from "./gaze.js";
import { Game, GAME_MS } from "./game.js";
import { ManiaMode } from "./mania/index.js";
import { $, setStatus, readStorage, writeStorage } from "./ui.js";

// ?mouse uses the mouse pointer instead of the camera, handy for testing.
const MOUSE_MODE = new URLSearchParams(location.search).has("mouse");
const COUNTDOWN_MS = 3000;
const FACE_LOST_MS = 600;
// After popping a corner circle, eyes rest on it: learn from this window.
const LEARN_FROM_MS = 150;
const LEARN_TO_MS = 600;
const LEARN_WAIT_MS = 400; // let late tracking results for the window arrive
const BEST_KEY = "eyer.best";
const TUTORIAL_KEY = "eyer.tutorialSeen";

// Targets on the tracking-check screen (viewport fractions).
const CHECK_TARGETS = [
  [0.08, 0.1], [0.5, 0.1], [0.92, 0.1],
  [0.08, 0.5], [0.5, 0.45], [0.92, 0.5],
  [0.08, 0.9], [0.92, 0.9],
];

const canvas = $("stage");
const ctx = canvas.getContext("2d");
const tutorialSteps = [...document.querySelectorAll(".tutorial-step")];

const app = {
  state: "intro",
  width: 0,
  height: 0,
  tracker: null,
  calibration: null,
  calibratedFullscreen: false,
  gaze: null,
  slack: 0,
  game: null,
  countdownEnd: 0,
  showGaze: false,
  faceSeenAt: -Infinity,
  mouse: null,
  pendingLooks: [], // known gaze points waiting to be learned from
  tutorialStep: 0,
  tutorialReturn: "intro",
};

const mania = new ManiaMode({
  setState: (state) => setState(state),
  gaze: (now) => currentGaze(now),
  exit: () => setState("check"),
  learn: (x, y, at) => {
    if (app.gaze) app.pendingLooks.push({ target: { x, y }, from: at + LEARN_FROM_MS, to: at + LEARN_TO_MS });
  },
  tunedCount: () => (app.gaze ? app.gaze.learnedTotal : null),
});

function setState(state, { focus = true } = {}) {
  app.state = state;
  document.body.dataset.state = state;
  for (const screen of document.querySelectorAll(".screen")) {
    screen.classList.toggle("active", screen.dataset.screen === state);
  }
  // Focus the main button so Space/Enter works without the mouse.
  if (focus) document.querySelector(".screen.active button.primary:not(:disabled)")?.focus({ preventScroll: true });
}

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  app.width = window.innerWidth;
  app.height = window.innerHeight;
  canvas.width = Math.round(app.width * dpr);
  canvas.height = Math.round(app.height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  app.game?.resize(app.width, app.height);
  mania.resize(app.width, app.height);
}

function currentGaze(now) {
  if (MOUSE_MODE) return app.mouse;
  return app.gaze?.current(now) ?? null;
}

// ---- Flow ---------------------------------------------------------------

async function enableCamera() {
  if (MOUSE_MODE) {
    app.slack = 0.06 * Math.min(app.width, app.height);
    setStatus($("accuracy"), "Mouse mode: the pointer stands in for your eyes.");
    setState("check");
    return;
  }
  const button = $("btn-camera");
  button.disabled = true;
  setStatus($("intro-status"), "Starting camera and loading the face tracker…");
  // First visit: show the tips while the tracker loads.
  if (!readStorage(TUTORIAL_KEY)) openTutorial("intro");
  try {
    const tracker = new Tracker($("video"));
    await tracker.start();
    app.tracker = tracker;
    setStatus($("intro-status"), "");
    if (app.state === "intro") setState("setup");
  } catch (err) {
    console.error(err);
    setStatus($("intro-status"), err.message, "bad");
    button.disabled = false;
    if (app.state === "tutorial") setState("intro");
  }
}

function openTutorial(returnTo = app.state) {
  app.tutorialReturn = returnTo;
  writeStorage(TUTORIAL_KEY, "1");
  showTutorialStep(0);
  setState("tutorial");
}

function showTutorialStep(i) {
  app.tutorialStep = i;
  tutorialSteps.forEach((el, j) => {
    el.hidden = j !== i;
  });
  $("tutorial-progress").textContent = `Tip ${i + 1} of ${tutorialSteps.length}`;
  $("btn-tutorial-back").disabled = i === 0;
  $("btn-tutorial-next").textContent = i === tutorialSteps.length - 1 ? "Got it" : "Next";
  document.querySelector('[data-screen="tutorial"]').scrollTop = 0;
}

function nextTutorialStep() {
  if (app.tutorialStep < tutorialSteps.length - 1) showTutorialStep(app.tutorialStep + 1);
  else closeTutorial();
}

function previousTutorialStep() {
  if (app.tutorialStep === 0) return;
  showTutorialStep(app.tutorialStep - 1);
  if (app.tutorialStep === 0) $("btn-tutorial-next").focus({ preventScroll: true });
}

function closeTutorial() {
  // Opened while the camera was starting: carry on to setup once it's ready.
  setState(app.tutorialReturn === "intro" && app.tracker ? "setup" : app.tutorialReturn);
}

function startCalibration() {
  if (MOUSE_MODE) {
    setState("check");
    return;
  }
  if (document.fullscreenEnabled && !document.fullscreenElement) {
    document.documentElement.requestFullscreen().catch(() => {});
  }
  app.calibratedFullscreen = document.fullscreenEnabled;
  setStatus($("setup-error"), "");
  app.calibration = new Calibration(performance.now());
  setState("calibrating");
}

function finishCalibration() {
  const data = app.calibration.result();
  app.calibration = null;
  if (!data) {
    setStatus($("setup-error"), "Couldn't see your eyes well enough. Face the camera with your face evenly lit, then try again.", "bad");
    setState("setup");
    return;
  }

  const model = fitGazeModel(data.rows, data.targets);
  app.gaze = new GazeEstimator(model, data);
  app.pendingLooks = [];

  const { width: W, height: H } = app;
  const errors = model.looErrors.map((e) => Math.hypot(e.x * W, e.y * H));
  const error = errors.reduce((a, b) => a + b, 0) / errors.length;
  const short = Math.min(W, H);
  // The less precise the tracking, the more forgiving the ball.
  app.slack = Math.min(0.15 * short, Math.max(0.06 * short, 0.7 * error));

  const rel = error / short;
  const [verdict, tone] = rel < 0.09 ? ["great", "ok"] : rel < 0.16 ? ["okay", "warn"] : ["rough — try recalibrating in better light", "bad"];
  setStatus($("accuracy"), `Typical error about ${Math.round(error)} px: ${verdict}.`, tone);
  setState("check");
}

function startCountdown() {
  if (app.calibratedFullscreen && document.fullscreenEnabled && !document.fullscreenElement) {
    document.documentElement.requestFullscreen().catch(() => {});
  }
  app.game = new Game(app.width, app.height, app.slack);
  app.countdownEnd = performance.now() + COUNTDOWN_MS;
  $("hud-score").textContent = "0";
  $("hud-time").textContent = (GAME_MS / 1000).toFixed(1);
  $("hud-time").classList.remove("low");
  setState("countdown");
}

function endGame() {
  const score = app.game.score;
  const best = loadBest();
  $("final-score").textContent = String(score);
  if (score > best) {
    saveBest(score);
    setStatus($("best-score"), "New best!", "ok");
  } else {
    setStatus($("best-score"), `Best: ${best}`);
  }
  setState("results");
}

function loadBest() {
  return Number(readStorage(BEST_KEY)) || 0;
}

function saveBest(score) {
  writeStorage(BEST_KEY, String(score));
}

// ---- Per frame ----------------------------------------------------------

function onTrackerFrame(result, now) {
  if (result.face) app.faceSeenAt = now;
  if (app.state === "setup") updateSetup(result, now);
  if (!result.features) return;
  // Time the features by when the camera frame was captured.
  const t = result.time ?? now;
  if (app.state === "calibrating") app.calibration.addSample(result.features, t);
  app.gaze?.update(result.features, t, app.width, app.height);
}

function updateSetup(result, now) {
  app.tracker.drawPreview($("cam-overlay"), result.preview);
  const status = $("face-status");
  if (result.face) {
    const size = result.size;
    if (size < 0.12) setStatus(status, "Move a little closer to the camera.", "warn");
    else if (size > 0.55) setStatus(status, "Move back a little.", "warn");
    else setStatus(status, "Face found. You're ready.", "ok");
  } else if (now - app.faceSeenAt > FACE_LOST_MS) {
    setStatus(status, "Looking for your face…");
  }
  const button = $("btn-calibrate");
  const ready = now - app.faceSeenAt < 1000;
  if (button.disabled === ready) {
    button.disabled = !ready;
    if (ready && document.activeElement === document.body) button.focus({ preventScroll: true });
  }
}

function step(now) {
  if (app.state === "calibrating") {
    app.calibration.update(now);
    if (app.calibration.done) finishCalibration();
  } else if (app.state === "countdown") {
    if (now >= app.countdownEnd) {
      app.game.start(now);
      setState("playing");
    }
  } else if (app.state === "mania") {
    mania.step(now);
  } else if (app.state === "offset") {
    mania.stepOffset(now);
  } else if (app.state === "editor-rec") {
    mania.stepEditor(now);
  } else if (app.state === "playing") {
    app.game.update(now, currentGaze(now));
    const left = app.game.timeLeft(now);
    $("hud-score").textContent = String(app.game.score);
    $("hud-time").textContent = (left / 1000).toFixed(1);
    $("hud-time").classList.toggle("low", left <= 3000);
    if (app.game.isOver(now)) endGame();
  }

  const watching = ["calibrating", "check", "countdown", "playing", "mania"].includes(app.state);
  $("face-warning").hidden = !(app.tracker && watching && now - app.faceSeenAt > FACE_LOST_MS);
}

function draw(now) {
  const { width: W, height: H } = app;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, W, H);

  if (app.state === "calibrating") {
    app.calibration.draw(ctx, now, W, H);
  } else if (app.state === "check") {
    drawCheck(now);
  } else if (app.state === "countdown") {
    const n = Math.ceil((app.countdownEnd - now) / 1000);
    ctx.fillStyle = "rgba(255, 255, 255, 0.9)";
    ctx.font = `700 ${Math.round(Math.min(W, H) * 0.25)}px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(Math.max(1, n)), W / 2, H / 2);
    if (app.showGaze) drawGazeRing(currentGaze(now));
  } else if (app.state === "playing") {
    app.game.draw(ctx, now);
    if (app.showGaze) drawGazeRing(currentGaze(now));
  } else if (app.state === "mania") {
    mania.draw(ctx);
    if (app.showGaze) drawGazeRing(currentGaze(now));
  } else if (app.state === "editor-rec") {
    mania.drawEditor(ctx, now);
  }
}

// Targets light up when the gaze is within the same range that counts as a
// hit in the game.
function drawCheck(now) {
  const gaze = currentGaze(now);
  const reach = Game.ballRadius(app.width, app.height) + app.slack;
  for (const [fx, fy] of CHECK_TARGETS) {
    const x = fx * app.width;
    const y = fy * app.height;
    const hit = gaze && Math.hypot(gaze.x - x, gaze.y - y) <= reach;
    ctx.fillStyle = hit ? "#ff2a1f" : "rgba(255, 255, 255, 0.25)";
    ctx.beginPath();
    ctx.arc(x, y, 10, 0, Math.PI * 2);
    ctx.fill();
  }
  drawGazeRing(gaze);
}

function drawGazeRing(gaze) {
  if (!gaze) return;
  ctx.strokeStyle = "rgba(255, 255, 255, 0.7)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(gaze.x, gaze.y, 14, 0, Math.PI * 2);
  ctx.stroke();
}

// Self-correcting calibration: once a look's window has passed, learn from
// it if the estimated gaze stayed in the same quarter of the screen.
function learnFromLooks(now) {
  while (app.pendingLooks.length && now > app.pendingLooks[0].to + LEARN_WAIT_MS) {
    const { target, from, to } = app.pendingLooks.shift();
    const sameQuarter = (p) => p.x < 0.5 === target.x < 0.5 && p.y < 0.5 === target.y < 0.5;
    app.gaze?.learn(target, from, to, sameQuarter);
  }
}

function loop(now) {
  if (app.tracker) {
    const result = app.tracker.detect(now);
    if (result) onTrackerFrame(result, now);
  }
  learnFromLooks(now);
  step(now);
  draw(now);
  requestAnimationFrame(loop);
}

// ---- Wiring -------------------------------------------------------------

$("btn-camera").addEventListener("click", enableCamera);
$("btn-calibrate").addEventListener("click", startCalibration);
$("btn-recalibrate-check").addEventListener("click", startCalibration);
$("btn-play").addEventListener("click", startCountdown);
$("btn-again").addEventListener("click", startCountdown);
$("btn-ball-menu").addEventListener("click", () => setState("check"));
$("btn-mania").addEventListener("click", () => mania.open());
$("btn-tutorial-next").addEventListener("click", nextTutorialStep);
$("btn-tutorial-back").addEventListener("click", previousTutorialStep);
$("btn-tutorial-skip").addEventListener("click", closeTutorial);
for (const button of document.querySelectorAll("[data-open-tutorial]")) {
  button.addEventListener("click", () => openTutorial());
}

window.addEventListener("resize", resize);
window.addEventListener("pointermove", (e) => {
  app.mouse = { x: e.clientX, y: e.clientY };
});
window.addEventListener("pointerdown", (e) => {
  if (app.state === "editor-rec") mania.editorPointer(e);
});
window.addEventListener("keydown", (e) => {
  if (app.state === "editor-rec") {
    mania.editorKey(e);
    return;
  }
  if (app.state === "offset") {
    mania.keydown(e);
    return;
  }
  if (app.state === "mania") {
    if (e.key === "g" || e.key === "G") app.showGaze = !app.showGaze;
    else mania.keydown(e);
    return;
  }
  if (app.state === "tutorial") {
    if (e.key === "ArrowRight") nextTutorialStep();
    else if (e.key === "ArrowLeft") previousTutorialStep();
    else if (e.key === "Escape") closeTutorial();
    return;
  }
  if (e.key === "g" || e.key === "G") app.showGaze = !app.showGaze;
});
window.addEventListener("keyup", (e) => {
  if (app.state === "mania") mania.keyup(e);
});

if (MOUSE_MODE) $("btn-camera").textContent = "Start (mouse mode)";

resize();
setState("intro", { focus: false });
requestAnimationFrame(loop);
