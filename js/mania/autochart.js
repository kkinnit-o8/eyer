// Charts for songs that have no osu! map. Finds where sounds start (onsets)
// and the song's beat, then writes them as an .osu file, so the rest of the
// game treats the song like any other map.

const SAMPLE_RATE = 22050;
const FRAME = 1024; // ~46 ms analysis window
const HOP = 256; // ~11.6 ms between frames
const FPS = SAMPLE_RATE / HOP;
// Frequency bands, which also become the four mania lanes: bass, low mids,
// high mids, treble.
const BANDS = [0, 200, 800, 3000, SAMPLE_RATE / 2];
const SNAP_MS = 30; // onsets this close to the beat grid are snapped onto it

/**
 * Decodes an audio file and charts it. Returns the generated .osu text.
 * Browser only (uses OfflineAudioContext to decode).
 */
export async function chartAudioFile(bytes, fileName) {
  const ctx = new OfflineAudioContext(1, 1, SAMPLE_RATE);
  const buffer = await ctx.decodeAudioData(bytes.slice().buffer);
  const samples = new Float32Array(buffer.length);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < data.length; i++) samples[i] += data[i] / buffer.numberOfChannels;
  }
  const analysis = await analyzeInWorker(samples);
  const name = fileName.replace(/\.[^.]+$/, "");
  const [artist, title] = name.includes(" - ") ? name.split(/ - (.+)/) : ["", name];
  return chartToOsu({ title, artist, audioFilename: fileName, analysis });
}

// Long songs take a few seconds to analyze; do it in a worker when possible.
function analyzeInWorker(samples) {
  return new Promise((resolve) => {
    let worker;
    try {
      worker = new Worker(new URL("./autochart-worker.js", import.meta.url), { type: "module" });
    } catch {
      resolve(analyzeAudio(samples));
      return;
    }
    worker.onmessage = ({ data }) => {
      worker.terminate();
      resolve(data);
    };
    worker.onerror = () => {
      worker.terminate();
      resolve(analyzeAudio(samples));
    };
    worker.postMessage(samples);
  });
}

/**
 * Analyzes mono samples at 22050 Hz. Returns { onsets: [{ time, band,
 * strength }], beatLength, offset } with times in ms; offset is a downbeat.
 */
export function analyzeAudio(samples) {
  const { flux, bandFlux } = spectralFlux(samples);
  const odf = normalize(flux);
  const onsets = pickPeaks(odf).map((i) => ({
    time: frameTime(i),
    band: argmax(bandFlux.map((b) => b[i])),
    strength: odf[i],
  }));
  if (onsets.length < 8) return { onsets, beatLength: 500, offset: 0 };

  const { beatLength, offset } = findGrid(onsets);
  // Downbeat: the beat phase (of 4) with the most bass on it.
  const bass = normalize(bandFlux[0]);
  const bassAt = (t) => {
    const f = Math.round(timeFrame(t));
    return Math.max(bass[f - 1] ?? 0, bass[f] ?? 0, bass[f + 1] ?? 0);
  };
  let downbeat = offset;
  let most = -1;
  for (let p = 0; p < 4; p++) {
    let sum = 0;
    for (let t = offset + p * beatLength; t < (samples.length / SAMPLE_RATE) * 1000; t += 4 * beatLength) sum += bassAt(t);
    if (sum > most) {
      most = sum;
      downbeat = offset + p * beatLength;
    }
  }
  return { onsets: snapOnsets(onsets, beatLength, downbeat), beatLength, offset: downbeat };
}

// Onsets show up about half a window into the frame that first sees them;
// against hand-made maps they still land about 15 ms late, so pull them in.
const DETECTION_SHIFT_MS = -15;
const frameTime = (i) => ((i * HOP + FRAME / 2) / SAMPLE_RATE) * 1000 + DETECTION_SHIFT_MS;
const timeFrame = (ms) => (((ms - DETECTION_SHIFT_MS) / 1000) * SAMPLE_RATE - FRAME / 2) / HOP;

