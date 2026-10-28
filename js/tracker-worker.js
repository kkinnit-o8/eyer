// Face tracking off the main thread. Receives camera frames as ImageBitmaps
// and sends back gaze features, so the model never stalls the game's drawing.

import { loadLandmarker, analyze } from "./face.js";

let landmarker = null;

self.onmessage = async ({ data }) => {
  if (data.type === "init") {
    try {
      landmarker = await loadLandmarker(true);
      self.postMessage({ type: "ready" });
    } catch (err) {
      self.postMessage({ type: "error", message: String(err?.message ?? err) });
    }
    return;
  }
  if (data.type === "frame") {
    const { bitmap, time } = data;
    let result = { face: false };
    try {
      result = analyze(landmarker.detectForVideo(bitmap, time), bitmap.width, bitmap.height);
    } catch (err) {
      console.error(err);
    } finally {
      bitmap.close();
    }
    self.postMessage({ type: "result", time, ...result });
  }
};
