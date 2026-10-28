// Reading osu! beatmaps: .osz archives (zip files) and loose .osu files.

const FFLATE_URL = "https://cdn.jsdelivr.net/npm/fflate@0.8.2/esm/browser.js";
const AUDIO_FILE = /\.(mp3|ogg|wav|m4a|aac|opus|flac)$/i;

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

function baseName(path) {
  return path.split(/[\\/]/).pop().toLowerCase();
}

/** Parses the parts of an .osu file the game needs. */
export function parseOsu(text) {
  const map = {
    title: "",
    artist: "",
    version: "",
    setId: 0,
    mode: 0,
    keys: 4,
    od: 5,
    audioFilename: "",
    timingPoints: [],
    hitObjects: [],
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
        case "BeatmapSetID": map.setId = Number(value) || 0; break;
        case "CircleSize": map.keys = Math.round(Number(value)); break; // key count in mania
        case "OverallDifficulty": map.od = Number(value); break;
      }
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
    } else if (section === "HitObjects") {
      // x,y,time,type,hitSound,objectParams,hitSample
      const p = line.split(",");
      const x = Number(p[0]);
      const time = Number(p[2]);
      const type = Number(p[3]);
      if (!Number.isFinite(x) || !Number.isFinite(time) || type & 8) continue; // spinners have no lane
      // Mania hold notes keep their end time before the first ":".
      const end = type & 128 ? Number(p[5]?.split(":")[0]) : NaN;
      map.hitObjects.push({ x, time, end: end > time ? end : null });
    }
  }

  map.timingPoints.sort((a, b) => a.time - b.time);
  map.hitObjects.sort((a, b) => a.time - b.time);
  return map;
}
