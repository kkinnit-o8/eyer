# Eyer

Eye-tracking games that run in the browser using your webcam.

- **Ball**: a red ball floats in black space. Look at it and it jumps
  somewhere else. You have 15 seconds to catch as many as you can.
- **Peripheral mania**: 4-key osu!mania with a twist. You can't look at the
  notes. Your eyes have to stay on circles that land in the corners of the
  screen on the beat, so you read the notes from the corner of your eye.

## How to play

1. Click **Enable camera** and allow camera access. The first time, a short
   tutorial on getting good tracking plays while the tracker loads. You can
   open it again any time with **Tracking tips**.
2. Get your face in the preview. Light it from the front and sit 40–60 cm away.
3. **Calibrate**: a dot moves to 13 spots on the screen. Keep your head still
   and follow it with your eyes until each dot shrinks away (about 20 seconds).
   The page goes fullscreen for this.
4. **Tracking check**: look around. The white ring should follow your eyes, and
   the grey targets light up red when you look at them. If tracking is off,
   recalibrate.
5. **Pick a game** from the tracking check screen.

### Ball

After a 3-second countdown, look at the ball. It vanishes the instant the
tracker sees you looking at it and reappears somewhere else.

### Peripheral mania

1. Choose an osu! map: an `.osz` file (what you download from the osu!
   website), or a `.osu` file together with its song. Drag and drop works too.
   Nothing is uploaded anywhere; the map is read in your browser.
2. Pick a difficulty and settings:
   - **Corner circles**: one per bar, every 2 beats, or every beat. They are
     placed on the map's own beat grid (its BPM and offset from the timing
     points), so they land on the beat. Circles never come closer than
     0.45 s apart, so very fast songs skip beats.
   - **Note fall time**: how long a note takes to fall. Longer is easier to
     read from the corner of your eye.
   - **Note offset**: if notes feel late compared to the music, lower it.
   - **Autoplay**: watch the map play itself, to check how the circles line
     up with the music.
3. Play with <kbd>D</kbd> <kbd>F</kbd> <kbd>J</kbd> <kbd>K</kbd>. When a
   circle lands in a corner, move your eyes there. It turns green if you got
   there on the beat and yellow if late. Your combo, accuracy and last
   judgment are shown in the circle you're looking at.
4. Look at the middle for more than 0.3 s and the notes disappear until you
   look away. A quick sweep across on the way to another corner is fine.
5. Results show note accuracy (osu!mania style, using the map's OD) and how
   well your eyes kept up.

Mania maps with more than 4 keys are squeezed into 4 lanes, and osu!standard
maps are converted by where each circle sits horizontally.

Press <kbd>G</kbd> during the game to show where the tracker thinks you're
looking. Press <kbd>Space</kbd> on the results screen to play again.

## Getting the best tracking

The in-game tutorial covers this with pictures. In short:

- **Move your eyes, not your head**, both while calibrating and while playing.
  The tracker learns how your irises move. If you turn your head toward each
  calibration dot, it learns those head turns instead.
- **Light your face from the front**, camera at eye level, about an arm's
  length away. No glare on glasses or hair over your eyes.
- **Look at the white center of each calibration dot** until it shrinks away,
  with a relaxed face. Blinking is fine.
- **Stay in the same spot** after calibrating, and recalibrate if you move, the
  light changes, or the game leaves fullscreen.
- Up and down is always less precise than left and right with a webcam.

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
| `js/game.js` | The ball game: ball, hits, timer |
| `js/ui.js` | Small DOM and storage helpers |
| `js/mania/osu.js` | Reading `.osz` archives and `.osu` files |
| `js/mania/chart.js` | 4-lane chart, beat grid, corner circles on the beat |
| `js/mania/game.js` | Peripheral mania gameplay: timing, judgments, gaze rules, drawing |
| `js/mania/index.js` | Peripheral mania screens: map loading, settings, results |

Gameplay constants are at the top of each game file, for example round length
and ball size in `js/game.js`, and the gaze timing windows in
`js/mania/game.js`.

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
