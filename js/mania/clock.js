// Audio timing shared by the rhythm game and the offset test.

/**
 * The audio context time (seconds) being heard at performance time perf
 * (ms), using the output timestamp so speaker latency is included.
 */
export function heardTime(audio, perf) {
  const ts = audio.getOutputTimestamp?.();
  return ts && ts.performanceTime > 0
    ? ts.contextTime + (perf - ts.performanceTime) / 1000
    : audio.currentTime - (audio.outputLatency || audio.baseLatency || 0);
}

/** Schedules a short metronome click at context time `when`. */
export function click(audio, when, accent, destination) {
  const osc = audio.createOscillator();
  const gain = audio.createGain();
  osc.frequency.value = accent ? 1600 : 1000;
  gain.gain.setValueAtTime(0.0001, when);
  gain.gain.exponentialRampToValueAtTime(accent ? 0.7 : 0.45, when + 0.002);
  gain.gain.exponentialRampToValueAtTime(0.0001, when + 0.06);
  osc.connect(gain).connect(destination);
  osc.start(when);
  osc.stop(when + 0.08);
}
