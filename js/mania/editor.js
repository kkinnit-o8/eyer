// Level editor rounds. The song plays and the player records either notes
// (round 1, Space) or eye circles (round 2, click). They can stop whenever
// they like; the level is only as long as what they recorded.

import { heardTime, click } from "./clock.js";
import { EDITOR_CREATOR } from "./osu.js";

const LEAD_IN_S = 1;
const CIRCLE_GAP_MS = 450; // same as generated corner circles
const DOUBLE_TAP_MS = 40; // two notes this close after snapping are one
const AFTER_LAST_NOTE_MS = 2000; // round 2 ends this long after the last note
const FLASH_MS = 200;
const POP_MS = 600;

export class EditorRound {
  /**
   * kind: "notes" or "circles". notes: times recorded in round 1; in round 2
   * they tick along with the music. snap(time) moves a time onto the beat.
   * Times use the game's convention (song position minus the note offset),
   * so the level plays back in time for this player.
   */
  constructor({ kind, audio, buffer, offsetMs, notes = [], snap }) {
    this.kind = kind;
    this.audio = audio;
    this.offsetMs = offsetMs;
    this.notes = notes;
    this.snap = snap;
    this.items = []; // note times, or { time, corner } eye circles
    this.lastTap = -Infinity;
    this.duration = buffer.duration * 1000;
    this.end =
      kind === "circles" && notes.length ? Math.min(this.duration, notes[notes.length - 1] + AFTER_LAST_NOTE_MS) : this.duration;

    this.out = audio.createGain();
    this.out.connect(audio.destination);
    this.source = audio.createBufferSource();
    this.source.buffer = buffer;
    this.source.connect(this.out);
    this.startAt = audio.currentTime + LEAD_IN_S;
    this.source.start(this.startAt);
    // Round 2: your notes tick along, so you can hear the level you made.
    if (kind === "circles") for (const t of notes) click(audio, this.startAt + t / 1000, false, this.out);
  }

  time(perf) {
    return (heardTime(this.audio, perf) - this.startAt) * 1000 - this.offsetMs;
  }

  isOver(perf) {
    return this.time(perf) > this.end;
  }

  /** Records a note or eye circle at performance time perf. */
  add(perf) {
    const raw = this.time(perf);
    if (raw < 0 || raw > this.end) return false;
    const time = this.snap(raw);
    const last = this.items[this.items.length - 1];
    if (this.kind === "notes") {
      if (last !== undefined && Math.abs(time - last) < DOUBLE_TAP_MS) return false;
      this.items.push(time);
    } else {
      if (last && time - last.time < CIRCLE_GAP_MS) return false;
      let corner;
      do corner = Math.floor(Math.random() * 4);
      while (corner === last?.corner);
      this.items.push({ time, corner, at: perf });
    }
    this.lastTap = perf;
    return true;
  }

  undo() {
    this.items.pop();
  }

  /** What was recorded, in time order. */
  result() {
    const items = [...this.items].sort((a, b) => (a.time ?? a) - (b.time ?? b));
    return this.kind === "notes" ? items : items.map(({ time, corner }) => ({ time, corner }));
  }

  stop() {
    const t = this.audio.currentTime;
    this.out.gain.setValueAtTime(1, t);
    this.out.gain.linearRampToValueAtTime(0, t + 0.2);
    this.source.stop(t + 0.25);
    setTimeout(() => this.out.disconnect(), 400);
  }

