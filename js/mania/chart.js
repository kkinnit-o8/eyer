// Turns a parsed beatmap into a 4-lane chart, a beat grid, and corner circles
// placed on the beat.

export const LANES = 4;
export const CORNERS = 4; // 0 top-left, 1 top-right, 2 bottom-left, 3 bottom-right
const MIN_TARGET_GAP_MS = 450; // eyes can't hop corners much faster than this
const MIN_BEAT_MS = 200; // halve absurd BPMs (some maps use them as effects)
const CHORD_MS = 20; // notes this close together are one chord
const ONE_KEY_MIN_GAP_MS = 90; // never closer than this, whatever the density
// One-key densities: the closest two notes may be, in beats.
export const DENSITIES = { beat: 1, half: 0.5, all: 0.25 };

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

/**
 * One-key chart: the whole map collapsed onto a single key, as taps. Chords
 * become one note. Passages denser than the chosen density are thinned,
 * keeping the notes on the strongest beats (downbeat, beat, half beat,
 * quarter beat) and then the biggest chords. Notes keep their exact map
 * times, so they stay in sync with the music. Each note's `snap` is the
 * strength of the beat it sits on (see beatStrength).
 */
export function buildOneKeyNotes(map, sections, density) {
  const onsets = [];
  for (const h of map.hitObjects) {
    const last = onsets[onsets.length - 1];
    if (last && h.time - last.time <= CHORD_MS) last.size++;
    else onsets.push({ time: h.time, size: 1 });
  }
  for (const o of onsets) {
    const s = sectionAt(sections, o.time);
    o.beatLength = s ? s.beatLength : 500;
    o.strength = s ? beatStrength(o.time, s) : 0;
  }

  const kept = []; // sorted by time
  const ranked = [...onsets].sort((a, b) => b.strength - a.strength || b.size - a.size || a.time - b.time);
  for (const o of ranked) {
    // A little slack so notes a few ms off the grid still fit.
    const gap = Math.max(ONE_KEY_MIN_GAP_MS, o.beatLength * DENSITIES[density] * 0.9);
    let i = 0;
    let hi = kept.length;
    while (i < hi) {
      const mid = (i + hi) >> 1;
      if (kept[mid].time < o.time) i = mid + 1;
      else hi = mid;
    }
    if (i > 0 && o.time - kept[i - 1].time < gap) continue;
    if (i < kept.length && kept[i].time - o.time < gap) continue;
    kept.splice(i, 0, o);
  }
  return kept.map((o) => ({ lane: 0, time: o.time, end: null, snap: o.strength }));
}

function sectionAt(sections, time) {
  let found = sections[0];
  for (const s of sections) if (s.time <= time) found = s;
  return found;
}

// 4 on a downbeat, 3 on a beat, 2 on a half beat, 1 on a quarter, else 0.
function beatStrength(time, section) {
  const beats = (time - section.time) / section.beatLength;
  const tolerance = 25 / section.beatLength; // 25 ms, in beats
  const onGrid = (div) => Math.abs(beats * div - Math.round(beats * div)) < tolerance * div;
  if (onGrid(1)) return ((Math.round(beats) % section.meter) + section.meter) % section.meter === 0 ? 4 : 3;
  if (onGrid(2)) return 2;
  if (onGrid(4)) return 1;
  return 0;
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
