// Maps tracker features to a point on screen. Calibration gives pairs of
// (features, known screen point); a small ridge regression per axis is fitted
// to them, and a One Euro filter smooths the result. During play, moments
// where we know where the player is looking add more pairs, so the model
// keeps correcting itself.

import { FEATURE_KEYS } from "./face.js";

// Which features predict each axis.
const AXIS_FEATURES = {
  x: ["eyeX", "lookH", "yaw", "headX"],
  y: ["eyeY", "eyeOpen", "lookV", "pitch", "headY"],
};

// Smallest spread assumed for each feature when standardizing. Without this,
// a feature that barely changed during calibration (say, the head stayed very
// still) would get a huge scale and blow up as soon as it moves in play.
const MIN_STD = {
  eyeX: 0.01, eyeY: 0.005, eyeOpen: 0.01, lookH: 0.03, lookV: 0.03,
  yaw: 0.01, pitch: 0.005, headX: 0.01, headY: 0.01,
};

const RIDGE = 0.03; // regularization, relative to sample count
const MAX_Z = 4; // clamp standardized features to limit wild extrapolation

const LEARN_WEIGHT = 0.5; // a sample learned in play counts half as much as a calibration dot
const LEARN_MAX = 40; // keep only the most recent learned samples, so drift is followed
const LEARN_AGREE = 0.75; // share of frames that must agree with the target
const LEARN_MIN_FRAMES = 3;
const HISTORY_MS = 2500;

export const BLINK_THRESHOLD = 0.5;

/**
 * Fits a gaze model. rows: feature objects; targets: { x, y } in 0..1
 * viewport coordinates; weights: optional per-row weights (default 1).
 * Returns { predict(features) -> {x, y}, looErrors } where looErrors holds
 * each point's leave-one-out error ({x, y}, viewport fractions), unless
 * loo is false.
 */
export function fitGazeModel(rows, targets, { weights = rows.map(() => 1), loo = true } = {}) {
  const fit = (keep) => {
    const r = rows.filter((_, i) => keep(i));
    const w = weights.filter((_, i) => keep(i));
    const t = targets.filter((_, i) => keep(i));
    return {
      x: fitAxis(r, t.map((p) => p.x), w, AXIS_FEATURES.x),
      y: fitAxis(r, t.map((p) => p.y), w, AXIS_FEATURES.y),
    };
  };
  const model = fit(() => true);

  // Leave-one-out: how far off is each calibration point when the model is
  // fitted without it? A fair estimate of accuracy on new points.
  const looErrors = loo
    ? rows.map((row, i) => {
        const m = fit((j) => j !== i);
        return { x: predictAxis(m.x, row) - targets[i].x, y: predictAxis(m.y, row) - targets[i].y };
      })
    : [];

  return {
    predict: (f) => ({ x: predictAxis(model.x, f), y: predictAxis(model.y, f) }),
    looErrors,
  };
}

function fitAxis(rows, y, weights, keys) {
  const k = keys.length;
  const total = weights.reduce((s, w) => s + w, 0);
  const average = (value) => rows.reduce((s, r, i) => s + weights[i] * value(r, i), 0) / total;
  const mean = keys.map((key) => average((r) => r[key]));
  const std = keys.map((key, j) => Math.max(Math.sqrt(average((r) => (r[key] - mean[j]) ** 2)), MIN_STD[key]));
  const Z = rows.map((r) => keys.map((key, j) => (r[key] - mean[j]) / std[j]));
  const yMean = average((_, i) => y[i]);

  // Solve (ZᵀWZ + λI) w = ZᵀW(y - ȳ).
  const A = Array.from({ length: k }, (_, a) =>
    Array.from(
      { length: k },
      (_, b) => Z.reduce((s, z, i) => s + weights[i] * z[a] * z[b], 0) + (a === b ? RIDGE * total : 0),
    ),
  );
  const rhs = Array.from({ length: k }, (_, a) => Z.reduce((s, z, i) => s + weights[i] * z[a] * (y[i] - yMean), 0));
  return { keys, mean, std, w: solve(A, rhs), bias: yMean };
}