// The steady tempo whose beat grid the onsets line up with best. Each onset
// becomes an arrow pointing at its position within a beat, weighted by how
// strong it is; on the right grid the arrows agree and their sum is long.
// Over a whole song this pins the tempo to a hundredth of a BPM.
function findGrid(onsets) {
  const times = onsets.map((o) => o.time);
  const weights = onsets.map((o) => o.strength ** 2);
  const total = weights.reduce((s, w) => s + w, 0);
  const fit = (bpm) => {
    const beatLength = 60000 / bpm;
    let re = 0;
    let im = 0;
    for (let i = 0; i < times.length; i++) {
      const a = (2 * Math.PI * times[i]) / beatLength;
      re += weights[i] * Math.cos(a);
      im += weights[i] * Math.sin(a);
    }
    return { bpm, strength: Math.hypot(re, im) / total, phase: Math.atan2(im, re) };
  };
  let best = fit(60);
  for (let bpm = 60; bpm <= 300; bpm += 0.05) {
    const f = fit(bpm);
    if (f.strength > best.strength) best = f;
  }
  for (let bpm = best.bpm - 0.05; bpm <= best.bpm + 0.05; bpm += 0.002) {
    const f = fit(bpm);
    if (f.strength > best.strength) best = f;
  }
  // The best grid can be a multiple of the beat (e.g. eighth notes); fold it
  // into a usual tempo range. The phase is refound for the folded tempo.
  let bpm = best.bpm;
  while (bpm > MAX_BPM) bpm /= 2;
  while (bpm < MIN_BPM) bpm *= 2;
  const { phase } = fit(bpm);
  const beatLength = 60000 / bpm;
  const offset = ((((phase / (2 * Math.PI)) * beatLength) % beatLength) + beatLength) % beatLength;
  return { beatLength, offset };
}

const MIN_BPM = 90;
const MAX_BPM = 230;

function spectralFlux(samples) {
  const frames = Math.max(0, Math.floor((samples.length - FRAME) / HOP) + 1);
  const window = Float32Array.from({ length: FRAME }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FRAME));
  const bins = FRAME / 2;
  const binHz = SAMPLE_RATE / FRAME;
  const bandOf = Int8Array.from({ length: bins }, (_, k) => BANDS.findIndex((f, b) => k * binHz < BANDS[b + 1]));
  const re = new Float32Array(FRAME);
  const im = new Float32Array(FRAME);
  let prev = new Float32Array(bins);
  let cur = new Float32Array(bins);
  const flux = new Float32Array(frames);
  const bandFlux = Array.from({ length: BANDS.length - 1 }, () => new Float32Array(frames));
  const fft = makeFft(FRAME);

  for (let f = 0; f < frames; f++) {
    const start = f * HOP;
    for (let i = 0; i < FRAME; i++) {
      re[i] = samples[start + i] * window[i];
      im[i] = 0;
    }
    fft(re, im);
    for (let k = 0; k < bins; k++) cur[k] = Math.log1p(100 * Math.hypot(re[k], im[k]));
    if (f > 0) {
      for (let k = 1; k < bins - 1; k++) {
        // Compare with the loudest neighbouring bin of the previous frame,
        // so vibrato and slides don't count as new notes.
        const before = Math.max(prev[k - 1], prev[k], prev[k + 1]);
        const rise = cur[k] - before;
        if (rise > 0) {
          flux[f] += rise;
          bandFlux[bandOf[k]][f] += rise;
        }
      }
    }
    [prev, cur] = [cur, prev];
  }
  return { flux, bandFlux };
}