  draw(ctx, perf, W, H) {
    const t = this.time(perf);
    const cx = W / 2;
    const cy = H / 2;
    const R = Math.min(W, H) * 0.12;
    const notesRound = this.kind === "notes";

    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#fff";
    ctx.font = "700 22px system-ui, sans-serif";
    ctx.fillText(notesRound ? "Round 1: press Space where you want a note" : "Round 2: click where you want an eye circle", cx, 48);
    ctx.fillStyle = "rgba(255, 255, 255, 0.6)";
    ctx.font = "15px system-ui, sans-serif";
    ctx.fillText(
      `${notesRound ? "Space" : "Click or Enter"} adds · Backspace undoes · Esc when you're done (no need to map the whole song)`,
      cx,
      78,
    );

    // The middle flashes on your taps in round 1, and on your notes in round 2.
    let flash = notesRound ? 1 - (perf - this.lastTap) / FLASH_MS : 0;
    if (!notesRound) {
      for (const n of this.notes) {
        if (n > t) break;
        flash = Math.max(flash, 1 - (t - n) / FLASH_MS);
      }
    }
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    if (flash > 0) {
      ctx.fillStyle = `rgba(242, 242, 242, ${0.85 * flash})`;
      ctx.fill();
    }
    ctx.strokeStyle = "rgba(255, 255, 255, 0.6)";
    ctx.lineWidth = 4;
    ctx.stroke();
    ctx.fillStyle = "rgba(255, 255, 255, 0.85)";
    ctx.font = "700 28px system-ui, sans-serif";
    ctx.fillText(String(this.items.length), cx, cy);
    ctx.font = "14px system-ui, sans-serif";
    ctx.fillStyle = "rgba(255, 255, 255, 0.5)";
    ctx.fillText(notesRound ? "notes" : "eye circles", cx, cy + 24);

    // Eye circles pop up in their corner as you place them.
    if (!notesRound) {
      const inset = Math.min(140, Math.max(56, Math.min(W, H) * 0.12));
      const r = Math.min(56, Math.max(26, Math.min(W, H) * 0.06));
      for (const c of this.items) {
        const age = (perf - c.at) / POP_MS;
        if (age < 0 || age >= 1) continue;
        ctx.globalAlpha = 1 - age;
        ctx.beginPath();
        ctx.arc(c.corner % 2 ? W - inset : inset, c.corner < 2 ? inset : H - inset, r * (1 + 0.3 * age), 0, Math.PI * 2);
        ctx.fillStyle = "#ff2a1f";
        ctx.fill();
        ctx.globalAlpha = 1;
      }
    }

    // Timeline of the whole song: notes in white, eye circles in red.
    const x0 = 40;
    const x1 = W - 40;
    const y = H - 48;
    const at = (ms) => x0 + (x1 - x0) * Math.min(1, Math.max(0, ms / this.duration));
    ctx.fillStyle = "#1c1c1c";
    ctx.fillRect(x0, y - 12, x1 - x0, 24);
    const notes = notesRound ? this.items : this.notes;
    ctx.fillStyle = notesRound ? "#f2f2f2" : "rgba(242, 242, 242, 0.45)";
    for (const n of notes) ctx.fillRect(at(n) - 0.5, y - 10, 1.5, 20);
    if (!notesRound) {
      ctx.fillStyle = "#ff2a1f";
      for (const c of this.items) ctx.fillRect(at(c.time) - 1, y - 12, 3, 24);
    }
    ctx.fillStyle = "#ff2a1f";
    ctx.fillRect(at(t) - 1, y - 18, 2, 36);
    ctx.fillStyle = "rgba(255, 255, 255, 0.6)";
    ctx.font = "13px system-ui, sans-serif";
    ctx.textAlign = "left";
    ctx.fillText(`${clock(t)} / ${clock(this.duration)}`, x0, y - 26);
  }
}

/** A recorded level as an .osu file: one-key notes plus our eye circles. */
export function levelToOsu({ map, name, sections, notes, circles }) {
  return [
    "osu file format v14",
    "",
    "[General]",
    `AudioFilename: ${map.audioFilename}`,
    "Mode: 3",
    "",
    "[Metadata]",
    `Title:${map.title}`,
    `Artist:${map.artist}`,
    `Creator:${EDITOR_CREATOR}`,
    `Version:${name}`,
    `BeatmapSetID:${map.setId || 0}`,
    "",
    "[Difficulty]",
    "CircleSize:1",
    `OverallDifficulty:${map.od}`,
    "",
    "[TimingPoints]",
    ...sections.map((s) => `${s.time},${s.beatLength},${s.meter},0,0,100,1,0`),
    "",
    "[HitObjects]",
    ...notes.map((t) => `256,192,${Math.round(t)},1,0,0:0:0:0:`),
    "",
    "[EyerCircles]",
    "// time,corner (0 top-left, 1 top-right, 2 bottom-left, 3 bottom-right)",
    ...circles.map((c) => `${Math.round(c.time)},${c.corner}`),
    "",
  ].join("\n");
}

function clock(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}
