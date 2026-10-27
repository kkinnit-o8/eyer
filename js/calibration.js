// Calibration: a dot travels to a series of points. While the player looks at
// each one we record tracker features, giving (features, screen point) pairs.

import { FEATURE_KEYS } from "./tracker.js";
import { BLINK_THRESHOLD } from "./gaze.js";

const INTRO_MS = 2000; // first dot waits so the player can read the reminder
const MOVE_MS = 450; // travel time between points
const DWELL_MS = 1100; // time on each point
const SETTLE_MS = 450; // ignore the start of each dwell while the eyes land
const MIN_SAMPLES = 4;
const MIN_POINTS = 9;

const DOT_RADIUS = 16;

// Viewport fractions: a 3×3 grid plus the four points between its rows.
function makePoints() {
  const edge = [0.07, 0.5, 0.93];
  const inner = [0.28, 0.72];
  const rest = [];
  for (const y of edge) for (const x of edge) if (x !== 0.5 || y !== 0.5) rest.push({ x, y });
  for (const y of inner) for (const x of inner) rest.push({ x, y });
  // Start in the middle, then visit the rest in random order.
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  return [{ x: 0.5, y: 0.5 }, ...rest];
}

export class Calibration {
  constructor(now) {
    this.queue = makePoints().map((p) => ({ ...p, samples: [], retried: false }));
    this.total = this.queue.length;
    this.finished = [];
    this.index = 0;
    this.prev = this.queue[0];
    this.phase = "intro";
    this.phaseStart = now;
  }

  get done() {
    return this.phase === "done";
  }

  addSample(features, now) {
    if (this.phase !== "dwell" || now - this.phaseStart < SETTLE_MS) return;
    if (features.blink > BLINK_THRESHOLD) return;
    this.queue[this.index].samples.push(features);
  }

  update(now) {
    const elapsed = now - this.phaseStart;
    if (this.phase === "intro" && elapsed >= INTRO_MS) this.#setPhase("dwell", now);
    else if (this.phase === "move" && elapsed >= MOVE_MS) this.#setPhase("dwell", now);
    else if (this.phase === "dwell" && elapsed >= DWELL_MS) {
      const point = this.queue[this.index];
      if (point.samples.length >= MIN_SAMPLES) {
        this.finished.push(point);
      } else if (!point.retried) {
        // Face was lost or eyes closed: try this point again at the end.
        this.queue.push({ x: point.x, y: point.y, samples: [], retried: true });
      }
      this.prev = point;
      this.index++;
      this.#setPhase(this.index < this.queue.length ? "move" : "done", now);
    }
  }

  #setPhase(phase, now) {
    this.phase = phase;
    this.phaseStart = now;
  }

  /** { rows, targets } for fitGazeModel, or null if too few points worked. */
  result() {
    if (this.finished.length < MIN_POINTS) return null;
    return {
      rows: this.finished.map((p) => medianFeatures(p.samples)),
      targets: this.finished.map((p) => ({ x: p.x, y: p.y })),
    };
  }

  draw(ctx, now, width, height) {
    if (this.done) return;
    const point = this.queue[this.index];
    const elapsed = now - this.phaseStart;
    let x = point.x;
    let y = point.y;
    let r = DOT_RADIUS;

    if (this.phase === "move") {
      const t = easeInOut(Math.min(1, elapsed / MOVE_MS));
      x = this.prev.x + (point.x - this.prev.x) * t;
      y = this.prev.y + (point.y - this.prev.y) * t;
    } else if (this.phase === "dwell") {
      r = DOT_RADIUS * (1 - 0.65 * Math.min(1, elapsed / DWELL_MS));
    }

    x *= width;
    y *= height;
    ctx.fillStyle = "#ff2a1f";
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    // A small center point gives the eyes something precise to rest on.
    ctx.fillStyle = "#fff";
    ctx.beginPath();
    ctx.arc(x, y, 2.5, 0, Math.PI * 2);
    ctx.fill();

    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    if (this.phase === "intro") {
      const size = Math.min(20, width / 18);
      ctx.fillStyle = "rgba(255, 255, 255, 0.85)";
      ctx.font = `600 ${size}px system-ui, sans-serif`;
      ctx.fillText("Keep your head still.", width / 2, height / 2 + 56);
      ctx.fillText("Follow the dot with your eyes.", width / 2, height / 2 + 56 + size * 1.5);
    }
    ctx.fillStyle = "rgba(255, 255, 255, 0.35)";
    ctx.font = "14px system-ui, sans-serif";
    const shown = Math.min(this.index + 1, this.total);
    ctx.fillText(`${shown} / ${this.total}`, width / 2, height - 20);
  }
}

function medianFeatures(samples) {
  const out = {};
  for (const key of FEATURE_KEYS) {
    const v = samples.map((s) => s[key]).sort((a, b) => a - b);
    const m = v.length >> 1;
    out[key] = v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
  }
  return out;
}

function easeInOut(t) {
  return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
}
