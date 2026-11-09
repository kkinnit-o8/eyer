// Reading osu! beatmaps: .osz archives (zip files) and loose .osu files.

const FFLATE_URL = "https://cdn.jsdelivr.net/npm/fflate@0.8.2/esm/browser.js";
const AUDIO_FILE = /\.(mp3|ogg|wav|m4a|aac|opus|flac)$/i;
// Levels made in the level editor say so in their Creator field.
export const EDITOR_CREATOR = "Eyer editor";

/**
 * Reads the chosen files: an .osz/.zip, or loose .osu and audio files.
 * Returns the charts and songs in them as a Map of lower-case file name ->
 * bytes (everything else, like backgrounds and videos, is skipped).
 */
export async function extractEntries(fileList) {
  const entries = new Map();
  for (const file of fileList) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (/\.(osz|zip)$/i.test(file.name)) {
      const { unzipSync } = await import(FFLATE_URL);
      // Skip backgrounds, videos and hitsounds; only charts and music matter.
      const files = unzipSync(bytes, { filter: (f) => /\.osu$/i.test(f.name) || AUDIO_FILE.test(f.name) });
      for (const [name, data] of Object.entries(files)) entries.set(baseName(name), data);
    } else {
      const name = baseName(file.name);
      if (name.endsWith(".osu") || AUDIO_FILE.test(name)) entries.set(name, bytes);
    }
  }
  return entries;
}

/**
 * Parses extracted entries. Returns { maps, audioFiles }, where audioFiles
 * maps lower-case file names to their bytes.
 */
export function mapsFromEntries(entries) {
  const decoder = new TextDecoder();
  const maps = [];
  const audioFiles = new Map();
  for (const [name, data] of entries) {
    if (name.endsWith(".osu")) {
      const map = parseOsu(decoder.decode(data));
      if (map.hitObjects.length) maps.push(map);
    } else if (AUDIO_FILE.test(name)) {
      audioFiles.set(name, data);
    }
  }
  return { maps, audioFiles };
}

/**
 * One hit object: { x, y, time, type, newCombo, colorSkip } plus, for
 * sliders, { curve: { type, points }, slides, length } and, for spinners,
 * { end }. type is "circle", "slider" or "spinner".
 */
function parseObject(p) {
  const [x, y, time, flags] = p.slice(0, 4).map(Number);
  if (![x, y, time, flags].every(Number.isFinite)) return null;
  const object = { x, y, time, type: "circle", newCombo: Boolean(flags & 4), colorSkip: (flags >> 4) & 7 };
  if (flags & 2) {
    // curveType|x:y|x:y...,slides,length
    const [curveType, ...rest] = (p[5] || "").split("|");
    const points = [{ x, y }, ...rest.map((s) => s.split(":").map(Number)).map(([px, py]) => ({ x: px, y: py }))];
    object.type = "slider";
    object.curve = { type: curveType, points: points.filter((q) => Number.isFinite(q.x) && Number.isFinite(q.y)) };
    object.slides = Math.max(1, Number(p[6]) || 1);
    object.length = Number(p[7]) || 0;
  } else if (flags & 8) {
    object.type = "spinner";
    object.end = Math.max(time, Number(p[5]) || time);
  }
  return object;
}

function baseName(path) {
  return path.split(/[\\/]/).pop().toLowerCase();
}

/** Parses the parts of an .osu file the game needs. */
export function parseOsu(text) {
  const map = {
    title: "",
    artist: "",
    version: "",
    creator: "",
    setId: 0,
    mode: 0,
    keys: 4,
    od: 5,
    // osu!standard: circle size, approach rate, slider speed and tick rate.
    cs: 5,
    ar: null,
    sliderMultiplier: 1.4,
    tickRate: 1,
    colors: [], // combo colors, "#rrggbb"
    audioFilename: "",
    timingPoints: [],
    hitObjects: [], // for the key games: { x, time, end }
    objects: [], // every hit object as osu!standard sees it (see parseObject)
    circles: [], // eye circles placed in the level editor: { time, corner }
  };
  let section = "";

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("//")) continue;
    if (line.startsWith("[") && line.endsWith("]")) {
      section = line.slice(1, -1);
      continue;
    }

    if (section === "General" || section === "Metadata" || section === "Difficulty") {
      const i = line.indexOf(":");
      if (i < 0) continue;
      const value = line.slice(i + 1).trim();
      switch (line.slice(0, i).trim()) {
        case "AudioFilename": map.audioFilename = value; break;
        case "Mode": map.mode = Number(value); break;
        case "Title": map.title = value; break;
        case "Artist": map.artist = value; break;
        case "Version": map.version = value; break;
        case "Creator": map.creator = value; break;
        case "BeatmapSetID": map.setId = Number(value) || 0; break;
        case "CircleSize": map.cs = Number(value); map.keys = Math.round(map.cs); break; // key count in mania
        case "OverallDifficulty": map.od = Number(value); break;
        case "ApproachRate": map.ar = Number(value); break;
        case "SliderMultiplier": map.sliderMultiplier = Number(value) || 1.4; break;
        case "SliderTickRate": map.tickRate = Number(value) || 1; break;
      }
    } else if (section === "Colours") {
      const m = line.match(/^Combo\d+\s*:\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
      if (m) map.colors.push("#" + m.slice(1, 4).map((v) => Number(v).toString(16).padStart(2, "0")).join(""));
    } else if (section === "TimingPoints") {
      // time,beatLength,meter,sampleSet,sampleIndex,volume,uninherited,effects
      const p = line.split(",").map(Number);
      if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
      map.timingPoints.push({
        time: p[0],
        beatLength: p[1],
        meter: p[2] > 0 ? p[2] : 4,
        // Old files have no "uninherited" column; there, positive beat lengths are BPM changes.
        uninherited: p.length > 6 ? p[6] === 1 : p[1] > 0,
      });
    } else if (section === "EyerCircles") {
      // Our own section (osu! ignores unknown ones): time,corner
      const [time, corner] = line.split(",").map(Number);
      if (Number.isFinite(time) && Number.isFinite(corner)) map.circles.push({ time, corner: corner & 3 });
    } else if (section === "HitObjects") {
      // x,y,time,type,hitSound,objectParams,hitSample
      const p = line.split(",");
      const object = parseObject(p);
      if (object) map.objects.push(object);
      const x = Number(p[0]);
      const time = Number(p[2]);
      const type = Number(p[3]);
      if (!Number.isFinite(x) || !Number.isFinite(time) || type & 8) continue; // spinners have no lane
      // Mania hold notes keep their end time before the first ":".
      const end = type & 128 ? Number(p[5]?.split(":")[0]) : NaN;
      map.hitObjects.push({ x, time, end: end > time ? end : null });
    }
  }

  map.custom = map.creator === EDITOR_CREATOR;
  map.ar ??= map.od; // old maps have no approach rate of their own
  map.objects.sort((a, b) => a.time - b.time);
  map.circles.sort((a, b) => a.time - b.time);
  map.timingPoints.sort((a, b) => a.time - b.time);
  map.hitObjects.sort((a, b) => a.time - b.time);
  return map;
}
