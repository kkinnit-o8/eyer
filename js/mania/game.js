// Peripheral mania: 4-key notes fall down the middle of the screen, but your
// eyes belong on the circles that land in the corners on the beat. Stare at
// the middle and the notes disappear.

import { LANES } from "./chart.js";

export const KEY_CODES = ["KeyD", "KeyF", "KeyJ", "KeyK"];
const KEY_LABELS = ["D", "F", "J", "K"];
const LANE_COLORS = ["#f2f2f2", "#5aa9ff", "#5aa9ff", "#f2f2f2"];

const CENTER_GRACE_MS = 300; // sweeping across the middle is fine; staring isn't
const LOOK_EARLY_MS = 250; // a corner counts from this long before its beat
const LOOK_ON_BEAT_MS = 350; // and is "on beat" until this long after (covers tracker lag)
const TARGET_LINGER_MS = 1500; // how long the last circle stays up
const LEAD_IN_MS = 2500; // quiet time before the first note or circle
const END_PAD_MS = 1500;
const FLASH_MS = 200;

export const JUDGMENTS = {
  perfect: { label: "Perfect", color: "#ffffff" },
  great: { label: "Great", color: "#fde047" },
  good: { label: "Good", color: "#4ade80" },
  ok: { label: "OK", color: "#60a5fa" },
  meh: { label: "Meh", color: "#a3a3a3" },
  miss: { label: "Miss", color: "#f87171" },
};
const HIT_ORDER = ["perfect", "great", "good", "ok", "meh"];
const LOOK_COLORS = { onBeat: "#4ade80", late: "#fbbf24", missed: "#6b6b6b" };

// osu!mania hit windows (ms either side) for an Overall Difficulty.
function hitWindows(od) {
  return { perfect: 16, great: 64 - 3 * od, good: 97 - 3 * od, ok: 127 - 3 * od, meh: 151 - 3 * od, miss: 188 - 3 * od };
}

function judge(error, windows) {
  return HIT_ORDER.find((j) => error <= windows[j]) ?? "miss";
}

export class ManiaGame {
  constructor({ notes, targets, od, audio, buffer, scrollMs, offsetMs, autoplay, width, height }) {
    this.audio = audio;
    this.buffer = buffer;
    this.scrollMs = scrollMs;
    this.offsetMs = offsetMs;
    this.autoplay = autoplay;
    this.windows = hitWindows(od);

    this.lanes = Array.from({ length: LANES }, () => []);
    for (const n of notes) this.lanes[n.lane].push({ ...n, head: null, tail: null });
    this.next = new Array(LANES).fill(0); // first note per lane whose head is unjudged
    this.holds = new Array(LANES).fill(null); // hold note being held, per lane
    this.pressed = new Array(LANES).fill(false);
    this.autoRelease = new Array(LANES).fill(0);
    this.flashes = new Array(LANES).fill(null);

    // Each circle appears one gap (at most a second) before its beat.
    this.targets = targets.map((t, i) => ({
      ...t,
      approach: Math.min(1000, i ? t.time - targets[i - 1].time : 1000),
      result: null,
    }));
    this.nextTarget = 0;

    this.counts = Object.fromEntries(Object.keys(JUDGMENTS).map((j) => [j, 0]));
    this.combo = 0;
    this.maxCombo = 0;
    this.lastJudgment = null;
    this.eyes = { onBeat: 0, late: 0, missed: 0, centerMs: 0 };
    this.centerFor = 0;
    this.blinded = false;
    this.now = -Infinity;
    this.lastNow = null;

    const first = this.targets[0];
    this.eyesFrom = first ? first.time - first.approach : Infinity;
    this.eyesUntil = first ? this.targets[this.targets.length - 1].time + TARGET_LINGER_MS : -Infinity;
    const lastNote = notes.reduce((t, n) => Math.max(t, n.end ?? n.time), 0);
    this.endTime = Math.max(lastNote, this.eyesUntil) + END_PAD_MS;
    this.firstEvent = Math.min(notes.length ? notes[0].time - scrollMs : Infinity, this.eyesFrom);
    this.introUntil = Number.isFinite(this.eyesFrom) ? this.eyesFrom : this.firstEvent;
    this.resize(width, height);
  }

  resize(width, height) {
    const short = Math.min(width, height);
    const laneW = Math.round(Math.min(100, Math.max(56, width * 0.055)));
    const left = Math.round(width / 2 - laneW * 2);
    this.layout = {
      width,
      height,
      laneW,
      left,
      right: left + laneW * LANES,
      hitY: Math.round(height - Math.max(90, height * 0.14)),
      inset: Math.min(140, Math.max(56, short * 0.12)),
      targetR: Math.min(44, Math.max(22, short * 0.045)),
    };
  }

