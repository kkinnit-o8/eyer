// MediaPipe Face Landmarker and what we measure from it. No DOM here, so the
// same code runs on the main thread and in the tracking worker.

const MEDIAPIPE_VERSION = "0.10.35";
const BUNDLE_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/vision_bundle.mjs`;
const WASM_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/wasm`;
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";

// Face mesh landmark indices. "Right"/"left" are the person's own sides, so in
// the (unmirrored) camera image the right eye is on the left.
const IDX = {
  rOuter: 33, rInner: 133, rTop: 159, rBottom: 145, rIris: 468,
  lInner: 362, lOuter: 263, lTop: 386, lBottom: 374, lIris: 473,
  nose: 1, faceRight: 234, faceLeft: 454, forehead: 10, chin: 152,
};
const PREVIEW_POINTS = [IDX.rOuter, IDX.rInner, IDX.lInner, IDX.lOuter, IDX.rTop, IDX.rBottom, IDX.lTop, IDX.lBottom];

export const FEATURE_KEYS = [
  "eyeX", "eyeY", "eyeOpen", "lookH", "lookV", "yaw", "pitch", "headX", "headY", "blink",
];

/**
 * Loads the face landmarker, on the GPU if possible. In a module worker the
 * wasm loader has to be an ES module too, hence useModule.
 */
export async function loadLandmarker(useModule) {
  const { FaceLandmarker, FilesetResolver } = await import(BUNDLE_URL);
  const fileset = await FilesetResolver.forVisionTasks(WASM_URL, useModule);
  const options = (delegate) => ({
    baseOptions: { modelAssetPath: MODEL_URL, delegate },
    runningMode: "VIDEO",
    numFaces: 1,
    outputFaceBlendshapes: true,
  });
  try {
    return await FaceLandmarker.createFromOptions(fileset, options("GPU"));
  } catch (err) {
    console.warn("GPU face tracking unavailable, falling back to CPU.", err);
    return await FaceLandmarker.createFromOptions(fileset, options("CPU"));
  }
}

/**
 * Turns a landmarker result for a W×H frame into
 * { face, features?, preview?, size? }: gaze features, eye points for the
 * setup preview (in frame pixels), and face width as a fraction of the frame.
 */
export function analyze(result, W, H) {
  const lm = result.faceLandmarks?.[0];
  if (!lm || lm.length < 478) return { face: false };
  const P = (i) => ({ x: lm[i].x * W, y: lm[i].y * H });
  const irisRadius = (c) => Math.hypot((lm[c + 1].x - lm[c].x) * W, (lm[c + 1].y - lm[c].y) * H);
  const a = P(IDX.faceRight);
  const b = P(IDX.faceLeft);
  return {
    face: true,
    features: extractFeatures(P, result.faceBlendshapes?.[0]?.categories ?? [], W, H),
    preview: {
      points: PREVIEW_POINTS.map((i) => [lm[i].x * W, lm[i].y * H]),
      // The four points after each iris center lie on the iris edge.
      irises: [IDX.rIris, IDX.lIris].map((c) => [lm[c].x * W, lm[c].y * H, irisRadius(c)]),
    },
    size: Math.hypot(a.x - b.x, a.y - b.y) / W,
  };
}

function extractFeatures(P, blendshapes, W, H) {
  // Both eyes are measured along the image-left -> image-right corner axis so
  // their values point the same way and can be averaged.
  const right = eyeFeatures(P(IDX.rOuter), P(IDX.rInner), P(IDX.rTop), P(IDX.rBottom), P(IDX.rIris));
  const left = eyeFeatures(P(IDX.lInner), P(IDX.lOuter), P(IDX.lTop), P(IDX.lBottom), P(IDX.lIris));

  const nose = P(IDX.nose);
  const yaw = projection(nose, P(IDX.faceRight), P(IDX.faceLeft));
  const pitch = projection(nose, P(IDX.forehead), P(IDX.chin));

  const b = {};
  for (const c of blendshapes) b[c.categoryName] = c.score;
  const s = (name) => b[name] ?? 0;

  return {
    eyeX: (right.x + left.x) / 2,
    eyeY: (right.y + left.y) / 2,
    eyeOpen: (right.open + left.open) / 2,
    // Positive when looking toward the person's left.
    lookH: (s("eyeLookOutLeft") - s("eyeLookInLeft") + s("eyeLookInRight") - s("eyeLookOutRight")) / 2,
    lookV: (s("eyeLookUpLeft") + s("eyeLookUpRight") - s("eyeLookDownLeft") - s("eyeLookDownRight")) / 2,
    yaw,
    pitch,
    headX: nose.x / W,
    headY: nose.y / H,
    blink: (s("eyeBlinkLeft") + s("eyeBlinkRight")) / 2,
  };
}

// Iris position relative to the middle of the eye, in units of eye width.
function eyeFeatures(a, b, top, bottom, iris) {
  const ux = b.x - a.x;
  const uy = b.y - a.y;
  const len2 = ux * ux + uy * uy || 1;
  const dx = iris.x - (a.x + b.x) / 2;
  const dy = iris.y - (a.y + b.y) / 2;
  return {
    x: (dx * ux + dy * uy) / len2,
    y: (ux * dy - uy * dx) / len2,
    open: Math.hypot(top.x - bottom.x, top.y - bottom.y) / Math.sqrt(len2),
  };
}

// Where p sits along the segment a -> b, relative to its midpoint (-0.5..0.5).
function projection(p, a, b) {
  const ux = b.x - a.x;
  const uy = b.y - a.y;
  const len2 = ux * ux + uy * uy || 1;
  return ((p.x - (a.x + b.x) / 2) * ux + (p.y - (a.y + b.y) / 2) * uy) / len2;
}
