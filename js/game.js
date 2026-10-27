// The game: a red ball on black. Look at it and it jumps somewhere else.

export const GAME_MS = 15000;
const DWELL_MS = 200; // how long gaze must rest on the ball to count
const DWELL_DECAY = 0.5; // dwell drains at this rate when gaze slips off
const BALL_RADIUS = 0.045; // fraction of the smaller viewport side
const SPAWN_MS = 140;
const POP_MS = 350;
const HUD_CLEARANCE = 72; // keep the ball clear of the score and timer

export class Game {
  /** slack: extra pixels around the ball that still count as looking at it. */
  constructor(width, height, slack) {
    this.slack = slack;
    this.resize(width, height);
    this.score = 0;
    this.dwell = 0;
    this.pops = [];
    this.ball = null;
    this.startedAt = 0;
    this.lastUpdate = 0;
  }

  static ballRadius(width, height) {
    return Math.max(18, Math.min(width, height) * BALL_RADIUS);
  }

  resize(width, height) {
    this.width = width;
    this.height = height;
    this.radius = Game.ballRadius(width, height);
    if (this.ball) {
      this.ball.x = Math.min(Math.max(this.ball.x, this.#margin()), width - this.#margin());
      this.ball.y = Math.min(Math.max(this.ball.y, HUD_CLEARANCE + this.radius), height - this.#margin());
    }
  }

  start(now) {
    this.startedAt = now;
    this.lastUpdate = now;
    this.#spawn(now);
  }

  timeLeft(now) {
    return Math.max(0, GAME_MS - (now - this.startedAt));
  }

  isOver(now) {
    return this.timeLeft(now) === 0;
  }

  /** Returns true when the ball was hit this frame. */
  update(now, gaze) {
    const dt = Math.min(100, now - this.lastUpdate);
    this.lastUpdate = now;
    this.pops = this.pops.filter((p) => now - p.t < POP_MS);
    if (this.isOver(now)) return false;

    const b = this.ball;
    const inside = gaze && Math.hypot(gaze.x - b.x, gaze.y - b.y) <= this.radius + this.slack;
    this.dwell = inside ? this.dwell + dt : Math.max(0, this.dwell - dt * DWELL_DECAY);
    if (this.dwell < DWELL_MS) return false;

    this.score++;
    this.pops.push({ x: b.x, y: b.y, t: now });
    this.#spawn(now);
    return true;
  }

  draw(ctx, now) {
    for (const p of this.pops) {
      const t = (now - p.t) / POP_MS;
      ctx.strokeStyle = `rgba(255, 60, 45, ${1 - t})`;
      ctx.lineWidth = 3 * (1 - t) + 1;
      ctx.beginPath();
      ctx.arc(p.x, p.y, this.radius * (1 + 1.2 * t), 0, Math.PI * 2);
      ctx.stroke();
    }

    if (this.isOver(now)) return;
    const { x, y } = this.ball;
    const grow = Math.min(1, (now - this.ball.t) / SPAWN_MS);
    const r = this.radius * (1 - (1 - grow) ** 2);

    const g = ctx.createRadialGradient(x - r * 0.35, y - r * 0.35, r * 0.1, x, y, r);
    g.addColorStop(0, "#ff7a6e");
    g.addColorStop(0.55, "#ff2a1f");
    g.addColorStop(1, "#b80f06");
    ctx.save();
    ctx.shadowColor = "rgba(255, 42, 31, 0.55)";
    ctx.shadowBlur = r * 0.9;
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // Dwell progress ring.
    if (this.dwell > 0) {
      const a = Math.min(1, this.dwell / DWELL_MS);
      ctx.strokeStyle = "rgba(255, 255, 255, 0.85)";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(x, y, this.radius + 8, -Math.PI / 2, -Math.PI / 2 + a * Math.PI * 2);
      ctx.stroke();
    }
  }

  #margin() {
    return this.radius + 16;
  }

  // New spot, far enough away that the player has to move their eyes.
  #spawn(now) {
    const m = this.#margin();
    const minX = m;
    const maxX = this.width - m;
    const minY = HUD_CLEARANCE + this.radius;
    const maxY = this.height - m;
    const minDist = 0.3 * Math.hypot(this.width, this.height);
    const prev = this.ball;

    let best = null;
    let bestDist = -1;
    for (let i = 0; i < 30; i++) {
      const c = {
        x: minX + Math.random() * Math.max(0, maxX - minX),
        y: minY + Math.random() * Math.max(0, maxY - minY),
      };
      const d = prev ? Math.hypot(c.x - prev.x, c.y - prev.y) : Infinity;
      if (d >= minDist) {
        best = c;
        break;
      }
      if (d > bestDist) {
        best = c;
        bestDist = d;
      }
    }
    this.ball = { ...best, t: now };
    this.dwell = 0;
  }
}
