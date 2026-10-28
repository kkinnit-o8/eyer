// Peripheral rhythm mode (one key, or 4-key mania): loading an osu! map,
// settings, play, and results.

import { $, setStatus, readStorage, writeStorage } from "../ui.js";
import { extractEntries, mapsFromEntries } from "./osu.js";
import { chartAudioFile } from "./autochart.js";
import { listSongs, saveSong, loadSongFiles, touchSong, removeSong } from "./library.js";
import { buildNotes, buildOneKeyNotes, chartEnd, bpmSections, beatGrid, cornerTargets, bpmSummary, snapToBeat } from "./chart.js";
import { EditorRound, levelToOsu } from "./editor.js";
import { ManiaGame, JUDGMENTS } from "./game.js";
import { OffsetTest, COUNT_IN, TAPS } from "./offset.js";

const SETTINGS_KEY = "eyer.mania";
const DEFAULTS = {
  game: "onekey", density: "half", shape: "box", rhythm: "bar", scrollMs: 1000, offsetMs: 0, autoplay: false,
  mode: "play", speed: 1, eyes: true, repeat: false,
};
const MIN_TARGET_GAP_MS = 450;
const PREROLL_MS = 3000; // practice: music starts this long before the section

export class ManiaMode {
  /**
   * setState(name) switches screens, gaze(now) returns the current gaze
   * point (or null), exit() goes back to the main menu. learn(x, y, perf)
   * reports that the player looked at (x, y) (viewport fractions) at perf;
   * tunedCount() is how often tracking has corrected itself (null without a
   * camera).
   */
  constructor({ setState, gaze, exit, learn, tunedCount }) {
    this.setState = setState;
    this.gaze = gaze;
    this.exit = exit;
    this.learn = learn;
    this.tunedCount = tunedCount;
    this.maps = [];
    this.audioFiles = new Map();
    this.song = null; // { id, title, artist, addedAt, playedAt } of the loaded song
    this.library = []; // saved songs
    this.section = { from: 0, to: Infinity }; // practice section, ms
    this.offsetTest = null;
    this.entries = new Map(); // the loaded song's files, for saving new levels
    this.editor = null; // level being made: { stage, snap, notes, circles }
    this.round = null; // editor recording round in progress
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

  async open() {
    this.setState("mania-menu");
    await this.#refreshLibrary();
    // Pick up where you left off: the song you played last.
    if (!this.map && this.library.length) this.#loadSaved(this.library[0].id);
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
    $("mania-library").addEventListener("change", (e) => {
      if (e.target.value) this.#loadSaved(e.target.value);
    });
    $("btn-mania-remove").addEventListener("click", async () => {
      try {
        await removeSong(this.song.id);
      } catch (err) {
        console.error(err);
      }
      await this.#refreshLibrary();
    });

    const game = $("mania-game");
    const density = $("mania-density");
    game.value = s.game;
    density.value = s.density;
    const showDensity = () => {
      for (const el of document.querySelectorAll("[data-one-key]")) el.hidden = s.game !== "onekey";
    };
    showDensity();
    game.addEventListener("change", () => {
      s.game = game.value;
      this.#save();
      showDensity();
      this.#chart();
    });
    density.addEventListener("change", () => {
      s.density = density.value;
      this.#save();
      this.#chart();
    });
    const shape = $("mania-shape");
    shape.value = s.shape;
    shape.addEventListener("change", () => {
      s.shape = shape.value;
      this.#save();
    });

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

    this.#wirePractice();
    $("btn-offset-test").addEventListener("click", () => this.#openOffsetTest());
    $("btn-offset-again").addEventListener("click", () => this.#openOffsetTest());
    $("btn-offset-cancel").addEventListener("click", () => this.#closeOffsetTest());
    $("btn-offset-use").addEventListener("click", () => {
      s.offsetMs = this.offsetTest.offset;
      $("mania-offset").value = s.offsetMs;
      this.#save();
      this.#closeOffsetTest();
    });
    $("offset-pulse").addEventListener("pointerdown", (e) => this.#tapOffset(e.timeStamp));
    this.#wireEditor();

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

  #wirePractice() {
    const s = this.settings;
    const mode = $("mania-mode");
    const showPractice = () => {
      for (const el of document.querySelectorAll("[data-practice]")) el.hidden = s.mode !== "practice";
    };
    mode.value = s.mode;
    showPractice();
    mode.addEventListener("change", () => {
      s.mode = mode.value;
      this.#save();
      showPractice();
    });
    const speed = $("mania-speed");
    speed.value = String(s.speed);
    speed.addEventListener("change", () => {
      s.speed = Number(speed.value);
      this.#save();
    });
    for (const [id, key] of [["mania-eyes", "eyes"], ["mania-repeat", "repeat"]]) {
      const box = $(id);
      box.checked = s[key];
      box.addEventListener("change", () => {
        s[key] = box.checked;
        this.#save();
      });
    }
    const from = $("mania-from");
    const to = $("mania-to");
    from.addEventListener("input", () => {
      if (Number(from.value) >= Number(to.value)) from.value = Number(to.value) - 1;
      this.section.from = Number(from.value) * 1000;
      this.#showSection();
    });
    to.addEventListener("input", () => {
      if (Number(to.value) <= Number(from.value)) to.value = Number(from.value) + 1;
      this.section.to = Number(to.value) * 1000;
      this.#showSection();
    });
  }

  // Practice section sliders cover the whole chart again.
  #resetSection() {
    const seconds = Math.ceil(this.end / 1000);
    for (const el of [$("mania-from"), $("mania-to")]) {
      el.min = 0;
      el.max = seconds;
    }
    $("mania-from").value = 0;
    $("mania-to").value = seconds;
    this.section = { from: 0, to: seconds * 1000 };
    this.#showSection();
  }

  #showSection() {
    const { from, to } = this.section;
    const count = this.notes.filter((n) => n.time >= from && n.time <= to).length;
    $("mania-section-value").textContent = `${clock(from)} – ${clock(to)} · ${count} notes`;
  }

  // Map files the player picked or dropped: show them and save the song.
  async #load(files) {
    const status = $("mania-status");
    setStatus(status, "Reading map…");
    let entries;
    try {
      entries = await extractEntries(files);
      // Just a song, no osu! map: listen to it and make a chart.
      const names = [...entries.keys()];
      if (!names.some((n) => n.endsWith(".osu")) && names.length) {
        setStatus(status, "Listening to the song and making a chart… (a few seconds)");
        const original = [...files].find((f) => f.name.toLowerCase() === names[0])?.name ?? names[0];
        const osu = await chartAudioFile(entries.get(names[0]), original);
        entries.set(`${names[0]}.auto.osu`, new TextEncoder().encode(osu));
      }
      this.#use(entries, null);
      setStatus(status, "");
    } catch (err) {
      console.error(err);
      setStatus(status, err.message || "Couldn't read that file.", "bad");
      return;
    }
    try {
      await saveSong(this.song, entries);
    } catch (err) {
      console.warn(err);
      setStatus(status, "Couldn't save this song for next time.", "warn");
    }
    await this.#refreshLibrary();
  }

  async #loadSaved(id) {
    const status = $("mania-status");
    setStatus(status, "Loading song…");
    try {
      this.#use(await loadSongFiles(id), this.library.find((s) => s.id === id));
      setStatus(status, "");
    } catch (err) {
      console.error(err);
      setStatus(status, "Couldn't load that saved song.", "bad");
    }
    await this.#refreshLibrary();
  }

  // Shows the difficulties in these files. song is the saved record, or null
  // for a fresh import.
  #use(entries, song) {
    const { maps, audioFiles } = mapsFromEntries(entries);
    if (!maps.length) throw new Error("No osu! difficulties with notes in that file.");
    // Your own levels first, then real 4K mania charts, other key counts,
    // then converts; easiest first within each group.
    const rank = (m) => (m.custom ? -1 : m.mode === 3 ? (m.keys === 4 ? 0 : 1) : 2);
    maps.sort((a, b) => rank(a) - rank(b) || a.hitObjects.length - b.hitObjects.length);
    this.maps = maps;
    this.entries = entries;
    this.audioFiles = audioFiles;
    this.buffers.clear();

    const { artist, title, setId } = maps[0];
    const now = Date.now();
    this.song = song ?? {
      id: setId ? `osu-${setId}` : `${artist} - ${title}`.toLowerCase(),
      title,
      artist,
      addedAt: now,
      playedAt: now,
    };

    const select = $("mania-diff");
    select.replaceChildren(
      ...maps.map((m, i) => {
        const kind = m.custom ? "your level" : m.mode === 3 ? `${m.keys}K mania` : "osu!standard";
        return new Option(`${m.version || "Normal"} (${kind}, ${m.hitObjects.length} notes)`, String(i));
      }),
    );
    $("mania-title").textContent = [artist, title].filter(Boolean).join(" - ") || "Untitled";
    $("mania-map").hidden = false;
    $("mania-drop").querySelector("strong").textContent = "Add a map";
    $("mania-drop").closest(".panel").classList.add("loaded");
    this.#select(0);
    $("btn-mania-start").focus({ preventScroll: true });
  }

