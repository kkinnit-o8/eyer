// Peripheral mania mode: loading an osu! map, settings, play, and results.

import { $, setStatus, readStorage, writeStorage } from "../ui.js";
import { readMapFiles } from "./osu.js";
import { buildNotes, chartEnd, bpmSections, beatGrid, cornerTargets, bpmSummary } from "./chart.js";
import { ManiaGame, KEY_CODES, JUDGMENTS } from "./game.js";

const SETTINGS_KEY = "eyer.mania";
const DEFAULTS = { rhythm: "bar", scrollMs: 1000, offsetMs: 0, autoplay: false };
const MIN_TARGET_GAP_MS = 450;

export class ManiaMode {
  /**
   * setState(name) switches screens, gaze(now) returns the current gaze
   * point (or null), exit() goes back to the main menu.
   */
  constructor({ setState, gaze, exit }) {
    this.setState = setState;
    this.gaze = gaze;
    this.exit = exit;
    this.maps = [];
    this.audioFiles = new Map();
    this.buffers = new Map(); // decoded audio, by file name
    this.map = null;
    this.notes = [];
    this.game = null;
    this.audio = null;
    this.width = window.innerWidth;
    this.height = window.innerHeight;
    try {
      this.settings = { ...DEFAULTS, ...JSON.parse(readStorage(SETTINGS_KEY) || "{}") };
    } catch {
      this.settings = { ...DEFAULTS };
    }
    this.#wire();
  }

  open() {
    this.setState("mania-menu");
  }

  // ---- Map loading and settings -----------------------------------------

  #wire() {
    const s = this.settings;
    const screen = document.querySelector('[data-screen="mania-menu"]');
    const drop = $("mania-drop");
    const input = $("mania-file");
    input.addEventListener("change", () => {
      // Copy the list first: clearing the input empties it.
      if (input.files.length) this.#load([...input.files]);
      input.value = "";
    });
    // Dropping anywhere on the screen works; the drop zone just lights up.
    screen.addEventListener("dragover", (e) => {
      e.preventDefault();
      drop.classList.add("over");
    });
    screen.addEventListener("dragleave", (e) => {
      if (!screen.contains(e.relatedTarget)) drop.classList.remove("over");
    });
    screen.addEventListener("drop", (e) => {
      e.preventDefault();
      drop.classList.remove("over");
      if (e.dataTransfer.files.length) this.#load([...e.dataTransfer.files]);
    });

    $("mania-diff").addEventListener("change", (e) => this.#select(Number(e.target.value)));

    const rhythm = $("mania-rhythm");
    rhythm.value = s.rhythm;
    rhythm.addEventListener("change", () => {
      s.rhythm = rhythm.value;
      this.#save();
      this.#showInfo();
    });

    const scroll = $("mania-scroll");
    scroll.value = s.scrollMs;
    $("mania-scroll-value").textContent = `${s.scrollMs} ms`;
    scroll.addEventListener("input", () => {
      s.scrollMs = Number(scroll.value);
      $("mania-scroll-value").textContent = `${s.scrollMs} ms`;
      this.#save();
    });

    const offset = $("mania-offset");
    offset.value = s.offsetMs;
    offset.addEventListener("change", () => {
      s.offsetMs = Number(offset.value) || 0;
      offset.value = s.offsetMs;
      this.#save();
    });

    const autoplay = $("mania-autoplay");
    autoplay.checked = s.autoplay;
    autoplay.addEventListener("change", () => {
      s.autoplay = autoplay.checked;
      this.#save();
    });

    $("btn-mania-start").addEventListener("click", () => this.#start());
    $("btn-mania-back").addEventListener("click", () => this.exit());
    $("btn-mania-retry").addEventListener("click", () => this.#start());
    $("btn-mania-maps").addEventListener("click", () => this.open());
    $("btn-mania-menu").addEventListener("click", () => this.exit());
  }

  #save() {
    writeStorage(SETTINGS_KEY, JSON.stringify(this.settings));
  }

  async #load(files) {
    const status = $("mania-status");
    setStatus(status, "Reading map…");
    try {
      const { maps, audioFiles } = await readMapFiles(files);
      if (!maps.length) throw new Error("No osu! difficulties with notes in that file.");
      // Real 4K mania charts first, then other key counts, then converts;
      // easiest first within each group.
      const rank = (m) => (m.mode === 3 ? (m.keys === 4 ? 0 : 1) : 2);
      maps.sort((a, b) => rank(a) - rank(b) || a.hitObjects.length - b.hitObjects.length);
      this.maps = maps;
      this.audioFiles = audioFiles;
      this.buffers.clear();

      const select = $("mania-diff");
      select.replaceChildren(
        ...maps.map((m, i) => {
          const kind = m.mode !== 3 ? "converted to 4K" : m.keys === 4 ? "4K" : `${m.keys}K → 4K`;
          return new Option(`${m.version || "Normal"} (${kind}, ${m.hitObjects.length} notes)`, String(i));
        }),
      );
      $("mania-title").textContent = [maps[0].artist, maps[0].title].filter(Boolean).join(" - ") || "Untitled";
      $("mania-map").hidden = false;
      setStatus(status, "");
      this.#select(0);
      $("btn-mania-start").focus({ preventScroll: true });
    } catch (err) {
      console.error(err);
      setStatus(status, err.message || "Couldn't read that file.", "bad");
    }
  }

