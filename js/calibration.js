// Calibration: a dot travels to a series of points. While the player looks at
// each one we record tracker features, giving (features, screen point) pairs.

import { BLINK_THRESHOLD, medianFeatures } from "./gaze.js";

const INTRO_MS = 2000; // first dot waits so the player can read the reminder
const MOVE_MS = 450; // travel time between points
const DWELL_MS = 1100; // time on each point
const SETTLE_MS = 450; // ignore the start of each dwell while the eyes land
const LATE_MS = 400; // tracking results can arrive this long after their frame
const EXTEND_MS = 1500; // on slow machines a dot waits up to this much longer for samples
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
    this.awaiting = []; // dwelled points whose last tracking results may still arrive
    this.index = 0;
    this.prev = this.queue[0];
    this.phase = "intro";
    this.phaseStart = now;
  }

  get done() {
    return this.phase === "done";
  }

  /** Adds features from a camera frame captured at time t to the dot shown then. */
  addSample(features, t) {
    if (features.blink > BLINK_THRESHOLD) return;
    const current = this.phase === "dwell" ? [this.queue[this.index]] : [];
    const point = [...current, ...this.awaiting].find((p) => t >= p.from && t <= p.to);
    point?.samples.push(features);
  }

  update(now) {
    // Judge dots once their last tracking results have had time to arrive.
    for (const point of [...this.awaiting]) {
      if (now < point.to + LATE_MS) continue;
      this.awaiting.splice(this.awaiting.indexOf(point), 1);
      if (point.samples.length >= MIN_SAMPLES) {
        this.finished.push(point);
      } else if (!point.retried) {
        // Face was lost or eyes closed: try this dot again at the end.
        this.queue.push({ x: point.x, y: point.y, samples: [], retried: true });
      }
    }

    const elapsed = now - this.phaseStart;
    if ((this.phase === "intro" && elapsed >= INTRO_MS) || (this.phase === "move" && elapsed >= MOVE_MS)) {
      const point = this.queue[this.index];
      point.from = now + SETTLE_MS;
      point.to = Infinity;
      this.#setPhase("dwell", now);
    } else if (this.phase === "dwell" && elapsed >= DWELL_MS) {
      const point = this.queue[this.index];
      // Tracking works but is slow: keep the dot up until it has enough samples.
      const slow = point.samples.length > 0 && point.samples.length < MIN_SAMPLES;
      if (slow && elapsed < DWELL_MS + EXTEND_MS) return;
      point.to = now;
      this.awaiting.push(point);
      this.prev = point;
      this.index++;
      this.#setPhase(this.index < this.queue.length ? "move" : "wait", now);
    } else if (this.phase === "wait") {
      // Out of dots: wait for the last results, which may still queue a retry.
      if (this.index < this.queue.length) this.#setPhase("move", now);
      else if (!this.awaiting.length) this.#setPhase("done", now);
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
    const point = this.queue[this.index];
    if (!point) return;
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

function easeInOut(t) {
  return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
}
