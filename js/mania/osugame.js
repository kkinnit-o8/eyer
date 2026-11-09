// osu! with your eyes: osu!standard, with your eyes as the cursor. Look at
// a circle and press any key (or click) as its approach circle closes in;
// hold the key and follow a slider's ball with your eyes; circle your eyes
// around a spinner.

import { heardTime } from "./clock.js";
import { isTapKey } from "./game.js";
import { sliderPath } from "./sliders.js";

const LEAD_IN_MS = 3000; // quiet time before the first object, to read the intro
const END_PAD_MS = 1500;
const AIM_GRACE_MS = 180; // a press waits this long for the tracker to catch up with your eyes
const FOLLOW_SCALE = 2.4; // a held slider keeps following within this many circle radii
const SPINNER_SIZE = 0.3; // spinner radius, as a share of the screen's short side
const SPIN_INNER = 0.2; // turns only count this far out from a spinner's middle (share of its radius)
const SPINS_PER_SECOND = 0.6; // turns of your eyes a spinner asks for (far fewer than a mouse)
const HIT_FADE_MS = 240;
const JUDGMENT_SHOW_MS = 600;
const SHAKE_MS = 200;
const LEARN_GAP_MS = 500; // learn where your eyes are from a hit at most this often
const STACK_LENIENCY = 0.7;
const FOLLOW_POINT_GAP = 32; // osu! pixels between follow points
const DEFAULT_COLORS = ["#ffc000", "#00ca00", "#127cff", "#f21839"];

export const OSU_JUDGMENTS = {
  great: { label: "300", color: "#7dd3fc" },
  ok: { label: "100", color: "#4ade80" },
  meh: { label: "50", color: "#fbbf24" },
  miss: { label: "Miss", color: "#f87171" },
};
const VALUES = { great: 300, ok: 100, meh: 50, miss: 0 };
// Settings: how much bigger circles are drawn, and how many approach rate
// steps slower they come in, than the map says.
export const CIRCLE_SIZES = { map: 1, bigger: 1.4, biggest: 1.8 };
export const APPROACH_SLOWER = { map: 0, slower: 2, slowest: 4 };

/**
 * The map's hit objects, in map time: { type: "circle" | "slider" |
 * "spinner", x, y, time, end, color, number, ... } in osu! pixels (512 by
 * 384). Maps without positions of their own (osu!mania, auto charts, your
 * levels) get `notes` (their one-key notes) laid out along a wandering path.
 */
export function buildOsuObjects(map, sections, notes) {
  const objects = map.mode === 0 && !map.custom && map.objects.length ? fromMap(map) : layOut(notes, sections, map);
  const colorCount = (map.colors.length ? map.colors : DEFAULT_COLORS).length;
  let color = -1;
  let number = 0;
  objects.forEach((o, i) => {
    const prev = objects[i - 1];
    if (!prev || o.newCombo || o.type === "spinner" || prev.type === "spinner") {
      color = (color + 1 + (prev ? o.colorSkip : 0)) % colorCount;
      number = 0;
    }
    o.color = color;
    o.number = ++number;
  });
  return objects;
}

/** Whether a map has real osu!standard positions (rather than laid-out ones). */
export function hasPositions(map) {
  return map.mode === 0 && !map.custom && map.objects.length > 0;
}

function fromMap(map) {
  const uninherited = map.timingPoints.filter((p) => p.uninherited);
  const timingAt = (time) => {
    let beat = uninherited[0] ?? { beatLength: 500 };
    let sv = 1;
    for (const p of map.timingPoints) {
      if (p.time > time) break;
      if (p.uninherited) {
        beat = p;
        sv = 1;
      } else if (p.beatLength < 0) {
        sv = Math.min(10, Math.max(0.1, -100 / p.beatLength));
      }
    }
    return { beatLength: beat.beatLength, sv };
  };

  return map.objects.map((raw) => {
    const o = { type: raw.type, x: raw.x, y: raw.y, time: raw.time, end: raw.time, newCombo: raw.newCombo, colorSkip: raw.colorSkip };
    if (raw.type === "spinner") return { ...o, x: 256, y: 192, end: raw.end };
    if (raw.type !== "slider") return o;

    const { beatLength, sv } = timingAt(raw.time);
    const velocity = (map.sliderMultiplier * 100 * sv) / beatLength; // osu! pixels per ms
    const path = sliderPath(raw.curve, raw.length);
    const spanMs = path.length / velocity;
    const end = raw.time + spanMs * raw.slides;
    const at = (span, d) => path.at(span % 2 ? path.length - d : d);
    // Ticks every 1/tickRate beat along each span, not right at its end.
    const ticks = [];
    const tickGap = (map.sliderMultiplier * 100 * sv) / map.tickRate;
    for (let span = 0; span < raw.slides && tickGap > 1; span++) {
      for (let d = tickGap; d < path.length - velocity * 10; d += tickGap) {
        ticks.push({ time: raw.time + span * spanMs + d / velocity, ...at(span, d) });
      }
    }
    const repeats = [];
    for (let span = 1; span < raw.slides; span++) repeats.push({ time: raw.time + span * spanMs, ...at(span, 0) });
    return {
      ...o,
      end,
      path,
      slides: raw.slides,
      spanMs,
      ticks: ticks.sort((a, b) => a.time - b.time),
      repeats,
      // Like osu!, the end is checked a little before the slider ends.
      tailTime: end - Math.min(36, (end - raw.time) / 2),
    };
  });
}

