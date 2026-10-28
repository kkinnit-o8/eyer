# Eyer

Eye-tracking games that run in the browser using your webcam.

- **Ball**: a red ball floats in black space. Look at it and it jumps
  somewhere else. You have 15 seconds to catch as many as you can.
- **Peripheral rhythm**: play any osu! map on a single key (Space), or as
  4-key mania, with a twist. You can't look at the notes. Your eyes are busy
  popping hit circles that land in the corners of the screen on the beat, so
  you read the notes from the corner of your eye.

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

### Peripheral rhythm

1. Choose an osu! map: an `.osz` file (what you download from the osu!
   website), or a `.osu` file together with its song. Drag and drop works too.
   Nothing is uploaded anywhere; the map is read in your browser.
   Imported songs are saved in your browser (only the charts and the music),
   so they're listed under **Saved songs** next time, and the song you played
   last opens automatically. **Remove from saved songs** deletes one.
   **Any song works too**: choose a plain mp3 (or ogg/wav) with no osu! map
   and the game listens to it and makes an "Auto" chart (see below).
2. Pick a difficulty and settings:
   - **Game**: **One key** (the default) is played with <kbd>Space</kbd>.
     **4-key mania** plays the map as it is, with <kbd>D</kbd> <kbd>F</kbd>
     <kbd>J</kbd> <kbd>K</kbd>.
   - **Note density** (one key): the closest two notes may be: one beat, half
     a beat, or a quarter beat. See below for how the map is converted.
   - **Shape** (one key): a box with lines closing in, or a circle with rings
     closing in.
   - **Corner circles**: one per bar, every 2 beats, or every beat. They are
     placed on the map's own beat grid (its BPM and offset from the timing
     points), so they land on the beat. Circles never come closer than
     0.45 s apart, so very fast songs skip beats.
   - **Note fall time**: how long a note takes to fall. Longer is easier to
     read from the corner of your eye.
   - **Note offset**: if notes feel late compared to the music, lower it.
     **Tap to set** measures it for you: tap <kbd>Space</kbd> along with a
     metronome (after a 4-click count-in) and the typical gap between the
     clicks and your taps becomes the offset.
   - **Autoplay**: watch the map play itself, to check how the circles line
     up with the music.
   - **Mode: Practice** adds:
     - **Speed** from 0.5× to 1.5×. The music's pitch changes with it.
     - **Section**: play only part of the song. The music starts 3 seconds
       before it so you can hear your way in.
     - **Eye challenge**: untick it to practice just the notes, with no corner
       circles and no blackout, so you can look straight at them and learn
       the pattern.
     - **Repeat**: the section starts again as soon as it ends (<kbd>Esc</kbd>
       to stop).
3. **One key**: a target (box or circle) sits in the middle of the screen.
   Each note starts at the edge of the screen and closes in on it: four
   lines, one from each side, or a ring. Press <kbd>Space</kbd> when it
   touches the target. Notes get thicker and brighter as they close in, and
   the target fills up with the next note's color, brightest at the exact
   moment to press, so the timing is easy to catch from the corner of your
   eye. Colors show the beat a note lands on: white on the beat, blue on half
   beats, yellow on quarter beats, purple for anything else. The target
   pulses on every beat of the song. **4-key mania**: notes are circles that
   fall into the round receptors at the bottom.
4. Corner hit circles appear with an approach ring that closes on the beat.
   Look at one to pop it: a green burst means on the beat, yellow means late.
   Once a circle has landed, a timer ring around it runs down. If it runs out
   before you look, the circle disappears on its own and your streak (combo)
   resets. Your combo, accuracy and last judgment are shown in the corner
   where you last popped a circle, which is where your eyes already are.
5. Look at the middle for more than 0.3 s and the notes disappear until you
   look away. A quick sweep across on the way to another corner is fine.