// Local maxima that clearly stand out from their surroundings.
function pickPeaks(odf) {
  const peaks = [];
  const pre = 3;
  const post = 3;
  const avgPre = 10;
  const avgPost = 7;
  const delta = 0.06;
  const minGap = 4; // ~46 ms
  for (let i = 0; i < odf.length; i++) {
    let isMax = true;
    for (let j = Math.max(0, i - pre); j <= Math.min(odf.length - 1, i + post); j++) {
      if (odf[j] > odf[i]) isMax = false;
    }
    if (!isMax || odf[i] === 0) continue;
    let sum = 0;
    let n = 0;
    for (let j = Math.max(0, i - avgPre); j <= Math.min(odf.length - 1, i + avgPost); j++) {
      sum += odf[j];
      n++;
    }
    if (odf[i] < sum / n + delta) continue;
    if (peaks.length && i - peaks[peaks.length - 1] < minGap) continue;
    peaks.push(i);
  }
  return peaks;
}

// Snap onsets to quarter or third beats when they are close, and drop
// duplicates the snapping creates.
function snapOnsets(onsets, beatLength, offset) {
  const out = [];
  for (const o of onsets) {
    let time = o.time;
    let bestErr = SNAP_MS;
    for (const div of [4, 3]) {
      const step = beatLength / div;
      const snapped = offset + Math.round((o.time - offset) / step) * step;
      const err = Math.abs(snapped - o.time);
      if (err < bestErr) {
        bestErr = err;
        time = snapped;
      }
    }
    if (out.length && time - out[out.length - 1].time < 20) continue;
    out.push({ ...o, time: Math.round(time) });
  }
  return out;
}

/** Writes an analysis as a minimal osu!mania 4K .osu file. */
export function chartToOsu({ title, artist, audioFilename, analysis }) {
  const { onsets, beatLength, offset } = analysis;
  const laneX = [64, 192, 320, 448];
  return [
    "osu file format v14",
    "",
    "[General]",
    `AudioFilename: ${audioFilename}`,
    "Mode: 3",
    "",
    "[Metadata]",
    `Title:${title}`,
    `Artist:${artist}`,
    "Creator:Eyer",
    "Version:Auto",
    "",
    "[Difficulty]",
    "CircleSize:4",
    "OverallDifficulty:7",
    "",
    "[TimingPoints]",
    `${offset.toFixed(2)},${beatLength.toFixed(6)},4,0,0,100,1,0`,
    "",
    "[HitObjects]",
    ...onsets.map((o) => `${laneX[o.band]},192,${o.time},1,0,0:0:0:0:`),
    "",
  ].join("\n");
}

function normalize(values) {
  const sorted = Float32Array.from(values).sort();
  const top = sorted[Math.floor(sorted.length * 0.99)] || 1;
  return Float32Array.from(values, (v) => Math.min(1.5, v / top));
}

function argmax(values) {
  let best = 0;
  for (let i = 1; i < values.length; i++) if (values[i] > values[best]) best = i;
  return best;
}

// Iterative radix-2 FFT, in place, for one fixed size.
function makeFft(n) {
  const levels = Math.log2(n);
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < levels; b++) r |= ((i >> b) & 1) << (levels - 1 - b);
    rev[i] = r;
  }
  const cos = Float32Array.from({ length: n / 2 }, (_, i) => Math.cos((2 * Math.PI * i) / n));
  const sin = Float32Array.from({ length: n / 2 }, (_, i) => -Math.sin((2 * Math.PI * i) / n));
  return (re, im) => {
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        [re[i], re[j]] = [re[j], re[i]];
        [im[i], im[j]] = [im[j], im[i]];
      }
    }
    for (let size = 2; size <= n; size *= 2) {
      const half = size / 2;
      const step = n / size;
      for (let start = 0; start < n; start += size) {
        for (let k = 0; k < half; k++) {
          const a = start + k;
          const b = a + half;
          const wr = cos[k * step];
          const wi = sin[k * step];
          const tr = re[b] * wr - im[b] * wi;
          const ti = re[b] * wi + im[b] * wr;
          re[b] = re[a] - tr;
          im[b] = im[a] - ti;
          re[a] += tr;
          im[a] += ti;
        }
      }
    }
  };
}