  start() {
    const leadIn = Math.max(0, LEAD_IN_MS - this.firstEvent) / 1000;
    this.gain = this.audio.createGain();
    this.gain.connect(this.audio.destination);
    this.source = this.audio.createBufferSource();
    this.source.buffer = this.buffer;
    this.source.connect(this.gain);
    this.startAt = this.audio.currentTime + 0.1 + leadIn;
    this.source.start(this.startAt);
  }

  stop() {
    if (!this.source) return;
    const t = this.audio.currentTime;
    this.gain.gain.setValueAtTime(this.gain.gain.value, t);
    this.gain.gain.linearRampToValueAtTime(0, t + 0.3);
    this.source.stop(t + 0.35);
    this.source = null;
  }

  /** Song position in ms at a performance.now() time, from the audio clock. */
  songTime(perf) {
    const ts = this.audio.getOutputTimestamp?.();
    const contextTime =
      ts && ts.performanceTime > 0
        ? ts.contextTime + (perf - ts.performanceTime) / 1000
        : this.audio.currentTime - (this.audio.outputLatency || this.audio.baseLatency || 0);
    return (contextTime - this.startAt) * 1000 - this.offsetMs;
  }

  isOver() {
    return this.now > this.endTime;
  }

  get accuracy() {
    const c = this.counts;
    const total = c.perfect + c.great + c.good + c.ok + c.meh + c.miss;
    if (!total) return 1;
    return (300 * (c.perfect + c.great) + 200 * c.good + 100 * c.ok + 50 * c.meh) / (300 * total);
  }

  keyDown(lane, perf) {
    if (this.autoplay || this.pressed[lane]) return;
    this.pressed[lane] = true;
    const now = this.songTime(perf);
    const note = this.lanes[lane][this.next[lane]];
    if (!note || note.time - now > this.windows.miss) return; // nothing close: ghost tap
    this.next[lane]++;
    note.head = judge(Math.abs(now - note.time), this.windows);
    this.#record(note.head, lane, now);
    if (note.end === null) return;
    if (note.head === "miss") {
      note.tail = "miss";
      this.#record("miss", lane, now);
    } else {
      this.holds[lane] = note;
    }
  }

  keyUp(lane, perf) {
    if (this.autoplay) return;
    this.pressed[lane] = false;
    const note = this.holds[lane];
    if (!note) return;
    this.holds[lane] = null;
    const now = this.songTime(perf);
    // Releases are judged 1.5x more leniently than presses.
    note.tail = judge(Math.max(0, note.end - now) / 1.5, this.windows);
    this.#record(note.tail, lane, now);
  }

  update(perf, gaze) {
    const now = this.songTime(perf);
    const dt = this.lastNow === null ? 0 : Math.min(100, Math.max(0, now - this.lastNow));
    this.now = this.lastNow = now;
    if (this.autoplay) {
      this.#autoplay(now);
      gaze = this.#autoGaze(now);
    }

    for (let lane = 0; lane < LANES; lane++) {
      const q = this.lanes[lane];
      while (q[this.next[lane]] && now - q[this.next[lane]].time > this.windows.meh) {
        const note = q[this.next[lane]++];
        note.head = "miss";
        this.#record("miss", lane, now);
        if (note.end !== null) {
          note.tail = "miss";
          this.#record("miss", lane, now);
        }
      }
      const hold = this.holds[lane];
      if (hold && now >= hold.end) {
        hold.tail = "perfect";
        this.#record("perfect", lane, now);
        this.holds[lane] = null;
      }
    }
    this.#updateEyes(now, gaze, dt);
  }

