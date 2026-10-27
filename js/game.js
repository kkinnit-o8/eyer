// The game: a red ball on black. Look at it and it instantly jumps somewhere
// else.

export const GAME_MS = 15000;
const BALL_RADIUS = 0.045; // fraction of the smaller viewport side
const POP_MS = 250;
const HUD_CLEARANCE = 72; // keep the ball clear of the score and timer

export class Game {
  /** slack: extra pixels around the ball that still count as looking at it. */
  constructor(width, height, slack) {
    this.slack = slack;
    this.resize(width, height);
    this.score = 0;
    this.pops = [];
    this.ball = null;
    this.startedAt = 0;
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
    this.#spawn();
  }

  timeLeft(now) {
    return Math.max(0, GAME_MS - (now - this.startedAt));
  }

  isOver(now) {
    return this.timeLeft(now) === 0;
  }

  /** Returns true when the ball was hit this frame. */
  update(now, gaze) {
    this.pops = this.pops.filter((p) => now - p.t < POP_MS);
    if (this.isOver(now) || !gaze) return false;

    const b = this.ball;
    if (Math.hypot(gaze.x - b.x, gaze.y - b.y) > this.radius + this.slack) return false;

    this.score++;
    this.pops.push({ x: b.x, y: b.y, t: now });
    this.#spawn();
    return true;
  }

  draw(ctx, now) {
    for (const p of this.pops) {
      const t = (now - p.t) / POP_MS;
      ctx.strokeStyle = `rgba(255, 60, 45, ${1 - t})`;
      ctx.lineWidth = 2 * (1 - t) + 1;
      ctx.beginPath();
      ctx.arc(p.x, p.y, this.radius * (1 + 1.2 * t), 0, Math.PI * 2);
      ctx.stroke();
    }

    if (this.isOver(now)) return;
    const { x, y } = this.ball;
    const r = this.radius;

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
  }

  #margin() {
    return this.radius + 16;
  }

  // New spot, far enough away that the player has to move their eyes.
  #spawn() {
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
    this.ball = best;
  }
}
