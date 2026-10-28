// Runs song analysis off the main thread so the page stays responsive.

import { analyzeAudio } from "./autochart.js";

self.onmessage = ({ data }) => {
  self.postMessage(analyzeAudio(data));
};
