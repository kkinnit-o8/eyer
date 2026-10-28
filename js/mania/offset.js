// Finds the note offset: a metronome clicks, the player taps along, and the
// typical gap between hearing a click and pressing becomes the offset.

import { heardTime, click } from "./clock.js";

const BEAT_MS = 500; // 120 BPM
export const COUNT_IN = 4; // clicks to listen to before taps count
export const TAPS = 16;
const MAX_ERROR_MS = 200; // taps further off than this are ignored

export class OffsetTest {
  constructor(audio) {
    this.audio = audio;
    this.errors = [];
    // All clicks go through one gain node, so stopping silences queued ones.
    this.out = audio.createGain();
    this.out.connect(audio.destination);
    this.startAt = audio.currentTime + 0.4;
    this.scheduled = 0;
    this.#schedule();
    this.timer = setInterval(() => this.#schedule(), 250);
  }

  // Keep about a second of clicks queued ahead of the audio clock.
  #schedule() {
    const until = this.audio.currentTime + 1;
    while (this.scheduled < COUNT_IN + TAPS * 2 && this.startAt + (this.scheduled * BEAT_MS) / 1000 < until) {
      click(this.audio, this.startAt + (this.scheduled * BEAT_MS) / 1000, this.scheduled % 4 === 0, this.out);
      this.scheduled++;
    }
  }

  /** Clicks heard so far (count-in included). */
  heardClicks(perf) {
    return Math.max(0, Math.floor(((heardTime(this.audio, perf) - this.startAt) * 1000) / BEAT_MS) + 1);
  }

  /** Records a tap at performance time perf. Returns false if it didn't count. */
  tap(perf) {
    const position = (heardTime(this.audio, perf) - this.startAt) * 1000;
    const beat = Math.round(position / BEAT_MS);
    const error = position - beat * BEAT_MS;
    if (beat < COUNT_IN || Math.abs(error) > MAX_ERROR_MS || this.done) return false;
    this.errors.push(error);
    if (this.done) this.stop();
    return true;
  }

  get done() {
    return this.errors.length >= TAPS;
  }

  /** Median tap error in ms; positive means taps come after the clicks. */
  get offset() {
    if (!this.errors.length) return 0;
    const sorted = [...this.errors].sort((a, b) => a - b);
    const m = sorted.length >> 1;
    return Math.round(sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2);
  }

  stop() {
    clearInterval(this.timer);
    this.out.disconnect();
  }
}