// Circles along a path that wanders around the playfield, further apart for
// longer gaps, turning gently and bouncing off the edges. A new combo
// starts each bar. Seeded by the map, so a song always lays out the same.
function layOut(notes, sections, map) {
  const rand = seeded(`${map.title}|${map.version}`);
  let x = 256;
  let y = 192;
  let angle = rand() * Math.PI * 2;
  let lastBar = null;
  return notes.map((n, i) => {
    if (i > 0) {
      // Far enough apart that even big circles barely overlap.
      const distance = Math.min(200, Math.max(100, (n.time - notes[i - 1].time) * 0.45));
      angle += (rand() - 0.5) * 2.2;
      let nx = x + Math.cos(angle) * distance;
      let ny = y + Math.sin(angle) * distance;
      if (nx < 48 || nx > 464) angle = Math.PI - angle;
      if (ny < 48 || ny > 336) angle = -angle;
      nx = x + Math.cos(angle) * distance;
      ny = y + Math.sin(angle) * distance;
      x = Math.min(464, Math.max(48, nx));
      y = Math.min(336, Math.max(48, ny));
    }
    const section = [...sections].reverse().find((s) => s.time <= n.time) ?? sections[0];
    const bar = section ? `${section.time}:${Math.floor((n.time - section.time) / (section.beatLength * section.meter))}` : i >> 3;
    const newCombo = bar !== lastBar;
    lastBar = bar;
    return { type: "circle", x, y, time: n.time, end: n.time, newCombo, colorSkip: 0 };
  });
}

/** An object with its times moved by toGame (practice speed and start). */
export function retimeObject(o, toGame) {
  const r = { ...o, time: toGame(o.time), end: toGame(o.end) };
  if (o.type === "slider") {
    r.spanMs = toGame(o.time + o.spanMs) - r.time;
    r.ticks = o.ticks.map((t) => ({ ...t, time: toGame(t.time) }));
    r.repeats = o.repeats.map((t) => ({ ...t, time: toGame(t.time) }));
    r.tailTime = toGame(o.tailTime);
  }
  return r;
}

function preemptFor(ar) {
  return ar < 5 ? 1200 + (600 * (5 - ar)) / 5 : 1200 - (750 * (ar - 5)) / 5;
}

export class OsuGame {
  /**
   * objects: from buildOsuObjects (in game time). colors: the map's combo
   * colors. size: how much bigger to draw circles than the map says;
   * slower: approach rate steps slower than the map. slack: how much
   * further than a circle's edge your gaze may land (tracking error, in
   * screen pixels). onLook(x, y, perf, look) reports that you were looking
   * at (x, y) around perf.
   */
  constructor({
    objects, colors, cs, ar, od, size = 1, slower = 0, slack = 0, audio, buffer, audioFrom = 0, rate = 1,
    offsetMs = 0, autoplay = false, onLook, width, height, leadInMs = LEAD_IN_MS,
  }) {
    this.kind = "osu";
    this.audio = audio;
    this.buffer = buffer;
    this.audioFrom = audioFrom;
    this.rate = rate;
    this.offsetMs = offsetMs;
    this.autoplay = autoplay;
    this.onLook = onLook;
    this.leadInMs = leadInMs;
    this.colors = colors.length ? colors : DEFAULT_COLORS;
    this.size = size;
    this.slack = slack;
    this.osuRadius = 54.4 - 4.48 * cs;
    this.preempt = preemptFor(Math.max(0, ar - slower));
    this.fadeIn = Math.min(400, this.preempt * 0.66);
    this.windows = { great: 80 - 6 * od, ok: 140 - 8 * od, meh: 200 - 10 * od };

    this.objects = objects.map((o) => ({ ...o, head: null, result: null, parts: 0, partsHit: 0, spin: 0 }));
    this.#stack();
    this.next = 0; // first object not yet done
    this.held = new Set();
    this.pending = []; // presses waiting for the tracker to catch up: { perf, at }
    this.gaze = null;
    this.aimed = null; // the object your gaze is on
    this.lastLearn = -Infinity;
    this.counts = { great: 0, ok: 0, meh: 0, miss: 0 };
    this.combo = 0;
    this.maxCombo = 0;
    this.score = 0;
    this.now = -Infinity;
    const first = this.objects[0];
    this.firstEvent = first ? first.time - this.preempt : 0;
    this.endTime = this.objects.reduce((t, o) => Math.max(t, o.end), 0) + END_PAD_MS;
    this.resize(width, height);
  }

