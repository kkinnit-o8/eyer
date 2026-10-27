# Eyer

An eye-tracking game that runs in the browser using your webcam.

A red ball floats in black space. Look at it and it jumps somewhere else. You
have 15 seconds to catch as many as you can.

## How to play

1. Click **Enable camera** and allow camera access.
2. Get your face in the preview. Light it from the front and sit 40–60 cm away.
3. **Calibrate**: a dot moves to 13 spots on the screen. Keep your eyes on it
   until it shrinks away (about 20 seconds). The page goes fullscreen for this.
4. **Tracking check**: look around. The white ring should follow your eyes, and
   the grey targets light up red when you look at them. If tracking is off,
   recalibrate.
5. **Play**: after a 3-second countdown, look at the ball. Keep your eyes on it
   for a moment (the white ring fills) and it moves.

Press <kbd>G</kbd> during the game to show where the tracker thinks you're
looking. Press <kbd>Space</kbd> on the results screen to play again.

## How it works

- [MediaPipe Face Landmarker](https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker)
  finds 478 face landmarks per camera frame, including both irises. All
  processing happens in your browser; video is never uploaded.
- For each frame the game measures where each iris sits between its eye
  corners, how open the eyes are, the head's position and rotation, and
  MediaPipe's eye-direction blendshapes.
- Calibration pairs those measurements with the known dot positions and fits a
  small ridge regression for each screen axis. The leave-one-out error is shown
  on the check screen, and the ball's hit area grows when tracking is less
  precise, so the game stays playable on worse cameras.
- A [One Euro filter](https://gery.casiez.net/1euro/) smooths the gaze point:
  steady while your eyes rest, quick when they jump.

Webcam eye tracking is approximate. Expect the ring to be off by a few
centimetres. Even light, a steady head and recalibrating after you move all
help.

## Files

| File | What it does |
| --- | --- |
| `index.html`, `style.css` | Page and screens |
| `js/main.js` | Screen flow, main loop, rendering |
| `js/tracker.js` | Webcam, face tracking, feature extraction |
| `js/calibration.js` | Calibration dot sequence and sample collection |
| `js/gaze.js` | Gaze regression model and smoothing |
| `js/game.js` | The game: ball, hits, timer |

Gameplay constants such as round length, ball size and dwell time are at the
top of `js/game.js`.

## Running locally

The camera only works on `https://` or `localhost`, so serve the folder rather
than opening the file directly:

```sh
python3 -m http.server 8000
```

Then open <http://localhost:8000>. Add `?mouse` to the URL
(<http://localhost:8000/?mouse>) to play with the mouse instead of your eyes,
which is handy when testing.

## Hosting on GitHub Pages

The site is plain static files with no build step.

1. Push to GitHub.
2. In the repository, open **Settings → Pages**.
3. Under **Build and deployment**, choose **Deploy from a branch**, pick your
   branch (for example `main`) and the `/ (root)` folder, then **Save**.
4. After a minute the game is live at `https://<user>.github.io/<repo>/`.

GitHub Pages serves over HTTPS, so camera access works there.
