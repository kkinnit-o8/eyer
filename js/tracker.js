// Webcam + MediaPipe Face Landmarker. Turns each camera frame into a small
// set of gaze-related features (iris position inside the eye, head pose).

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

export const FEATURE_KEYS = [
  "eyeX", "eyeY", "eyeOpen", "lookH", "lookV", "yaw", "pitch", "headX", "headY", "blink",
];

export class CameraError extends Error {
  constructor(message, cause) {
    super(message);
    this.cause = cause;
  }
}

export class Tracker {
  constructor(video) {
    this.video = video;
    this.landmarker = null;
    this.lastVideoTime = -1;
  }

  async start() {
    try {
      const [, landmarker] = await Promise.all([this.#openCamera(), loadLandmarker()]);
      this.landmarker = landmarker;
    } catch (err) {
      this.video.srcObject?.getTracks().forEach((t) => t.stop());
      this.video.srcObject = null;
      throw err;
    }
  }

  async #openCamera() {
    if (!window.isSecureContext) {
      throw new CameraError("The camera only works over https or on localhost.");
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new CameraError("This browser can't access a camera.");
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: "user",
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 30 },
        },
      });
    } catch (err) {
      const messages = {
        NotAllowedError: "Camera access was blocked. Allow it in your browser's address bar, then reload.",
        NotFoundError: "No camera was found.",
        NotReadableError: "The camera is busy in another app. Close that app and try again.",
      };
      throw new CameraError(messages[err.name] ?? `Couldn't start the camera (${err.name}).`, err);
    }
    this.video.srcObject = stream;
    await this.video.play();
  }

  /**
   * Runs face tracking on the newest camera frame. Returns null when there is
   * no new frame since the last call, otherwise
   * { face: boolean, landmarks?, features? }.
   */
  detect(now) {
    const v = this.video;
    if (!this.landmarker || v.readyState < 2 || v.currentTime === this.lastVideoTime) return null;
    this.lastVideoTime = v.currentTime;

    const result = this.landmarker.detectForVideo(v, now);
    const landmarks = result.faceLandmarks?.[0];
    if (!landmarks || landmarks.length < 478) return { face: false };

    const blendshapes = result.faceBlendshapes?.[0]?.categories ?? [];
    return {
      face: true,
      landmarks,
      features: extractFeatures(landmarks, blendshapes, v.videoWidth, v.videoHeight),
    };
  }

  /** Draws eye corners and irises over the preview, for the setup screen. */
  drawPreview(canvas, landmarks) {
    const v = this.video;
    if (canvas.width !== v.videoWidth || canvas.height !== v.videoHeight) {
      canvas.width = v.videoWidth;
      canvas.height = v.videoHeight;
    }
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!landmarks) return;

    const W = canvas.width;
    const H = canvas.height;
    const s = Math.max(3, W / 200);
    ctx.fillStyle = "rgba(74, 222, 128, 0.9)";
    for (const i of [IDX.rOuter, IDX.rInner, IDX.lInner, IDX.lOuter, IDX.rTop, IDX.rBottom, IDX.lTop, IDX.lBottom]) {
      ctx.beginPath();
      ctx.arc(landmarks[i].x * W, landmarks[i].y * H, s, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.strokeStyle = "rgba(255, 42, 31, 0.95)";
    ctx.lineWidth = s;
    for (const center of [IDX.rIris, IDX.lIris]) {
      // The four points after each iris center lie on the iris edge.
      const c = landmarks[center];
      const edge = landmarks[center + 1];
      const r = Math.hypot((edge.x - c.x) * W, (edge.y - c.y) * H);
      ctx.beginPath();
      ctx.arc(c.x * W, c.y * H, r, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  /** Face width as a fraction of the frame width; a rough distance cue. */
  faceSize(landmarks) {
    const W = this.video.videoWidth;
    const H = this.video.videoHeight;
    const a = landmarks[IDX.faceRight];
    const b = landmarks[IDX.faceLeft];
    return Math.hypot((a.x - b.x) * W, (a.y - b.y) * H) / W;
  }
}

async function loadLandmarker() {
  try {
    const { FaceLandmarker, FilesetResolver } = await import(BUNDLE_URL);
    const fileset = await FilesetResolver.forVisionTasks(WASM_URL);
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
  } catch (err) {
    throw new CameraError("Couldn't load the face tracker. Check your connection and reload.", err);
  }
}

function extractFeatures(lm, blendshapes, W, H) {
  const P = (i) => ({ x: lm[i].x * W, y: lm[i].y * H });

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