  // Objects at the same spot shortly after each other are nudged down and
  // right, so you can see there's more than one.
  #stack() {
    let depth = 0;
    this.objects.forEach((o, i) => {
      const prev = this.objects[i - 1];
      const same =
        prev && o.type !== "spinner" && prev.type !== "spinner" &&
        Math.hypot(o.x - prev.x, o.y - prev.y) < 3 && o.time - prev.end < this.preempt * STACK_LENIENCY;
      depth = same ? depth + 1 : 0;
      o.offset = depth * this.osuRadius * 0.1;
    });
  }

  resize(width, height) {
    // The playfield is as big as fits with a circle's room around it.
    const r = this.osuRadius * this.size;
    this.scale = Math.min(width / (512 + 2 * r), height / (384 + 2 * r)) * 0.96;
    this.ox = (width - 512 * this.scale) / 2;
    this.oy = (height - 384 * this.scale) / 2;
    this.width = width;
    this.height = height;
    this.radius = r * this.scale;
    this.reach = this.radius + this.slack;
    this.spinnerRadius = SPINNER_SIZE * Math.min(width, height);
  }

  #screen(p, offset = 0) {
    return { x: this.ox + (p.x + offset) * this.scale, y: this.oy + (p.y + offset) * this.scale };
  }

  // ---- Song -------------------------------------------------------------

  start() {
    const leadIn = Math.max(0, this.leadInMs - this.firstEvent) / 1000;
    this.gain = this.audio.createGain();
    this.gain.connect(this.audio.destination);
    this.source = this.audio.createBufferSource();
    this.source.buffer = this.buffer;
    this.source.playbackRate.value = this.rate;
    this.source.connect(this.gain);
    this.startAt = this.audio.currentTime + 0.1 + leadIn;
    this.source.start(this.startAt, this.audioFrom / 1000);
  }

  stop() {
    if (!this.source) return;
    const t = this.audio.currentTime;
    this.gain.gain.setValueAtTime(this.gain.gain.value, t);
    this.gain.gain.linearRampToValueAtTime(0, t + 0.3);
    this.source.stop(t + 0.35);
    this.source = null;
  }

  songTime(perf) {
    return (heardTime(this.audio, perf) - this.startAt) * 1000 - this.offsetMs;
  }

  isOver() {
    return this.now > this.endTime;
  }

  get accuracy() {
    const c = this.counts;
    const total = c.great + c.ok + c.meh + c.miss;
    return total ? (300 * c.great + 100 * c.ok + 50 * c.meh) / (300 * total) : 1;
  }

  // ---- Input ------------------------------------------------------------

  /** Any key plays (see isTapKey), and so does a click. */
  laneOf(e) {
    return isTapKey(e) ? 0 : -1;
  }

  heldLane(key) {
    return this.held.has(key) ? 0 : -1;
  }

  keyDown(lane, perf, key = "key") {
    if (this.autoplay || this.held.has(key)) return;
    this.held.add(key);
    this.pending.push({ perf, at: this.songTime(perf) });
    this.#applyPresses(perf);
  }

  keyUp(lane, perf, key = "key") {
    this.held.delete(key);
  }

  releaseAll() {
    this.held.clear();
  }

  // The object a press goes to: the earliest that still needs one (osu!
  // won't let you hit a later circle while an earlier one is waiting).
  #pressTarget() {
    for (let i = this.next; i < this.objects.length; i++) {
      const o = this.objects[i];
      if (o.type !== "spinner" && !o.head) return o.time - this.preempt <= this.now ? o : null;
    }
    return null;
  }

  // Presses are judged at the moment they happened, but get a moment for
  // the tracker (which runs a little behind your eyes) to put your gaze on
  // the circle.
  #applyPresses(perf) {
    while (this.pending.length) {
      const press = this.pending[0];
      const target = this.#pressTarget();
      if (!target || perf - press.perf > AIM_GRACE_MS) {
        this.pending.shift();
        continue;
      }
      const error = press.at - target.time;
      if (-error > this.windows.meh) {
        // Far too early: the circle shakes, nothing else happens.
        target.shakeAt = this.now;
        this.pending.shift();
        continue;
      }
      if (!this.#onTarget(target)) return; // wait for the gaze
      this.pending.shift();
      const judgment = Math.abs(error) <= this.windows.great ? "great" : Math.abs(error) <= this.windows.ok ? "ok" : "meh";
      this.#hitHead(target, judgment, press.at);
      if (!this.autoplay && press.perf - this.lastLearn > LEARN_GAP_MS) {
        // Your eyes were on this circle as you pressed: a free calibration point.
        this.lastLearn = press.perf;
        const { x, y } = this.#screen(target, target.offset);
        this.onLook?.(x, y, press.perf, { from: -150, to: 50, near: this.reach });
      }
    }
  }

  #onTarget(o) {
    if (!this.gaze) return false;
    const p = this.#screen(o, o.offset);
    return Math.hypot(this.gaze.x - p.x, this.gaze.y - p.y) <= this.reach;
  }

  // ---- Judging ----------------------------------------------------------

  #hitHead(o, judgment, at) {
    o.head = judgment;
    o.headAt = at;
    o.parts++;
    if (judgment === "miss") {
      this.#breakCombo();
    } else {
      o.partsHit++;
      this.#addCombo();
    }
    if (o.type === "circle") this.#finishObject(o, judgment, at);
  }

  #finishObject(o, judgment, at) {
    o.result = judgment;
    o.resultAt = at;
    o.done = true;
    this.counts[judgment]++;
    if (judgment === "miss") this.#breakCombo();
    else this.score += VALUES[judgment] * (1 + this.combo / 25);
  }

  #addCombo() {
    this.maxCombo = Math.max(this.maxCombo, ++this.combo);
  }

  #breakCombo() {
    this.combo = 0;
  }

  update(perf, gaze) {
    this.perf = perf;
    const now = this.songTime(perf);
    this.now = now;
    this.gaze = this.autoplay ? this.#autoCursor(now) : gaze;
    this.#applyPresses(perf);

    for (let i = this.next; i < this.objects.length; i++) {
      const o = this.objects[i];
      if (o.time - this.preempt > now) break;
      if (o.done) continue;
      if (o.type === "spinner") {
        this.#updateSpinner(o, now);
        continue;
      }
      if (!o.head) {
        if (this.autoplay && now >= o.time) this.#hitHead(o, "great", o.time);
        else if (now > o.time + this.windows.meh) this.#hitHead(o, "miss", now);
      }
      if (o.type === "slider") this.#updateSlider(o, now);
    }
    while (this.objects[this.next]?.done) this.next++;
    const target = this.#pressTarget();
    this.aimed = target && this.#onTarget(target) ? target : null;
  }

  // A slider's ball has to be followed (gaze on it, a key held) at each
  // tick, each repeat and the end. Missing a tick or repeat breaks the
  // combo. At the end it's judged by how much of it you got, like osu!.
  #updateSlider(o, now) {
    if (now < o.time) return;
    const ball = this.#screen(this.#ballAt(o, now), o.offset);
    const distance = this.gaze ? Math.hypot(this.gaze.x - ball.x, this.gaze.y - ball.y) : Infinity;
    const holding = this.autoplay || this.held.size > 0;
    // You start following once you're on the ball, and can then stray a little.
    o.following = holding && distance <= (o.following ? FOLLOW_SCALE * this.radius + this.slack : this.reach);

    o.tick ??= 0;
    o.repeat ??= 0;
    while (o.tick < o.ticks.length && o.ticks[o.tick].time <= now) {
      o.tick++;
      this.#sliderPart(o, 10, true);
    }
    while (o.repeat < o.repeats.length && o.repeats[o.repeat].time <= now) {
      o.repeat++;
      this.#sliderPart(o, 30, true);
    }
    if (!o.tailDone && now >= o.tailTime) {
      // Like osu!, letting go before the end costs points but not the combo.
      o.tailDone = true;
      this.#sliderPart(o, 30, false);
    }
    if (now >= o.end && o.tailDone) {
      const share = o.partsHit / o.parts;
      this.#finishObject(o, share >= 1 ? "great" : share >= 0.5 ? "ok" : share > 0 ? "meh" : "miss", o.end);
    }
  }

  #sliderPart(o, value, breaks) {
    o.parts++;
    if (o.following) {
      o.partsHit++;
      this.#addCombo();
      this.score += value;
    } else if (breaks) {
      this.#breakCombo();
    }
  }

  // Spinners turn with your eyes: circle them around its middle. Only the
  // net turning counts, so it has to be one way round.
  #updateSpinner(o, now) {
    if (now < o.time) return;
    const centre = this.#screen(o);
    if (this.gaze && now <= o.end) {
      const dx = this.gaze.x - centre.x;
      const dy = this.gaze.y - centre.y;
      if (Math.hypot(dx, dy) > SPIN_INNER * this.spinnerRadius) {
        const angle = Math.atan2(dy, dx);
        if (o.lastAngle !== undefined) {
          let delta = angle - o.lastAngle;
          if (delta > Math.PI) delta -= 2 * Math.PI;
          if (delta < -Math.PI) delta += 2 * Math.PI;
          o.spin += delta;
        }
        o.lastAngle = angle;
      }
    }
    o.needed = Math.max(1, ((o.end - o.time) / 1000) * SPINS_PER_SECOND);
    if (now > o.end) {
      const share = Math.abs(o.spin) / (2 * Math.PI) / o.needed;
      const judgment = share >= 1 ? "great" : share >= 0.5 ? "ok" : share >= 0.25 ? "meh" : "miss";
      if (judgment !== "miss") this.#addCombo();
      this.#finishObject(o, judgment, o.end);
    }
  }

  #ballAt(o, now) {
    const t = Math.min(Math.max(0, now - o.time), o.end - o.time);
    const span = Math.min(o.slides - 1, Math.floor(t / o.spanMs));
    const f = (t - span * o.spanMs) / o.spanMs;
    return o.path.at((span % 2 ? 1 - f : f) * o.path.length);
  }

  #endOf(o) {
    if (o.type !== "slider") return o;
    return o.path.at(o.slides % 2 ? o.path.length : 0);
  }

  // Autoplay's cursor: glides from object to object, rides sliders and
  // circles spinners.
  #autoCursor(now) {
    let prev = null;
    let next = null;
    for (const o of this.objects) {
      if (o.time <= now) prev = o;
      else {
        next = o;
        break;
      }
    }
    if (prev && now <= prev.end) {
      if (prev.type === "slider") return this.#screen(this.#ballAt(prev, now), prev.offset);
      if (prev.type === "spinner") {
        const c = this.#screen(prev);
        const a = ((now - prev.time) / 1000) * Math.PI * 2 * 1.5;
        return { x: c.x + Math.cos(a) * this.spinnerRadius * 0.6, y: c.y + Math.sin(a) * this.spinnerRadius * 0.6 };
      }
    }
    if (!next) return prev ? this.#screen(this.#endOf(prev), prev.offset) : null;
    const to = this.#screen(next, next.offset);
    if (!prev) return to;
    const from = this.#screen(this.#endOf(prev), prev.offset);
    const span = next.time - prev.end;
    const f = span > 0 ? Math.min(1, Math.max(0, (now - prev.end) / Math.min(span, 400))) : 1;
    const e = f * f * (3 - 2 * f);
    return { x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e };
  }

  results() {
    const c = this.counts;
    const total = c.great + c.ok + c.meh + c.miss;
    const share = total ? c.great / total : 1;
    const grade =
      share === 1 ? "SS"
      : share > 0.9 && c.meh <= total * 0.01 && !c.miss ? "S"
      : (share > 0.8 && !c.miss) || share > 0.9 ? "A"
      : (share > 0.7 && !c.miss) || share > 0.8 ? "B"
      : share > 0.6 ? "C" : "D";
    return {
      accuracy: this.accuracy,
      maxCombo: this.maxCombo,
      counts: { ...c },
      judgments: OSU_JUDGMENTS,
      score: Math.round(this.score),
      grade,
      eyes: { total: 0 },
    };
  }

  // ---- Drawing ----------------------------------------------------------

  draw(ctx) {
    const now = this.now;
    // Earlier objects sit on top of later ones, so draw from the back.
    const shown = [];
    for (let i = Math.max(0, this.next - 12); i < this.objects.length; i++) {
      const o = this.objects[i];
      if (o.time - this.preempt > now) break;
      if (o.done && now - o.resultAt > JUDGMENT_SHOW_MS) continue;
      shown.push(o);
    }
    this.#drawFollowPoints(ctx, now);
    for (const o of shown.reverse()) {
      if (o.type === "spinner") this.#drawSpinner(ctx, o, now);
      else if (o.type === "slider") this.#drawSlider(ctx, o, now);
      else this.#drawCircleObject(ctx, o, now);
    }
    for (const o of shown) if (o.done) this.#drawJudgment(ctx, o, now);
    this.#drawHud(ctx, now);
    if (now < this.firstEvent) this.#drawIntro(ctx, now);
  }

  #color(o) {
    return this.colors[o.color % this.colors.length];
  }

  #alpha(o, now) {
    return Math.min(1, Math.max(0, (now - (o.time - this.preempt)) / this.fadeIn));
  }

  #drawCircleObject(ctx, o, now) {
    const p = this.#screen(o, o.offset);
    if (o.done) {
      // Hit: grows and fades. Missed: fades where it was.
      const f = (now - o.resultAt) / HIT_FADE_MS;
      if (f >= 1) return;
      ctx.globalAlpha = 1 - f;
      this.#hitCircle(ctx, p, o, o.result === "miss" ? 1 : 1 + 0.4 * f);
      ctx.globalAlpha = 1;
      return;
    }
    ctx.globalAlpha = this.#alpha(o, now);
    this.#hitCircle(ctx, this.#shaken(p, o, now), o, 1);
    this.#approachCircle(ctx, p, o, now);
    ctx.globalAlpha = 1;
  }

  #shaken(p, o, now) {
    const t = now - (o.shakeAt ?? -Infinity);
    return t < SHAKE_MS ? { x: p.x + Math.sin(t / 15) * 8 * (1 - t / SHAKE_MS), y: p.y } : p;
  }

  #hitCircle(ctx, p, o, scale) {
    const r = this.radius * scale;
    circle(ctx, p.x, p.y, r);
    ctx.fillStyle = shade(this.#color(o), 0.75);
    ctx.fill();
    ctx.lineWidth = Math.max(2, r * 0.11);
    ctx.strokeStyle = "#ffffff";
    ctx.stroke();
    // Your gaze is on it: it lights up, so you know your aim counts.
    if (this.aimed === o) {
      ctx.save();
      ctx.shadowColor = "#ffffff";
      ctx.shadowBlur = 18;
      circle(ctx, p.x, p.y, r + 5);
      ctx.strokeStyle = "rgba(255, 255, 255, 0.9)";
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.restore();
    }
    ctx.fillStyle = "#ffffff";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = `700 ${Math.round(r * 0.8)}px system-ui, sans-serif`;
    ctx.fillText(String(o.number), p.x, p.y + r * 0.04);
  }

  #approachCircle(ctx, p, o, now) {
    if (now >= o.time) return;
    const f = (o.time - now) / this.preempt;
    circle(ctx, p.x, p.y, this.radius * (1 + 2.5 * f));
    ctx.strokeStyle = this.#color(o);
    ctx.lineWidth = 3;
    ctx.stroke();
  }

  #drawSlider(ctx, o, now) {
    const fadeOut = o.done ? 1 - (now - o.resultAt) / HIT_FADE_MS : 1;
    if (fadeOut <= 0) return;
    const alpha = this.#alpha(o, now) * fadeOut;
    ctx.globalAlpha = alpha;

    // Body: a white-edged track in a dark shade of the combo color.
    const steps = Math.max(2, Math.ceil(o.path.length / 6));
    ctx.beginPath();
    for (let i = 0; i <= steps; i++) {
      const q = this.#screen(o.path.at((o.path.length * i) / steps), o.offset);
      if (i) ctx.lineTo(q.x, q.y);
      else ctx.moveTo(q.x, q.y);
    }
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = this.radius * 2;
    ctx.stroke();
    ctx.strokeStyle = "#101010";
    ctx.lineWidth = this.radius * 1.78;
    ctx.stroke();
    ctx.strokeStyle = withAlpha(this.#color(o), 0.35);
    ctx.stroke();

    // Ticks still to come, and an arrow where it turns back next.
    ctx.fillStyle = "#ffffff";
    for (let i = o.tick ?? 0; i < o.ticks.length; i++) {
      const t = this.#screen(o.ticks[i], o.offset);
      circle(ctx, t.x, t.y, Math.max(2.5, this.radius * 0.1));
      ctx.fill();
    }
    const repeat = o.repeats[o.repeat ?? 0];
    if (repeat) this.#drawRepeatArrow(ctx, o, repeat, now);

    const start = this.#screen(o, o.offset);
    if (now < o.time || !o.head) {
      this.#hitCircle(ctx, this.#shaken(start, o, now), o, 1);
      this.#approachCircle(ctx, start, o, now);
    }
    if (now >= o.time && !o.done) {
      // The ball, and the follow circle while you're following it.
      const b = this.#screen(this.#ballAt(o, now), o.offset);
      circle(ctx, b.x, b.y, this.radius * 0.85);
      ctx.fillStyle = this.#color(o);
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.strokeStyle = "#ffffff";
      ctx.stroke();
      circle(ctx, b.x, b.y, this.radius * (o.following ? FOLLOW_SCALE : 1.1));
      ctx.strokeStyle = o.following ? "rgba(255, 255, 255, 0.85)" : "rgba(255, 255, 255, 0.25)";
      ctx.lineWidth = o.following ? 4 : 2;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  // A chevron at the end the ball turns around at, pointing back along it.
  #drawRepeatArrow(ctx, o, repeat, now) {
    const p = this.#screen(repeat, o.offset);
    const back = o.repeat % 2 ? 6 : o.path.length - 6;
    const q = this.#screen(o.path.at(back), o.offset);
    const a = Math.atan2(q.y - p.y, q.x - p.x);
    const s = this.radius * 0.45;
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(a);
    ctx.beginPath();
    ctx.moveTo(s * 0.6, 0);
    ctx.lineTo(-s * 0.4, -s * 0.6);
    ctx.moveTo(s * 0.6, 0);
    ctx.lineTo(-s * 0.4, s * 0.6);
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 4;
    ctx.lineCap = "round";
    ctx.stroke();
    ctx.restore();
  }

  #drawSpinner(ctx, o, now) {
    const c = this.#screen(o);
    const R = this.spinnerRadius;
    const fadeOut = o.done ? 1 - (now - o.resultAt) / HIT_FADE_MS : 1;
    if (fadeOut <= 0) return;
    ctx.globalAlpha = this.#alpha(o, now) * fadeOut;
    circle(ctx, c.x, c.y, R);
    ctx.fillStyle = "rgba(255, 255, 255, 0.05)";
    ctx.fill();
    ctx.strokeStyle = "rgba(255, 255, 255, 0.8)";
    ctx.lineWidth = 4;
    ctx.stroke();
    // Time left: a ring shrinking to the middle.
    const left = Math.min(1, Math.max(0, (o.end - now) / (o.end - o.time)));
    if (now >= o.time) {
      circle(ctx, c.x, c.y, R * left);
      ctx.strokeStyle = "rgba(125, 211, 252, 0.8)";
      ctx.lineWidth = 3;
      ctx.stroke();
    }
    // How far you've turned: an arc around the edge, full when it's enough.
    const done = Math.min(1, Math.abs(o.spin) / (2 * Math.PI) / (o.needed ?? 1));
    if (done > 0) {
      ctx.beginPath();
      ctx.arc(c.x, c.y, R + 10, -Math.PI / 2, -Math.PI / 2 + done * Math.PI * 2);
      ctx.strokeStyle = done >= 1 ? "#4ade80" : "#ffffff";
      ctx.lineWidth = 8;
      ctx.stroke();
    }
    ctx.fillStyle = "#ffffff";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = "700 24px system-ui, sans-serif";
    ctx.fillText(done >= 1 ? "Clear!" : "Circle your eyes around!", c.x, c.y - 14);
    ctx.font = "16px system-ui, sans-serif";
    ctx.fillText(`${(Math.abs(o.spin) / (2 * Math.PI)).toFixed(1)} / ${Math.ceil(o.needed ?? 1)} turns`, c.x, c.y + 16);
    ctx.globalAlpha = 1;
  }

  // Dots from one object to the next in a combo, so your eyes know where to
  // go next.
  #drawFollowPoints(ctx, now) {
    for (let i = Math.max(1, this.next); i < this.objects.length; i++) {
      const b = this.objects[i];
      if (b.time - this.preempt > now) break;
      const a = this.objects[i - 1];
      if (b.newCombo || a.type === "spinner" || b.type === "spinner" || now > b.time) continue;
      const from = this.#screen(this.#endOf(a), a.offset);
      const to = this.#screen(b, b.offset);
      const length = Math.hypot(to.x - from.x, to.y - from.y);
      const gap = FOLLOW_POINT_GAP * this.scale;
      if (length < this.radius * 2.5) continue;
      ctx.fillStyle = "rgba(255, 255, 255, 0.5)";
      for (let d = this.radius * 1.2; d < length - this.radius * 1.2; d += gap) {
        const f = d / length;
        // Each dot shows up in turn, as if heading to the next circle.
        const appear = a.end + (b.time - a.end) * f - this.preempt;
        const alpha = Math.min(1, Math.max(0, (now - appear) / 200));
        if (alpha <= 0) continue;
        ctx.globalAlpha = alpha * 0.8;
        circle(ctx, from.x + (to.x - from.x) * f, from.y + (to.y - from.y) * f, 3);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
  }

  // 100s, 50s and misses show where they happened (300s don't, like osu!).
  #drawJudgment(ctx, o, now) {
    if (o.result === "great") return;
    const t = (now - o.resultAt) / JUDGMENT_SHOW_MS;
    if (t >= 1) return;
    const p = o.type === "spinner" ? this.#screen(o) : this.#screen(this.#endOf(o), o.offset);
    const j = OSU_JUDGMENTS[o.result];
    ctx.globalAlpha = 1 - t;
    ctx.fillStyle = j.color;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = `800 ${Math.round(this.radius * 0.7)}px system-ui, sans-serif`;
    ctx.fillText(o.result === "miss" ? "✕" : j.label, p.x, p.y - t * 12);
    ctx.globalAlpha = 1;
  }

  #drawHud(ctx, now) {
    const { width, height } = this;
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = "#ffffff";
    ctx.textAlign = "right";
    ctx.font = "700 30px system-ui, sans-serif";
    ctx.fillText(String(Math.round(this.score)).padStart(8, "0"), width - 20, 42);
    ctx.font = "600 18px system-ui, sans-serif";
    ctx.fillStyle = "rgba(255, 255, 255, 0.8)";
    ctx.fillText(`${(this.accuracy * 100).toFixed(2)}%`, width - 20, 68);
    ctx.textAlign = "left";
    ctx.fillStyle = "#ffffff";
    ctx.font = "700 36px system-ui, sans-serif";
    ctx.fillText(`${this.combo}x`, 20, height - 20);
    // How far into the song.
    const progress = Math.min(1, Math.max(0, now / (this.endTime - END_PAD_MS)));
    ctx.fillStyle = "rgba(255, 255, 255, 0.15)";
    ctx.fillRect(0, 0, width, 4);
    ctx.fillStyle = "rgba(255, 255, 255, 0.6)";
    ctx.fillRect(0, 0, width * progress, 4);
  }

  #drawIntro(ctx, now) {
    const { width, height } = this;
    ctx.globalAlpha = Math.min(1, (this.firstEvent - now) / 500);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#ffffff";
    ctx.font = "700 26px system-ui, sans-serif";
    ctx.fillText("osu! with your eyes", width / 2, height * 0.3);
    ctx.font = "18px system-ui, sans-serif";
    ctx.fillStyle = "rgba(255, 255, 255, 0.85)";
    const lines = [
      "Look at a circle and press any key (or click) as its ring closes in",
      "Sliders: hold the key and follow the ball with your eyes",
      "Spinners: circle your eyes around the middle",
      "A circle lights up when your eyes are on it · G shows where the tracker thinks you look",
    ];
    lines.forEach((line, i) => ctx.fillText(line, width / 2, height * 0.3 + 44 + i * 30));
    ctx.globalAlpha = 1;
  }
}

function circle(ctx, x, y, r) {
  ctx.beginPath();
  ctx.arc(x, y, Math.max(0, r), 0, Math.PI * 2);
}

// A darker or lighter version of a "#rrggbb" color (factor < 1 darkens).
function shade(hex, factor) {
  const n = parseInt(hex.slice(1), 16);
  const c = [n >> 16, (n >> 8) & 255, n & 255].map((v) => Math.round(Math.min(255, v * factor)));
  return `rgb(${c.join(", ")})`;
}

function withAlpha(hex, alpha) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

// A small seeded random number generator (mulberry32), from a string.
function seeded(text) {
  let a = 0;
  for (const ch of text) a = (Math.imul(a, 31) + ch.charCodeAt(0)) | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
