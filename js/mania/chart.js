// Turns a parsed beatmap into a 4-lane chart, a beat grid, and corner circles
// placed on the beat.

export const LANES = 4;
export const CORNERS = 4; // 0 top-left, 1 top-right, 2 bottom-left, 3 bottom-right
const MIN_TARGET_GAP_MS = 450; // eyes can't hop corners much faster than this
const MIN_BEAT_MS = 200; // halve absurd BPMs (some maps use them as effects)

/** Notes as [{ lane, time, end }] sorted by time; end is null for taps. */
export function buildNotes(map) {
  const columns = map.mode === 3 ? Math.max(1, map.keys) : LANES;
  const notes = [];
  const busyUntil = new Array(LANES).fill(-Infinity);
  for (const h of map.hitObjects) {
    // Same column rule as osu!mania; other key counts are squeezed into 4.
    const column = Math.min(columns - 1, Math.max(0, Math.floor((h.x * columns) / 512)));
    const lane = Math.floor((column * LANES) / columns);
    const end = map.mode === 3 ? h.end : null;
    // Squeezing can stack notes on top of each other; keep the first.
    if (h.time - busyUntil[lane] < 10) continue;
    notes.push({ lane, time: h.time, end });
    busyUntil[lane] = end ?? h.time;
  }
  return notes;
}

/** The time the last note (or hold) ends. */
export function chartEnd(notes) {
  return notes.reduce((t, n) => Math.max(t, n.end ?? n.time), 0);
}

/**
 * Red (uninherited) timing points, or one estimated from the notes when the
 * map has none.
 */
export function bpmSections(map) {
  const sections = map.timingPoints
    .filter((t) => t.uninherited && t.beatLength > 0)
    .map(({ time, beatLength, meter }) => {
      while (beatLength < MIN_BEAT_MS) beatLength *= 2;
      return { time, beatLength, meter };
    });
  if (sections.length) return { sections, estimated: false };
  const guess = estimateTiming(map.hitObjects.map((h) => h.time));
  return { sections: guess ? [guess] : [], estimated: true };
}

/** Every beat up to endTime: [{ time, index, meter }], index counted from the bar line. */
export function beatGrid(sections, endTime) {
  const beats = [];
  sections.forEach(({ time, beatLength, meter }, i) => {
    const until = i + 1 < sections.length ? sections[i + 1].time : endTime;
    // Extend the first section back to the start of the song.
    let k = i === 0 ? -Math.floor(time / beatLength) : 0;
    for (let t = time + k * beatLength; t < until - 1; t = time + ++k * beatLength) {
      beats.push({ time: t, index: k, meter });
    }
  });
  return beats;
}

/**
 * Corner circles on the beat between `from` and `to`: one per bar, every 2
 * beats, or every beat. Each lands in a different corner from the last.
 */
export function cornerTargets(beats, every, from, to) {
  const targets = [];
  let corner = -1;
  for (const b of beats) {
    if (b.time < from || b.time > to) continue;
    const step = every === "bar" ? b.meter : Number(every);
    if (((b.index % step) + step) % step !== 0) continue;
    if (targets.length && b.time - targets[targets.length - 1].time < MIN_TARGET_GAP_MS) continue;
    let next;
    do next = Math.floor(Math.random() * CORNERS);
    while (next === corner);
    corner = next;
    targets.push({ time: b.time, corner });
  }
  return targets;
}

/** The BPM that covers most of the song, plus the range, for display. */
export function bpmSummary(sections, endTime) {
  let main = null;
  let longest = -1;
  const bpms = sections.map((s, i) => {
    const bpm = 60000 / s.beatLength;
    const length = (i + 1 < sections.length ? sections[i + 1].time : endTime) - s.time;
    if (length > longest) {
      longest = length;
      main = { bpm, meter: s.meter, beatLength: s.beatLength };
    }
    return bpm;
  });
  return main && { ...main, min: Math.min(...bpms), max: Math.max(...bpms) };
}

// For maps without timing points: the beat length (80–200 BPM) whose grid
// lines up best with the note onsets.
function estimateTiming(times) {
  const onsets = [...new Set(times)];
  if (onsets.length < 8) return null;
  let best = null;
  for (let beatLength = 300; beatLength <= 750; beatLength += 0.5) {
    let re = 0;
    let im = 0;
    for (const t of onsets) {
      const a = (2 * Math.PI * t) / beatLength;
      re += Math.cos(a);
      im += Math.sin(a);
    }
    const strength = Math.hypot(re, im);
    if (!best || strength > best.strength) best = { strength, beatLength, phase: Math.atan2(im, re) };
  }
  const offset = (((best.phase / (2 * Math.PI)) * best.beatLength) % best.beatLength + best.beatLength) % best.beatLength;
  return { time: offset, beatLength: best.beatLength, meter: 4 };
}
