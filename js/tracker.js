// Webcam + face tracking. Tracking runs in a worker when the browser allows
// it, so the model never stalls the games' drawing; otherwise it runs here.

import { loadLandmarker, analyze } from "./face.js";

export class CameraError extends Error {
  constructor(message, cause) {
    super(message);
    this.cause = cause;
  }
}

export class Tracker {
  constructor(video) {
    this.video = video;
    this.worker = null;
    this.landmarker = null; // only when tracking on the main thread
    this.lastVideoTime = -1;
    this.busy = false; // a frame is in the worker
    this.latest = null; // newest worker result not yet handed out
  }

  /** Where tracking runs: "worker" or "main". */
  get mode() {
    return this.worker ? "worker" : "main";
  }

  async start() {
    try {
      await Promise.all([this.#openCamera(), this.#startTracking()]);
    } catch (err) {
      this.video.srcObject?.getTracks().forEach((t) => t.stop());
      this.video.srcObject = null;
      this.worker?.terminate();
      this.worker = null;
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

  async #startTracking() {
    try {
      await this.#startWorker();
      return;
    } catch (err) {
      console.warn("Face tracking worker unavailable; tracking on the main thread.", err);
      this.worker?.terminate();
      this.worker = null;
    }
    try {
      this.landmarker = await loadLandmarker(false);
    } catch (err) {
      throw new CameraError("Couldn't load the face tracker. Check your connection and reload.", err);
    }
  }

  #startWorker() {
    return new Promise((resolve, reject) => {
      const worker = new Worker(new URL("./tracker-worker.js", import.meta.url), { type: "module" });
      this.worker = worker;
      worker.onmessage = ({ data }) => {
        if (data.type === "result") {
          this.latest = data;
          this.busy = false;
        } else if (data.type === "ready") {
          resolve();
        } else if (data.type === "error") {
          reject(new Error(data.message));
        }
      };
      worker.onerror = (e) => {
        this.busy = false;
        reject(e.error ?? new Error(e.message || "Tracking worker failed"));
      };
      worker.postMessage({ type: "init" });
    });
  }

  /**
   * Call every animation frame. Returns the newest tracking result once, or
   * null if there is nothing new: { time, face, features?, preview?, size? },
   * where time is when the frame was captured.
   */
  detect(now) {
    const v = this.video;
    const fresh = v.readyState >= 2 && v.currentTime !== this.lastVideoTime;

    if (this.worker) {
      const result = this.latest;
      this.latest = null;
      // One frame in flight at a time, so frames never queue up behind a slow model.
      if (fresh && !this.busy) {
        this.lastVideoTime = v.currentTime;
        this.busy = true;
        createImageBitmap(v).then(
          (bitmap) => this.worker.postMessage({ type: "frame", bitmap, time: now }, [bitmap]),
          () => {
            this.busy = false;
          },
        );
      }
      return result;
    }

    if (!this.landmarker || !fresh) return null;
    this.lastVideoTime = v.currentTime;
    return { time: now, ...analyze(this.landmarker.detectForVideo(v, now), v.videoWidth, v.videoHeight) };
  }

  /** Draws eye corners and irises over the preview, for the setup screen. */
  drawPreview(canvas, preview) {
    const v = this.video;
    if (canvas.width !== v.videoWidth || canvas.height !== v.videoHeight) {
      canvas.width = v.videoWidth;
      canvas.height = v.videoHeight;
    }
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!preview) return;

    const s = Math.max(3, canvas.width / 200);
    ctx.fillStyle = "rgba(74, 222, 128, 0.9)";
    for (const [x, y] of preview.points) {
      ctx.beginPath();
      ctx.arc(x, y, s, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.strokeStyle = "rgba(255, 42, 31, 0.95)";
    ctx.lineWidth = s;
    for (const [x, y, r] of preview.irises) {
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
}
