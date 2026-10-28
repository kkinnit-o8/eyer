// Peripheral rhythm: notes fall down the middle of the screen (4 keys, or a
// single key), but your eyes belong on the hit circles that land in the
// corners on the beat. Look at one to pop it; let its timer run out and you
// lose your streak. Stare at the middle and the notes disappear.

const KEY_SETS = {
  1: { codes: ["Space"], labels: ["Space"], colors: ["#f2f2f2"] },
  4: { codes: ["KeyD", "KeyF", "KeyJ", "KeyK"], labels: ["D", "F", "J", "K"], colors: ["#f2f2f2", "#5aa9ff", "#5aa9ff", "#f2f2f2"] },
};

const CENTER_GRACE_MS = 300; // sweeping across the middle is fine; staring isn't
const LOOK_EARLY_MS = 300; // a corner circle can be popped from this long before its beat
const LOOK_ON_BEAT_MS = 350; // pops up to this long after the beat are on beat (covers tracker lag)
const LOOK_TIMER_MS = 900; // longest a landed circle waits for your eyes
const LEAD_IN_MS = 2500; // quiet time before the first note or circle
const END_PAD_MS = 1500;
const FLASH_MS = 250;
const POP_MS = 300;
const STREAK_LOST_MS = 700;

export const JUDGMENTS = {
  perfect: { label: "Perfect", color: "#ffffff" },
  great: { label: "Great", color: "#fde047" },
  good: { label: "Good", color: "#4ade80" },
  ok: { label: "OK", color: "#60a5fa" },
  meh: { label: "Meh", color: "#a3a3a3" },
  miss: { label: "Miss", color: "#f87171" },
};
const HIT_ORDER = ["perfect", "great", "good", "ok", "meh"];
// One-key lines are colored by the beat they land on: white on the beat,
// blue on half beats, yellow on quarter beats, purple otherwise.
const SNAP_COLORS = ["#c084fc", "#fde047", "#5aa9ff", "#f2f2f2", "#f2f2f2"];
const CHARGE_SHARE = 0.4; // the target starts filling for the last 40% of a note's approach
const LOOK_COLORS = { onBeat: "#4ade80", late: "#fbbf24" };

// osu!mania hit windows (ms either side) for an Overall Difficulty.
function hitWindows(od) {
  return { perfect: 16, great: 64 - 3 * od, good: 97 - 3 * od, ok: 127 - 3 * od, meh: 151 - 3 * od, miss: 188 - 3 * od };
}

function judge(error, windows) {
  return HIT_ORDER.find((j) => error <= windows[j]) ?? "miss";
}

export class ManiaGame {
  /**
   * onLook(x, y, perf) is called when the player pops a corner circle: they
   * were looking at (x, y) at performance time perf.
   */
  constructor({ lanes = 4, shape = "box", notes, targets, beats = [], od, audio, buffer, scrollMs, offsetMs, autoplay, onLook, width, height }) {
    this.audio = audio;
    this.buffer = buffer;
    this.scrollMs = scrollMs;
    this.offsetMs = offsetMs;
    this.autoplay = autoplay;
    this.onLook = onLook;
    this.windows = hitWindows(od);
    this.keys = KEY_SETS[lanes];
    this.shape = shape; // one key: "box" or "circle"

    this.laneCount = lanes;
    this.lanes = Array.from({ length: lanes }, () => []);
    for (const n of notes) this.lanes[n.lane].push({ ...n, head: null, tail: null });
    this.next = new Array(lanes).fill(0); // first note per lane whose head is unjudged
    this.holds = new Array(lanes).fill(null); // hold note being held, per lane
    this.pressed = new Array(lanes).fill(false);
    this.autoRelease = new Array(lanes).fill(0);
    this.flashes = new Array(lanes).fill(null);
    this.beats = beats; // beat times, for the one-key box's pulse
    this.beatIndex = 0;

    // Each circle appears one gap (at most a second) before its beat, and
    // after landing waits until shortly before the next one lands.
    this.targets = targets.map((t, i) => {
      const gap = i + 1 < targets.length ? targets[i + 1].time - t.time : Infinity;
      return {
        ...t,
        approach: Math.min(1000, i ? t.time - targets[i - 1].time : 1000),
        expires: t.time + Math.min(LOOK_TIMER_MS, Math.max(LOOK_ON_BEAT_MS, gap - 150)),
        result: null,
        resultAt: 0,
      };
    });
    this.nextTarget = 0;
    this.lastPopped = null; // the combo is drawn where your eyes last were
    this.streakLostAt = -Infinity;

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
    this.eyesUntil = first ? this.targets[this.targets.length - 1].expires + POP_MS : -Infinity;
    const lastNote = notes.reduce((t, n) => Math.max(t, n.end ?? n.time), 0);
    this.endTime = Math.max(lastNote, this.eyesUntil) + END_PAD_MS;
    this.firstEvent = Math.min(notes.length ? notes[0].time - scrollMs : Infinity, this.eyesFrom);
    this.introUntil = Number.isFinite(this.eyesFrom) ? this.eyesFrom : this.firstEvent;
    this.resize(width, height);
  }