6. Results show note accuracy (osu!mania style, using the map's OD) and how
   many corner circles you popped on the beat, late, or missed.

#### Making your own level

**Make a level** (next to Play) records a level for the loaded song in two
rounds, each with the song playing:

1. **Notes**: press <kbd>Space</kbd> wherever you want a note.
2. **Eye circles**: the song plays again with your notes ticking along;
   click (or press <kbd>Enter</kbd>) wherever you want an eye circle to land.
   Each one gets a corner, never the same corner twice in a row, and they're
   at least 0.45 s apart. This round ends by itself 2 seconds after your
   last note. You can also skip it and let the circles follow the beat.

<kbd>Esc</kbd> ends a round whenever you like, so you don't have to map the
whole song; the level is as long as what you recorded. <kbd>Backspace</kbd>
undoes the last one. With **Snap to the beat** on (when the song has a known
tempo), notes snap to the nearest quarter or third of a beat and eye circles
to the nearest half beat, using the song's beat grid. Recorded times take
your note offset into account, so the level plays back in time for you.

Give it a name and **Save level**: it's saved with the song as a new
difficulty, listed first and marked "your level". Your levels always play
on one key with every note exactly as you placed it, and use your own eye
circles. They're stored as normal `.osu` files with an extra
`[EyerCircles]` section for the circles (osu! ignores sections it doesn't
know).

#### How a map becomes one key

Every note in the difficulty is collapsed onto one key, as taps. Notes that
land together (chords) become one note. Where the map is denser than the
chosen density, notes are dropped, keeping the ones on the strongest beats
first (downbeat, then beat, half beat, quarter beat), then the biggest chords.
The beat grid comes from the map's timing points. Notes are never moved, so
they stay exactly where the mapper put them, in sync with the music.

In 4-key mania, maps with more than 4 keys are squeezed into 4 lanes, and
osu!standard maps are converted by where each circle sits horizontally.

#### Auto charts for any song

For a song without an osu! map, the game finds where sounds start (onsets)
by looking for sudden rises in energy across the spectrum, and which band
they're strongest in (bass, low mids, high mids, treble), which becomes the
lane in 4-key mania. For the tempo, every candidate BPM is scored by how well
all the onsets line up with a beat grid of that spacing across the whole
song, which finds a steady tempo very precisely; it's then kept between 90
and 230 BPM. The bar line goes where the bass is strongest. Onsets close to
the grid are snapped onto it. The result is saved as a real `.osu` file
("Auto" difficulty) with the song, so it loads instantly next time.

Checked against hand-made maps: Silhouette came out at 183.03 BPM (the map
says 183) with the grid within 4 ms of the mapper's notes, and Unravel at
134.96 BPM (map: 135) within 6 ms. It assumes a steady tempo, so songs that
speed up or slow down will drift.

In one-key mode the no-look zone is at least the middle 30% of the screen, so
the single lane can't be watched from right beside it.

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
- **Calibration that corrects itself.** Whenever you pop a corner circle in
  the rhythm game, your eyes are resting on a known spot. The features from
  the next half second become an extra calibration sample (worth half a
  calibration dot), and the model is refitted, so drift from shifting in
  your seat is corrected as you play. A sample is only taken if the tracker
  kept your gaze in that corner's quarter of the screen, so a glance
  elsewhere isn't learned, and only the 40 most recent are kept. The results
  screen shows how many times tracking was tuned.
- **Tracking runs in a background worker** (a Web Worker): camera frames are
  handed over as images and the face model runs there, so it never holds up
  the game's drawing. If the browser can't run it in a worker, it falls back
  to the main thread.

Webcam eye tracking is approximate. Expect the ring to be off by a few
centimetres. Even light, a steady head and recalibrating after you move all
help.

## Files

| File | What it does |
| --- | --- |
| `index.html`, `style.css` | Page and screens |
| `js/main.js` | Screen flow, main loop, rendering |
| `js/tracker.js` | Webcam, and handing frames to the tracking worker (or tracking on the main thread) |
| `js/tracker-worker.js` | The background worker that runs face tracking |
| `js/face.js` | Face model loading and feature extraction, shared by both |
| `js/calibration.js` | Calibration dot sequence and sample collection |
| `js/gaze.js` | Gaze regression model, smoothing, and learning during play |
| `js/game.js` | The ball game: ball, hits, timer |
| `js/ui.js` | Small DOM and storage helpers |
| `js/mania/osu.js` | Reading `.osz` archives and `.osu` files |
| `js/mania/library.js` | Saved songs (IndexedDB) |
| `js/mania/autochart.js`, `js/mania/autochart-worker.js` | Charts for plain songs: onsets, tempo, `.osu` output (analysis runs in a worker) |
| `js/mania/clock.js` | Audio clock and metronome click |
| `js/mania/offset.js` | The tap-along note offset test |
| `js/mania/editor.js` | Level editor recording rounds and saving levels as `.osu` |
| `js/mania/chart.js` | 4-lane and one-key charts, beat grid, corner circles on the beat |
| `js/mania/game.js` | Peripheral rhythm gameplay: timing, judgments, gaze rules, drawing |
| `js/mania/index.js` | Peripheral rhythm screens: map loading, settings, results |

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