  #select(index) {
    this.map = this.maps[index];
    this.notes = buildNotes(this.map);
    this.end = chartEnd(this.notes);
    this.timing = bpmSections(this.map);
    this.#showInfo();
    $("btn-mania-start").disabled = !this.#audioName() || !this.notes.length;
  }

  #audioName() {
    const wanted = this.map.audioFilename.toLowerCase();
    if (this.audioFiles.has(wanted)) return wanted;
    // Loose files with a renamed song: use it if it's the only one.
    return this.audioFiles.size === 1 ? [...this.audioFiles.keys()][0] : null;
  }

  #showInfo() {
    if (!this.map) return;
    const info = $("mania-info");
    if (!this.#audioName()) {
      setStatus(info, `The song file "${this.map.audioFilename}" isn't in the map. Add it alongside the .osu file.`, "bad");
      return;
    }
    const bpm = bpmSummary(this.timing.sections, this.end);
    if (!bpm) {
      setStatus(info, "Couldn't find a tempo for this map, so there are no corner circles.", "warn");
      return;
    }
    const round = (v) => Math.round(v);
    const bpmText = round(bpm.min) === round(bpm.max) ? `${round(bpm.bpm)} BPM` : `${round(bpm.min)}–${round(bpm.max)} BPM`;
    const beats = this.settings.rhythm === "bar" ? bpm.meter : Number(this.settings.rhythm);
    let gap = bpm.beatLength * beats;
    while (gap < MIN_TARGET_GAP_MS) gap += bpm.beatLength;
    const holds = this.notes.filter((n) => n.end !== null).length;
    const minutes = Math.floor(this.end / 60000);
    const seconds = String(Math.floor((this.end % 60000) / 1000)).padStart(2, "0");
    setStatus(
      info,
      `${bpmText}${this.timing.estimated ? " (estimated from the notes)" : ""} · ${bpm.meter}/4 · ${minutes}:${seconds} · ` +
        `${this.notes.length} notes${holds ? ` (${holds} holds)` : ""}. ` +
        `A corner circle lands every ${(gap / 1000).toFixed(2)} s.`,
    );
  }

  // ---- Playing ----------------------------------------------------------

  async #start() {
    if (!this.map) return;
    // Create and resume audio inside the click so autoplay rules allow it.
    this.audio ??= new AudioContext({ latencyHint: "interactive" });
    this.audio.resume();
    const button = $("btn-mania-start");
    button.disabled = true;
    try {
      const buffer = await this.#buffer();
      const beats = beatGrid(this.timing.sections, this.end + 2000);
      const first = this.notes[0].time;
      const targets = cornerTargets(beats, this.settings.rhythm, first - 1500, this.end);
      this.game = new ManiaGame({
        notes: this.notes,
        targets,
        od: this.map.od,
        audio: this.audio,
        buffer,
        scrollMs: this.settings.scrollMs,
        offsetMs: this.settings.offsetMs,
        autoplay: this.settings.autoplay,
        width: this.width,
        height: this.height,
      });
      this.game.start();
      this.setState("mania");
    } catch (err) {
      console.error(err);
      setStatus($("mania-status"), "Couldn't play this song's audio file.", "bad");
      this.setState("mania-menu");
    } finally {
      button.disabled = false;
    }
  }

  async #buffer() {
    const name = this.#audioName();
    if (!this.buffers.has(name)) {
      setStatus($("mania-status"), "Decoding audio…");
      // decodeAudioData takes ownership of the buffer, so hand it a copy.
      this.buffers.set(name, await this.audio.decodeAudioData(this.audioFiles.get(name).slice().buffer));
      setStatus($("mania-status"), "");
    }
    return this.buffers.get(name);
  }

  step(now) {
    this.game.update(now, this.gaze(now));
    if (this.game.isOver()) this.#finish();
  }

  draw(ctx) {
    this.game?.draw(ctx);
  }

  resize(width, height) {
    this.width = width;
    this.height = height;
    this.game?.resize(width, height);
  }

  keydown(e) {
    if (e.code === "Escape") {
      this.game.stop();
      this.game = null;
      this.open();
      return;
    }
    const lane = KEY_CODES.indexOf(e.code);
    if (lane < 0) return;
    e.preventDefault();
    if (!e.repeat) this.game.keyDown(lane, e.timeStamp);
  }

  keyup(e) {
    const lane = KEY_CODES.indexOf(e.code);
    if (lane >= 0) this.game.keyUp(lane, e.timeStamp);
  }

  #finish() {
    this.game.stop();
    const r = this.game.results();
    this.game = null;

    $("mr-title").textContent = `${this.map.title} [${this.map.version}]`;
    $("mr-acc").textContent = `${(r.accuracy * 100).toFixed(2)}%`;
    const row = (label, value, color) => {
      const dt = Object.assign(document.createElement("dt"), { textContent: label });
      const dd = Object.assign(document.createElement("dd"), { textContent: value });
      if (color) dt.style.color = color;
      return [dt, dd];
    };
    $("mr-notes").replaceChildren(
      ...row("Max combo", r.maxCombo),
      ...Object.entries(JUDGMENTS).flatMap(([key, j]) => row(j.label, r.counts[key], j.color)),
    );
    const e = r.eyes;
    $("mr-eyes").replaceChildren(
      ...row("On the beat", `${e.onBeat} / ${e.total}`, "#4ade80"),
      ...row("Late", e.late, "#fbbf24"),
      ...row("Missed", e.missed, "#a3a3a3"),
      ...row("Time in the middle", `${(e.centerMs / 1000).toFixed(1)} s`, "#f87171"),
    );
    this.setState("mania-results");
  }
}