  get keyCodes() {
    return this.keys.codes;
  }

  resize(width, height) {
    const short = Math.min(width, height);
    const corners = {
      width,
      height,
      inset: Math.min(140, Math.max(56, short * 0.12)),
      targetR: Math.min(56, Math.max(26, short * 0.06)),
    };
    if (this.laneCount === 1) {
      // One key: a big target in the middle that each note closes in on.
      const half = Math.round(Math.min(120, Math.max(56, short * 0.13)));
      this.layout = {
        ...corners,
        cx: width / 2,
        cy: height / 2,
        half,
        // No looking at the middle 30% of the screen.
        middleLeft: Math.min(width / 2 - half, width * 0.35),
        middleRight: Math.max(width / 2 + half, width * 0.65),
      };
      return;
    }
    // Wide lanes and big notes: easier to read from the corner of your eye.
    const laneW = Math.round(Math.min(160, Math.max(64, Math.min(width * 0.1, height * 0.2))));
    const noteR = Math.round(laneW * 0.4);
    const left = Math.round(width / 2 - laneW * 2);
    const right = left + laneW * 4;
    this.layout = {
      ...corners,
      laneW,
      noteR,
      left,
      right,
      middleLeft: left,
      middleRight: right,
      hitY: Math.round(height - noteR - Math.max(36, height * 0.06)),
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
    this.perf = perf;
    const now = this.songTime(perf);
    const dt = this.lastNow === null ? 0 : Math.min(100, Math.max(0, now - this.lastNow));
    this.now = this.lastNow = now;
    if (this.autoplay) {
      this.#autoplay(now);
      gaze = this.#autoGaze(now);
    }

    for (let lane = 0; lane < this.laneCount; lane++) {
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
    const inMiddle = rules && gaze && gaze.x >= this.layout.middleLeft && gaze.x <= this.layout.middleRight;
    this.centerFor = inMiddle ? this.centerFor + dt : 0;
    this.blinded = this.centerFor > CENTER_GRACE_MS;
    if (this.blinded) this.eyes.centerMs += dt;

    for (let i = this.nextTarget; i < this.targets.length; i++) {
      const t = this.targets[i];
      if (now < t.time - LOOK_EARLY_MS) break;
      if (t.result) continue;
      if (gaze && this.#inCorner(gaze, t.corner)) {
        t.result = now <= t.time + LOOK_ON_BEAT_MS ? "onBeat" : "late";
        this.lastPopped = t;
        // A known gaze point the tracker can learn from (never from autoplay's fake gaze).
        if (!this.autoplay) {
          const { x, y } = this.#cornerPos(t.corner);
          this.onLook?.(x, y, this.perf);
        }
      } else if (now > t.expires) {
        // Its timer ran out: the circle leaves and takes your streak with it.
        t.result = "missed";
        this.combo = 0;
        this.streakLostAt = now;
      }
      if (t.result) {
        t.resultAt = now;
        this.eyes[t.result]++;
      }
    }
    while (this.targets[this.nextTarget]?.result) this.nextTarget++;
  }

  // Tracking is rough, so a corner counts as "looked at" anywhere in its
  // quarter of the screen, outside the middle.
  #inCorner(gaze, corner) {
    const { middleLeft, middleRight, height } = this.layout;
    const side = corner % 2 ? gaze.x > middleRight : gaze.x < middleLeft;
    const half = corner < 2 ? gaze.y < height / 2 : gaze.y >= height / 2;
    return side && half;
  }

  #cornerPos(corner) {
    const { width, height, inset } = this.layout;
    return { x: corner % 2 ? width - inset : inset, y: corner < 2 ? inset : height - inset };
  }