  async #refreshLibrary() {
    try {
      this.library = await listSongs();
    } catch (err) {
      console.warn("Saved songs unavailable.", err);
      this.library = [];
    }
    const saved = this.song && this.library.some((s) => s.id === this.song.id);
    const select = $("mania-library");
    select.replaceChildren(
      new Option(`Saved songs (${this.library.length})`, ""),
      ...this.library.map((s) => new Option([s.artist, s.title].filter(Boolean).join(" - ") || "Untitled", s.id)),
    );
    select.value = saved ? this.song.id : "";
    select.hidden = !this.library.length;
    $("btn-mania-remove").hidden = !saved;
  }

  #select(index) {
    this.map = this.maps[index];
    this.timing = bpmSections(this.map);
    this.#chart();
  }

  // Builds the notes for the chosen game: the map as 4-key mania, or
  // collapsed onto one key.
  #chart() {
    if (!this.map) return;
    const s = this.settings;
    // Your own levels are one-key, with every note exactly as you placed it.
    this.notes = this.map.custom
      ? buildOneKeyNotes(this.map, this.timing.sections, "all")
      : s.game === "mania"
        ? buildNotes(this.map)
        : buildOneKeyNotes(this.map, this.timing.sections, s.density);
    this.end = chartEnd(this.notes);
    this.#resetSection();
    this.#showInfo();
    $("btn-mania-start").disabled = !this.#audioName() || !this.notes.length;
    $("btn-editor").disabled = !this.#audioName();
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
    const notes = this.map.custom
      ? `your level: ${this.notes.length} notes on one key`
      : this.settings.game === "mania"
        ? `${this.notes.length} notes${holds ? ` (${holds} holds)` : ""}`
        : `${this.notes.length} notes on one key (from ${this.map.hitObjects.length})`;
    const circles = this.map.circles.length;
    setStatus(
      info,
      `${bpmText}${this.timing.estimated ? " (estimated from the notes)" : ""} · ${bpm.meter}/4 · ${clock(this.end)} · ` +
        `${notes}. ` +
        (circles ? `${circles} eye circles placed by you.` : `A corner circle lands every ${(gap / 1000).toFixed(2)} s.`),
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
    // Space is a game key now; it mustn't also press a focused button.
    document.activeElement?.blur();
    try {
      const s = this.settings;
      const practice = s.mode === "practice";
      const rate = practice ? s.speed : 1;
      const buffer = await this.#buffer();
      const beats = beatGrid(this.timing.sections, this.end + 2000);
      let notes = this.notes;
      // Levels from the editor bring their own eye circles.
      const own = this.map.circles;
      let targets =
        practice && !s.eyes ? [] : own.length ? own : cornerTargets(beats, s.rhythm, notes[0].time - 1500, this.end);
      let audioFrom = 0;
      if (practice) {
        const { from, to } = this.section;
        notes = notes.filter((n) => n.time >= from && n.time <= to);
        if (!notes.length) throw new RangeError("No notes in that section.");
        targets = targets.filter((t) => t.time >= notes[0].time - 1500 && t.time <= to);
        // Start the music a little before the section, so you can hear your way in.
        audioFrom = Math.max(0, notes[0].time - PREROLL_MS * rate);
      }
      // The game runs in real time from where the music starts.
      const toGame = (t) => (t - audioFrom) / rate;
      this.game = new ManiaGame({
        lanes: s.game === "mania" && !this.map.custom ? 4 : 1,
        shape: s.shape,
        notes: notes.map((n) => ({ ...n, time: toGame(n.time), end: n.end === null ? null : toGame(n.end) })),
        targets: targets.map((t) => ({ ...t, time: toGame(t.time) })),
        beats: beats.map((b) => toGame(b.time)),
        audioFrom,
        rate,
        od: this.map.od,
        audio: this.audio,
        buffer,
        scrollMs: this.settings.scrollMs,
        offsetMs: this.settings.offsetMs,
        autoplay: this.settings.autoplay,
        onLook: (x, y, perf) => this.learn(x / this.width, y / this.height, perf),
        width: this.width,
        height: this.height,
      });
      this.tunedAtStart = this.tunedCount();
      this.game.start();
      if (this.library.some((s) => s.id === this.song.id)) touchSong(this.song).catch(() => {});
      this.setState("mania");
    } catch (err) {
      console.error(err);
      const message = err instanceof RangeError ? err.message : "Couldn't play this song's audio file.";
      setStatus($("mania-status"), message, "bad");
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
    if (!this.game) return;
    this.game.update(now, this.gaze(now));
    if (!this.game.isOver()) return;
    if (this.settings.mode === "practice" && this.settings.repeat) {
      // Practice on repeat: go straight into the section again.
      this.game.stop();
      this.game = null;
      this.#start();
    } else {
      this.#finish();
    }
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
    if (this.offsetTest) {
      if (e.code === "Escape") this.#closeOffsetTest();
      else if (e.code === "Space") {
        e.preventDefault();
        if (!e.repeat) this.#tapOffset(e.timeStamp);
      }
      return;
    }
    if (!this.game) return;
    if (e.code === "Escape") {
      this.game.stop();
      this.game = null;
      this.open();
      return;
    }
    const lane = this.game.keyCodes.indexOf(e.code);
    if (lane < 0) return;
    e.preventDefault();
    if (!e.repeat) this.game.keyDown(lane, e.timeStamp);
  }

  keyup(e) {
    if (!this.game) return;
    const lane = this.game.keyCodes.indexOf(e.code);
    if (lane < 0) return;
    e.preventDefault();
    this.game.keyUp(lane, e.timeStamp);
  }

  #finish() {
    this.game.stop();
    const r = this.game.results();
    const keys = this.game.laneCount === 1 ? "one key" : "4 keys";
    const practice = this.settings.mode === "practice" ? ` · practice ${this.game.rate}×` : "";
    this.game = null;

    $("mr-title").textContent = `${this.map.title} [${this.map.version}] · ${keys}${practice}`;
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
    $("mr-eyes").parentElement.hidden = !e.total;
    $("mr-eyes").replaceChildren(
      ...row("On the beat", `${e.onBeat} / ${e.total}`, "#4ade80"),
      ...row("Late", e.late, "#fbbf24"),
      ...row("Missed", e.missed, "#a3a3a3"),
      ...row("Time in the middle", `${(e.centerMs / 1000).toFixed(1)} s`, "#f87171"),
      // Each popped circle can teach the tracker where your eyes really were.
      ...(this.tunedCount() === null ? [] : row("Tracking tuned", `${this.tunedCount() - this.tunedAtStart}×`)),
    );
    this.setState("mania-results");
  }

  // ---- Level editor -----------------------------------------------------

  #wireEditor() {
    $("btn-editor").addEventListener("click", () => this.#openEditor());
    $("btn-editor-cancel").addEventListener("click", () => {
      this.editor = null;
      this.setState("mania-menu");
    });
    $("btn-editor-go").addEventListener("click", () => {
      const stage = this.editor.stage;
      if (stage === "intro") this.#record("notes");
      else if (stage === "notes") this.#record("circles");
      else this.#saveLevel();
    });
    $("btn-editor-redo").addEventListener("click", () => this.#record(this.editor.stage));
    $("btn-editor-skip").addEventListener("click", () => {
      this.editor.circles = [];
      this.editor.stage = "circles";
      this.#showEditorStage();
    });
    $("editor-snap").addEventListener("change", (e) => {
      if (this.editor) this.editor.snap = e.target.checked;
    });
  }

  #openEditor() {
    if (!this.map) return;
    const canSnap = this.timing.sections.length > 0;
    this.editor = { stage: "intro", snap: canSnap, notes: [], circles: [] };
    $("editor-snap").checked = canSnap;
    $("editor-snap").disabled = !canSnap;
    $("editor-song").textContent = $("mania-title").textContent;
    $("editor-name").value = "My level";
    this.#showEditorStage();
    this.setState("editor");
  }

  #showEditorStage() {
    const { stage, notes, circles } = this.editor;
    for (const el of document.querySelectorAll("[data-stage]")) el.hidden = el.dataset.stage !== stage;
    const go = $("btn-editor-go");
    go.textContent = { intro: "Start round 1: notes", notes: "Round 2: eye circles", circles: "Save level" }[stage];
    go.disabled = stage !== "intro" && !notes.length;
    $("btn-editor-redo").hidden = stage === "intro";
    $("btn-editor-redo").textContent = stage === "notes" ? "Redo notes" : "Redo eye circles";
    $("btn-editor-skip").hidden = stage !== "notes" || !notes.length;
    const until = notes.length ? clock(notes[notes.length - 1]) : "0:00";
    setStatus(
      $("editor-notes-summary"),
      notes.length ? `${notes.length} notes, up to ${until}.` : "No notes yet. Redo the round and press Space along with the song.",
      notes.length ? "ok" : "warn",
    );
    setStatus(
      $("editor-circles-summary"),
      `${notes.length} notes and ` +
        (circles.length ? `${circles.length} eye circles.` : "no eye circles of your own: they'll follow the beat instead."),
      "ok",
    );
    document.querySelector('[data-screen="editor"] .buttons button:not([hidden]):not(:disabled)')?.focus({ preventScroll: true });
  }

  async #record(kind) {
    this.audio ??= new AudioContext({ latencyHint: "interactive" });
    this.audio.resume();
    document.activeElement?.blur();
    const buffer = await this.#buffer();
    const { sections } = this.timing;
    const snap = (t) => {
      if (!this.editor.snap) return t;
      // Notes snap to quarter or third beats; eye circles to half beats.
      return snapToBeat(t, sections, kind === "notes" ? [4, 3] : [2]);
    };
    this.round = new EditorRound({ kind, audio: this.audio, buffer, offsetMs: this.settings.offsetMs, notes: this.editor.notes, snap });
    this.setState("editor-rec");
  }

  #endRound() {
    const round = this.round;
    this.round = null;
    round.stop();
    if (round.kind === "notes") {
      this.editor.notes = round.result();
      this.editor.circles = [];
      this.editor.stage = "notes";
    } else {
      this.editor.circles = round.result();
      this.editor.stage = "circles";
    }
    this.#showEditorStage();
    this.setState("editor");
  }

  stepEditor(now) {
    if (this.round?.isOver(now)) this.#endRound();
  }

  drawEditor(ctx, now) {
    this.round?.draw(ctx, now, this.width, this.height);
  }

  editorKey(e) {
    if (!this.round) return;
    const add = this.round.kind === "notes" ? e.code === "Space" : e.code === "Enter" || e.code === "NumpadEnter";
    if (add || e.code === "Space") e.preventDefault();
    if (add && !e.repeat) this.round.add(e.timeStamp);
    else if (e.code === "Backspace") {
      e.preventDefault();
      this.round.undo();
    } else if (e.code === "Escape") this.#endRound();
  }

  editorPointer(e) {
    if (this.round?.kind === "circles") this.round.add(e.timeStamp);
  }

  async #saveLevel() {
    const name = $("editor-name").value.trim() || "My level";
    const { notes, circles } = this.editor;
    const osu = levelToOsu({ map: this.map, name, sections: this.timing.sections, notes, circles });
    const file = `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.eyer.osu`;
    this.entries.set(file, new TextEncoder().encode(osu));
    this.#use(this.entries, this.song);
    // Pick the level you just made.
    const index = this.maps.findIndex((m) => m.custom && m.version === name);
    $("mania-diff").value = String(Math.max(0, index));
    this.#select(Math.max(0, index));
    this.editor = null;
    this.setState("mania-menu");
    try {
      await saveSong(this.song, this.entries);
      setStatus($("mania-status"), `Saved "${name}". It's in the difficulty list.`, "ok");
    } catch (err) {
      console.warn(err);
      setStatus($("mania-status"), `"${name}" is ready to play, but couldn't be saved for next time.`, "warn");
    }
    await this.#refreshLibrary();
  }

  // ---- Note offset test -------------------------------------------------

  #openOffsetTest() {
    this.offsetTest?.stop();
    this.audio ??= new AudioContext({ latencyHint: "interactive" });
    this.audio.resume();
    document.activeElement?.blur();
    this.offsetTest = new OffsetTest(this.audio);
    $("btn-offset-use").disabled = true;
    this.setState("offset");
  }

  #closeOffsetTest() {
    this.offsetTest?.stop();
    this.offsetTest = null;
    this.setState("mania-menu");
  }

  #tapOffset(perf) {
    if (!this.offsetTest?.tap(perf)) return;
    const pulse = $("offset-pulse");
    pulse.classList.remove("tap");
    void pulse.offsetWidth; // restart the animation
    pulse.classList.add("tap");
  }

  /** Called every frame on the offset test screen. */
  stepOffset(now) {
    const test = this.offsetTest;
    if (!test) return;
    const status = $("offset-status");
    const taps = test.errors.length;
    const heard = test.heardClicks(now);
    if (test.done) {
      const ms = test.offset;
      const when = ms === 0 ? "right on the clicks" : `${Math.abs(ms)} ms ${ms > 0 ? "after" : "before"} the clicks`;
      setStatus(status, `You press ${when}. Use ${ms} ms as the note offset?`, "ok");
      $("btn-offset-use").textContent = `Use ${ms} ms`;
      $("btn-offset-use").disabled = false;
    } else if (heard <= COUNT_IN) {
      setStatus(status, heard ? `Listen… ${heard}` : "Listen…");
    } else if (heard > COUNT_IN + TAPS * 2) {
      setStatus(status, "The clicks ran out. Start over and tap along with each click.", "warn");
    } else {
      setStatus(status, `Tap along: ${taps} / ${TAPS}`);
    }
  }
}

function clock(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}
