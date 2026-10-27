// Maps tracker features to a point on screen. Calibration gives pairs of
// (features, known screen point); a small ridge regression per axis is fitted
// to them, and a One Euro filter smooths the result.

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

export const BLINK_THRESHOLD = 0.5;

/**
 * Fits a gaze model. rows: feature objects; targets: { x, y } in 0..1
 * viewport coordinates. Returns { predict(features) -> {x, y}, looErrors }
 * where looErrors holds each point's leave-one-out error ({x, y}, viewport
 * fractions).
 */
export function fitGazeModel(rows, targets) {
  const fit = (r, t) => ({
    x: fitAxis(r, t.map((p) => p.x), AXIS_FEATURES.x),
    y: fitAxis(r, t.map((p) => p.y), AXIS_FEATURES.y),
  });
  const model = fit(rows, targets);

  // Leave-one-out: how far off is each calibration point when the model is
  // fitted without it? A fair estimate of accuracy on new points.
  const looErrors = rows.map((row, i) => {
    const m = fit(rows.filter((_, j) => j !== i), targets.filter((_, j) => j !== i));
    return { x: predictAxis(m.x, row) - targets[i].x, y: predictAxis(m.y, row) - targets[i].y };
  });

  return {
    predict: (f) => ({ x: predictAxis(model.x, f), y: predictAxis(model.y, f) }),
    looErrors,
  };
}

function fitAxis(rows, y, keys) {
  const n = rows.length;
  const k = keys.length;
  const mean = keys.map((key) => rows.reduce((s, r) => s + r[key], 0) / n);
  const std = keys.map((key, j) => {
    const v = rows.reduce((s, r) => s + (r[key] - mean[j]) ** 2, 0) / n;
    return Math.max(Math.sqrt(v), MIN_STD[key]);
  });
  const Z = rows.map((r) => keys.map((key, j) => (r[key] - mean[j]) / std[j]));
  const yMean = y.reduce((s, v) => s + v, 0) / n;

  // Solve (ZᵀZ + λI) w = Zᵀ(y - ȳ).
  const A = Array.from({ length: k }, (_, a) =>
    Array.from({ length: k }, (_, b) => Z.reduce((s, z) => s + z[a] * z[b], 0) + (a === b ? RIDGE * n : 0)),
  );
  const rhs = Array.from({ length: k }, (_, a) => Z.reduce((s, z, i) => s + z[a] * (y[i] - yMean), 0));
  return { keys, mean, std, w: solve(A, rhs), bias: yMean };
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
  constructor(model) {
    this.model = model;
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
  }

  /** Latest gaze point, or null if tracking has been lost for a moment. */
  current(now) {
    return now - this.updatedAt < 400 ? this.point : null;
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