/** Per-feature median of a list of feature objects; robust to stray frames. */
export function medianFeatures(samples) {
  const out = {};
  for (const key of FEATURE_KEYS) {
    const v = samples.map((s) => s[key]).sort((a, b) => a - b);
    const m = v.length >> 1;
    out[key] = v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
  }
  return out;
}

function predictAxis(m, f) {
  let v = m.bias;
  for (let j = 0; j < m.keys.length; j++) {
    const z = (f[m.keys[j]] - m.mean[j]) / m.std[j];
    v += m.w[j] * Math.max(-MAX_Z, Math.min(MAX_Z, z));
  }
  return v;
}

// Gaussian elimination with partial pivoting. A is small (k <= 5).
function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / M[c][c];
      for (let j = c; j <= n; j++) M[r][j] -= f * M[c][j];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let j = r + 1; j < n; j++) s -= M[r][j] * x[j];
    x[r] = s / M[r][r];
  }
  return x;
}

/** Turns per-frame features into a smoothed on-screen gaze point. */
export class GazeEstimator {
  /** calibration: the { rows, targets } the model was fitted from. */
  constructor(model, calibration) {
    this.model = model;
    this.calibration = calibration;
    this.learned = []; // { row, target } pairs picked up during play
    this.learnedTotal = 0;
    this.history = []; // recent frames: { t, features, point (viewport fractions) }
    // Low jitter when the eyes rest, quick follow on saccades.
    this.fx = new OneEuroFilter(0.8, 0.004);
    this.fy = new OneEuroFilter(0.8, 0.004);
    this.point = null;
    this.updatedAt = -Infinity;
  }

  update(features, now, width, height) {
    if (features.blink > BLINK_THRESHOLD) return; // eyes closed: keep last point
    const p = this.model.predict(features);
    const t = now / 1000;
    const x = this.fx.filter(p.x * width, t);
    const y = this.fy.filter(p.y * height, t);
    this.point = { x: clamp(x, 0, width), y: clamp(y, 0, height) };
    this.updatedAt = now;
    this.history.push({ t: now, features, point: { x: this.point.x / width, y: this.point.y / height } });
    while (this.history[0].t < now - HISTORY_MS) this.history.shift();
  }

  /**
   * The player was looking at `target` (viewport fractions) between `from`
   * and `to`: learn from the frames in that window and refit. To avoid
   * learning a glance elsewhere, most frames' estimated points must pass
   * `agrees(point)`. Returns true if the model was updated.
   */
  learn(target, from, to, agrees) {
    const frames = this.history.filter((h) => h.t >= from && h.t <= to);
    if (frames.length < LEARN_MIN_FRAMES) return false;
    const agreeing = frames.filter((h) => agrees(h.point));
    if (agreeing.length < frames.length * LEARN_AGREE) return false;

    this.learned.push({ row: medianFeatures(agreeing.map((h) => h.features)), target });
    if (this.learned.length > LEARN_MAX) this.learned.shift();
    this.learnedTotal++;
    const { rows, targets } = this.calibration;
    this.model = fitGazeModel(
      [...rows, ...this.learned.map((l) => l.row)],
      [...targets, ...this.learned.map((l) => l.target)],
      { weights: [...rows.map(() => 1), ...this.learned.map(() => LEARN_WEIGHT)], loo: false },
    );
    return true;
  }

  /** Latest gaze point, or null if tracking has been lost for a moment. */
  current(now) {
    return now - this.updatedAt < 600 ? this.point : null;
  }
}

// https://gery.casiez.net/1euro/
class OneEuroFilter {
  constructor(minCutoff, beta, dCutoff = 1) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.x = null;
    this.dx = 0;
    this.t = null;
  }

  filter(x, t) {
    if (this.x === null) {
      this.x = x;
      this.t = t;
      return x;
    }
    const dt = Math.max(t - this.t, 1e-3);
    const dx = (x - this.x) / dt;
    this.dx += alpha(this.dCutoff, dt) * (dx - this.dx);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += alpha(cutoff, dt) * (x - this.x);
    this.t = t;
    return this.x;
  }
}

function alpha(cutoff, dt) {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}