  #record(judgment, lane, now) {
    this.counts[judgment]++;
    if (judgment === "miss") this.combo = 0;
    else this.maxCombo = Math.max(this.maxCombo, ++this.combo);
    this.lastJudgment = judgment;
    this.flashes[lane] = { judgment, at: now };
  }

  #updateEyes(now, gaze, dt) {
    // The middle is off limits while the corner circles are running.
    const rules = now >= this.eyesFrom && now <= this.eyesUntil;
    const inMiddle = rules && gaze && gaze.x >= this.layout.left && gaze.x <= this.layout.right;
    this.centerFor = inMiddle ? this.centerFor + dt : 0;
    this.blinded = this.centerFor > CENTER_GRACE_MS;
    if (this.blinded) this.eyes.centerMs += dt;

    for (let i = this.nextTarget; i < this.targets.length; i++) {
      const t = this.targets[i];
      if (now < t.time - LOOK_EARLY_MS) break;
      if (t.result) continue;
      const next = this.targets[i + 1];
      const onBeatUntil = t.time + LOOK_ON_BEAT_MS;
      const lateUntil = Math.max(onBeatUntil, next ? next.time - LOOK_EARLY_MS : t.time + TARGET_LINGER_MS);
      if (gaze && this.#inCorner(gaze, t.corner)) t.result = now <= onBeatUntil ? "onBeat" : "late";
      else if (now > lateUntil) t.result = "missed";
      if (t.result) this.eyes[t.result]++;
    }
    while (this.targets[this.nextTarget]?.result) this.nextTarget++;
  }

  // Tracking is rough, so a corner counts as "looked at" anywhere in its
  // quarter of the screen, outside the playfield.
  #inCorner(gaze, corner) {
    const { left, right, height } = this.layout;
    const side = corner % 2 ? gaze.x > right : gaze.x < left;
    const half = corner < 2 ? gaze.y < height / 2 : gaze.y >= height / 2;
    return side && half;
  }

  #cornerPos(corner) {
    const { width, height, inset } = this.layout;
    return { x: corner % 2 ? width - inset : inset, y: corner < 2 ? inset : height - inset };
  }

  #autoplay(now) {
    for (let lane = 0; lane < LANES; lane++) {
      const note = this.lanes[lane][this.next[lane]];
      if (note && note.time <= now) {
        this.next[lane]++;
        note.head = "perfect";
        this.#record("perfect", lane, note.time);
        if (note.end !== null) this.holds[lane] = note;
        this.pressed[lane] = true;
        this.autoRelease[lane] = (note.end ?? note.time) + 60;
      } else if (this.pressed[lane] && now >= this.autoRelease[lane]) {
        this.pressed[lane] = false;
      }
    }
  }

  #autoGaze(now) {
    let current = null;
    for (const t of this.targets) {
      if (t.time - LOOK_EARLY_MS / 2 > now) break;
      current = t;
    }
    return current && this.#cornerPos(current.corner);
  }

  // ---- Drawing ----------------------------------------------------------

  draw(ctx) {
    const now = this.now;
    this.#drawPlayfield(ctx, now);
    this.#drawTargets(ctx, now);
    if (now < this.introUntil) this.#drawIntro(ctx, now);
    const progress = Math.min(1, Math.max(0, now / this.endTime));
    ctx.fillStyle = "rgba(255, 255, 255, 0.2)";
    ctx.fillRect(0, 0, this.layout.width * progress, 3);
  }

  #drawPlayfield(ctx, now) {
    const { left, laneW, hitY, height } = this.layout;
    const noteH = Math.max(14, Math.round(laneW * 0.28));
    const pxPerMs = hitY / this.scrollMs;

    ctx.fillStyle = "#0b0b0b";
    ctx.fillRect(left, 0, laneW * LANES, height);
    ctx.fillStyle = "#1c1c1c";
    for (let i = 0; i <= LANES; i++) ctx.fillRect(left + i * laneW - 0.5, 0, 1, height);

    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (let lane = 0; lane < LANES; lane++) {
      const x = left + lane * laneW;
      const color = LANE_COLORS[lane];

      // A glow rising from the receptor, colored by the last judgment.
      const flash = this.flashes[lane];
      if (flash && now - flash.at < FLASH_MS) {
        const h = laneW * 1.6;
        const g = ctx.createLinearGradient(0, hitY - h, 0, hitY);
        g.addColorStop(0, "rgba(0, 0, 0, 0)");
        g.addColorStop(1, withAlpha(JUDGMENTS[flash.judgment].color, 0.5 * (1 - (now - flash.at) / FLASH_MS)));
        ctx.fillStyle = g;
        ctx.fillRect(x + 1, hitY - h, laneW - 2, h);
      }

      roundRect(ctx, x + 5, hitY - noteH / 2, laneW - 10, noteH);
      if (this.pressed[lane]) {
        ctx.fillStyle = withAlpha(color, 0.3);
        ctx.fill();
      }
      ctx.strokeStyle = withAlpha(color, this.pressed[lane] ? 0.9 : 0.35);
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.fillStyle = "rgba(255, 255, 255, 0.3)";
      ctx.font = "600 14px system-ui, sans-serif";
      ctx.fillText(KEY_LABELS[lane], x + laneW / 2, hitY + noteH + 14);

      const q = this.lanes[lane];
      for (let i = Math.max(0, this.next[lane] - 16); i < q.length; i++) {
        const n = q[i];
        if (n.time - now > this.scrollMs * 1.05) break;
        const held = this.holds[lane] === n;
        if (!held && (n.end === null ? n.head && n.head !== "miss" : n.tail && n.tail !== "miss")) continue;
        const dead = n.head === "miss" || n.tail === "miss";
        const yHead = held ? hitY : hitY - (n.time - now) * pxPerMs;
        if (n.end !== null) {
          const yTail = hitY - (n.end - now) * pxPerMs;
          ctx.fillStyle = dead ? "#333333" : withAlpha(color, held ? 0.9 : 0.7);
          ctx.fillRect(x + laneW * 0.22, yTail, laneW * 0.56, yHead - yTail);
        }
        if (yHead - noteH > height) continue;
        ctx.fillStyle = dead ? "#444444" : color;
        roundRect(ctx, x + 5, yHead - noteH / 2, laneW - 10, noteH);
        ctx.fill();
      }
    }

    if (this.blinded) {
      ctx.fillStyle = "rgba(26, 4, 4, 0.97)";
      ctx.fillRect(left, 0, laneW * LANES, height);
      ctx.fillStyle = "#f87171";
      ctx.font = "700 16px system-ui, sans-serif";
      ctx.fillText("Eyes on", left + laneW * 2, height / 2 - 11);
      ctx.fillText("the corners!", left + laneW * 2, height / 2 + 11);
    }
  }

  #drawTargets(ctx, now) {
    const R = this.layout.targetR;
    // The circle you're meant to be on carries the combo, so you never need
    // to look anywhere else for it.
    let focus = null;
    for (const t of this.targets) {
      if (t.time - t.approach > now) break;
      if (t.result === "onBeat" || t.result === "late") focus = t;
    }

    for (let i = Math.max(0, this.nextTarget - 3); i < this.targets.length; i++) {
      const t = this.targets[i];
      if (now < t.time - t.approach) break;
      const next = this.targets[i + 1];
      const goneAt = next ? next.time : t.time + TARGET_LINGER_MS;
      if (now > goneAt + 250) continue;

      const { x, y } = this.#cornerPos(t.corner);
      ctx.globalAlpha = now > goneAt ? 1 - (now - goneAt) / 250 : 1;
      if (now < t.time) {
        // Approach ring closes in on the beat.
        circle(ctx, x, y, R * (1 + 1.8 * ((t.time - now) / t.approach)));
        ctx.strokeStyle = "rgba(255, 255, 255, 0.6)";
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      if (t.result) {
        circle(ctx, x, y, R);
        ctx.fillStyle = "#141414";
        ctx.fill();
        ctx.strokeStyle = LOOK_COLORS[t.result];
        ctx.lineWidth = 3;
        ctx.stroke();
      } else if (now >= t.time) {
        // Landed and still waiting for your eyes.
        circle(ctx, x, y, R * (1 + 0.06 * Math.sin((now - t.time) / 60)));
        ctx.fillStyle = "#ff2a1f";
        ctx.fill();
      } else {
        circle(ctx, x, y, R);
        ctx.strokeStyle = "#ff2a1f";
        ctx.lineWidth = 3;
        ctx.stroke();
      }

      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      if (t === focus) {
        ctx.fillStyle = "#fff";
        ctx.font = `700 ${Math.round(R * 0.75)}px system-ui, sans-serif`;
        ctx.fillText(String(this.combo), x, y);
        ctx.font = "600 13px system-ui, sans-serif";
        ctx.fillStyle = "rgba(255, 255, 255, 0.6)";
        ctx.fillText(`${(this.accuracy * 100).toFixed(1)}%`, x, y + R + 16);
        if (this.lastJudgment) {
          ctx.fillStyle = JUDGMENTS[this.lastJudgment].color;
          ctx.fillText(JUDGMENTS[this.lastJudgment].label, x, y + R + 33);
        }
      } else if (t.result === "missed") {
        ctx.strokeStyle = "#6b6b6b";
        ctx.lineWidth = 3;
        const d = R * 0.35;
        ctx.beginPath();
        ctx.moveTo(x - d, y - d);
        ctx.lineTo(x + d, y + d);
        ctx.moveTo(x + d, y - d);
        ctx.lineTo(x - d, y + d);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
  }

  #drawIntro(ctx, now) {
    const { width, height } = this.layout;
    ctx.globalAlpha = Math.min(1, (this.introUntil - now) / 500);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#fff";
    ctx.font = "700 22px system-ui, sans-serif";
    ctx.fillText("Keep your eyes on the corner circles", width / 2, height * 0.38);
    ctx.fillStyle = "rgba(255, 255, 255, 0.7)";
    ctx.font = "16px system-ui, sans-serif";
    ctx.fillText("Read the notes from the corner of your eye", width / 2, height * 0.38 + 32);
    ctx.fillText("D  F  J  K", width / 2, height * 0.38 + 60);
    ctx.globalAlpha = 1;
  }

  results() {
    return {
      accuracy: this.accuracy,
      maxCombo: this.maxCombo,
      counts: { ...this.counts },
      eyes: { ...this.eyes, total: this.targets.length },
    };
  }
}

function circle(ctx, x, y, r) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
}

function roundRect(ctx, x, y, w, h) {
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, 6);
  else ctx.rect(x, y, w, h);
}

function withAlpha(hex, alpha) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}