  #autoplay(now) {
    for (let lane = 0; lane < this.laneCount; lane++) {
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
    if (this.laneCount === 1) this.#drawOneKey(ctx, now);
    else this.#drawPlayfield(ctx, now);
    if (this.blinded) this.#drawBlind(ctx);
    this.#drawTargets(ctx, now);
    if (now < this.introUntil) this.#drawIntro(ctx, now);
    const progress = Math.min(1, Math.max(0, now / this.endTime));
    ctx.fillStyle = "rgba(255, 255, 255, 0.2)";
    ctx.fillRect(0, 0, this.layout.width * progress, 3);
  }

  #drawPlayfield(ctx, now) {
    const { left, laneW, noteR, hitY, height } = this.layout;
    // Notes enter fully hidden above the screen and reach the receptors on time.
    const pxPerMs = (hitY + noteR) / this.scrollMs;

    ctx.fillStyle = "#0b0b0b";
    ctx.fillRect(left, 0, laneW * this.laneCount, height);
    ctx.fillStyle = "#181818";
    for (let i = 1; i < this.laneCount; i++) ctx.fillRect(left + i * laneW - 0.5, 0, 1, height);

    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (let lane = 0; lane < this.laneCount; lane++) {
      const x = left + (lane + 0.5) * laneW;
      const color = this.keys.colors[lane];

      // Receptor circle; filled while its key is down.
      circle(ctx, x, hitY, noteR);
      if (this.pressed[lane]) {
        ctx.fillStyle = withAlpha(color, 0.25);
        ctx.fill();
      }
      ctx.strokeStyle = withAlpha(color, this.pressed[lane] ? 0.95 : 0.4);
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.fillStyle = "rgba(255, 255, 255, 0.3)";
      ctx.font = "600 14px system-ui, sans-serif";
      ctx.fillText(this.keys.labels[lane], x, hitY + noteR + 16);

      const q = this.lanes[lane];
      for (let i = Math.max(0, this.next[lane] - 16); i < q.length; i++) {
        const n = q[i];
        if (n.time - now > this.scrollMs * 1.05) break;
        const held = this.holds[lane] === n;
        if (!held && (n.end === null ? n.head && n.head !== "miss" : n.tail && n.tail !== "miss")) continue;
        const dead = n.head === "miss" || n.tail === "miss";
        const yHead = held ? hitY : hitY - (n.time - now) * pxPerMs;
        if (n.end !== null) {
          // Hold: a rounded bar from the head up to where the hold ends.
          const yTail = hitY - (n.end - now) * pxPerMs;
          const w = noteR * 1.2;
          ctx.fillStyle = dead ? "#333333" : withAlpha(color, held ? 0.9 : 0.7);
          roundRect(ctx, x - w / 2, yTail - w / 2, w, yHead - yTail + w / 2, w / 2);
          ctx.fill();
        }
        if (yHead - noteR > height) continue;
        circle(ctx, x, yHead, noteR);
        ctx.fillStyle = dead ? "#444444" : color;
        ctx.fill();
      }

      // A ring bursts out of the receptor, colored by the judgment.
      const flash = this.flashes[lane];
      if (flash && now - flash.at < FLASH_MS) {
        const p = (now - flash.at) / FLASH_MS;
        circle(ctx, x, hitY, noteR * (1 + 0.45 * p));
        ctx.strokeStyle = withAlpha(JUDGMENTS[flash.judgment].color, 0.9 * (1 - p));
        ctx.lineWidth = 6 * (1 - p) + 1;
        ctx.stroke();
      }
    }

  }

  #drawOneKey(ctx, now) {
    const { cx, cy, half } = this.layout;
    const q = this.lanes[0];

    // Each note is a shape that starts at the edge of the screen and closes
    // in on the target, thicker and brighter as it nears, landing exactly on
    // time. The next note also charges the target: it fills up and is
    // brightest at the moment to press, a big flash the corner of your eye
    // catches. All of it hides while you stare at the middle.
    let charge = 0;
    let chargeColor = SNAP_COLORS[3];
    if (!this.blinded) {
      for (let i = Math.max(0, this.next[0] - 8); i < q.length; i++) {
        const n = q[i];
        const dt = n.time - now;
        if (dt > this.scrollMs) break;
        if (n.head && n.head !== "miss") continue;
        const color = n.head === "miss" ? JUDGMENTS.miss.color : SNAP_COLORS[n.snap ?? 3];
        const p = Math.max(0, dt / this.scrollMs); // 1 at the screen edge, 0 on time
        let alpha = Math.min(1, (1 - p) / 0.12) * (0.4 + 0.6 * (1 - p));
        if (dt < 0) alpha *= Math.max(0, 1 + dt / 150);
        if (alpha > 0) this.#drawApproach(ctx, p, color, alpha);
        if (!n.head) {
          const c = dt >= 0 ? (1 - Math.min(1, dt / (this.scrollMs * CHARGE_SHARE))) ** 2 : Math.max(0, 1 + dt / 120);
          if (c > charge) {
            charge = c;
            chargeColor = color;
          }
        }
      }
    }

    if (charge > 0) {
      this.#targetPath(ctx, half);
      ctx.fillStyle = withAlpha(chargeColor, 0.85 * charge);
      ctx.fill();
    }
    if (this.pressed[0]) {
      this.#targetPath(ctx, half);
      ctx.fillStyle = "rgba(255, 255, 255, 0.18)";
      ctx.fill();
    }

    // The target's outline pulses on every beat of the song.
    while (this.beatIndex + 1 < this.beats.length && this.beats[this.beatIndex + 1] <= now) this.beatIndex++;
    const sinceBeat = now - (this.beats[this.beatIndex] ?? -Infinity);
    const pulse = sinceBeat >= 0 ? Math.exp(-sinceBeat / 140) : 0;
    ctx.save();
    this.#targetPath(ctx, half);
    ctx.shadowColor = "rgba(255, 255, 255, 0.8)";
    ctx.shadowBlur = 22 * pulse;
    ctx.strokeStyle = `rgba(255, 255, 255, ${0.6 + 0.4 * pulse})`;
    ctx.lineWidth = 4;
    ctx.stroke();
    ctx.restore();

    // On a judgment the target bursts outward in its color.
    const flash = this.flashes[0];
    if (flash && now - flash.at < FLASH_MS) {
      const p = (now - flash.at) / FLASH_MS;
      const color = JUDGMENTS[flash.judgment].color;
      this.#targetPath(ctx, half);
      ctx.fillStyle = withAlpha(color, 0.5 * (1 - p));
      ctx.fill();
      this.#targetPath(ctx, half * (1 + 0.5 * p));
      ctx.strokeStyle = withAlpha(color, 0.9 * (1 - p));
      ctx.lineWidth = 8 * (1 - p) + 1;
      ctx.stroke();
    }

    ctx.fillStyle = "rgba(255, 255, 255, 0.35)";
    ctx.font = "600 14px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(this.keys.labels[0], cx, cy + half + 24);
  }

  #targetPath(ctx, r) {
    const { cx, cy } = this.layout;
    if (this.shape === "circle") circle(ctx, cx, cy, r);
    else roundRect(ctx, cx - r, cy - r, r * 2, r * 2, r * 0.18);
  }

  // One note's approach at p (1 = screen edge, 0 = on the target). Box: four
  // lines, one from each side of the screen, with gaps at the corners. Circle:
  // a ring that starts out through the corners of the screen.
  #drawApproach(ctx, p, color, alpha) {
    const { cx, cy, half } = this.layout;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = color;
    ctx.shadowColor = color;
    ctx.shadowBlur = 16;
    ctx.lineWidth = 3 + 6 * (1 - p);
    ctx.lineCap = "round";
    if (this.shape === "circle") {
      circle(ctx, cx, cy, half + p * (Math.hypot(cx, cy) - half));
    } else {
      const dx = half + p * (cx - half);
      const dy = half + p * (cy - half);
      const gx = dx * 0.15;
      const gy = dy * 0.15;
      ctx.beginPath();
      ctx.moveTo(cx - dx + gx, cy - dy);
      ctx.lineTo(cx + dx - gx, cy - dy);
      ctx.moveTo(cx - dx + gx, cy + dy);
      ctx.lineTo(cx + dx - gx, cy + dy);
      ctx.moveTo(cx - dx, cy - dy + gy);
      ctx.lineTo(cx - dx, cy + dy - gy);
      ctx.moveTo(cx + dx, cy - dy + gy);
      ctx.lineTo(cx + dx, cy + dy - gy);
    }
    ctx.stroke();
    ctx.restore();
  }

  // Staring at the middle: everything there goes dark, fully opaque so the
  // notes can't be read through it.
  #drawBlind(ctx) {
    const { middleLeft, middleRight, height } = this.layout;
    ctx.fillStyle = "#1a0404";
    ctx.fillRect(middleLeft, 0, middleRight - middleLeft, height);
    ctx.fillStyle = "#f87171";
    ctx.font = "700 22px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("Eyes on the corners!", (middleLeft + middleRight) / 2, height / 2);
  }

  #drawTargets(ctx, now) {
    const R = this.layout.targetR;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (let i = Math.max(0, this.nextTarget - 4); i < this.targets.length; i++) {
      const t = this.targets[i];
      if (now < t.time - t.approach) break;
      const { x, y } = this.#cornerPos(t.corner);

      if (t.result) {
        const p = (now - t.resultAt) / POP_MS;
        if (p >= 1) continue;
        ctx.globalAlpha = 1 - p;
        if (t.result === "missed") {
          // Timed out: shrinks away with a cross.
          circle(ctx, x, y, R * (1 - 0.4 * p));
          ctx.fillStyle = "#5c1511";
          ctx.fill();
          cross(ctx, x, y, R * 0.35, "#f87171");
        } else {
          // Looked at: bursts.
          circle(ctx, x, y, R * (1 + 0.6 * p));
          ctx.strokeStyle = LOOK_COLORS[t.result];
          ctx.lineWidth = 5 * (1 - p) + 1;
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
        continue;
      }

      if (now < t.time) {
        // Approach ring closes in on the beat.
        circle(ctx, x, y, R * (1 + 1.8 * ((t.time - now) / t.approach)));
        ctx.strokeStyle = "rgba(255, 255, 255, 0.6)";
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      circle(ctx, x, y, R);
      if (now >= t.time - LOOK_EARLY_MS) {
        // Poppable: solid.
        ctx.fillStyle = "#ff2a1f";
        ctx.fill();
      } else {
        ctx.fillStyle = "rgba(255, 42, 31, 0.15)";
        ctx.fill();
        ctx.strokeStyle = "#ff2a1f";
        ctx.lineWidth = 3;
        ctx.stroke();
      }
      if (now > t.time) {
        // Its timer: when this arc runs out, the circle leaves without you.
        const left = 1 - (now - t.time) / (t.expires - t.time);
        ctx.beginPath();
        ctx.arc(x, y, R + 8, -Math.PI / 2, -Math.PI / 2 + left * Math.PI * 2);
        ctx.strokeStyle = "rgba(255, 255, 255, 0.9)";
        ctx.lineWidth = 4;
        ctx.stroke();
      }
    }
    this.#drawStreak(ctx, now);
  }

  // Combo, accuracy and last judgment sit where you last popped a circle,
  // which is where your eyes are, so you never need to look at the middle.
  #drawStreak(ctx, now) {
    if (!this.lastPopped) return;
    const R = this.layout.targetR;
    const { x, y } = this.#cornerPos(this.lastPopped.corner);
    ctx.fillStyle = now - this.streakLostAt < STREAK_LOST_MS ? "#f87171" : "rgba(255, 255, 255, 0.9)";
    ctx.font = `700 ${Math.round(R * 0.8)}px system-ui, sans-serif`;
    ctx.fillText(String(this.combo), x, y);
    ctx.font = "600 13px system-ui, sans-serif";
    ctx.fillStyle = "rgba(255, 255, 255, 0.6)";
    ctx.fillText(`${(this.accuracy * 100).toFixed(1)}%`, x, y + R + 18);
    if (this.lastJudgment) {
      ctx.fillStyle = JUDGMENTS[this.lastJudgment].color;
      ctx.fillText(JUDGMENTS[this.lastJudgment].label, x, y + R + 35);
    }
  }

  #drawIntro(ctx, now) {
    const { width, height } = this.layout;
    ctx.globalAlpha = Math.min(1, (this.introUntil - now) / 500);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#fff";
    ctx.font = "700 22px system-ui, sans-serif";
    ctx.fillText("Look at each corner circle to pop it", width / 2, height * 0.38);
    ctx.fillStyle = "rgba(255, 255, 255, 0.7)";
    ctx.font = "16px system-ui, sans-serif";
    ctx.fillText("Miss one and you lose your streak", width / 2, height * 0.38 + 32);
    ctx.fillText("Read the notes from the corner of your eye", width / 2, height * 0.38 + 56);
    ctx.fillText(this.keys.labels.join("  "), width / 2, height * 0.38 + 84);
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

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
  else ctx.rect(x, y, w, h);
}

function cross(ctx, x, y, d, color) {
  ctx.strokeStyle = color;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(x - d, y - d);
  ctx.lineTo(x + d, y + d);
  ctx.moveTo(x + d, y - d);
  ctx.lineTo(x - d, y + d);
  ctx.stroke();
}

function withAlpha(hex, alpha) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}
