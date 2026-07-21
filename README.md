# Melomemo

Record a tune you're humming or whistling before you lose it. A local-first
PWA — recordings never leave the device.

**Current:** record, save, browse, play back, export/import, automatic pitch
transcription into equal temperament, and note editing on the piano roll —
move, add, and delete notes, with the raw recording untouched underneath.
**Next:** MIDI file export, rhythm quantisation.

## Setup

Requires **Node 22+** (Vite 8 needs `^20.19 || >=22.12`). There's an `.nvmrc`,
so:

```
nvm use
npm install
npm run dev
```

> On Windows, `nvm use` needs an **elevated** terminal — it rewrites the
> `C:\Program Files\nodejs` symlink. If it fails with
> `exit status 5: Access is denied`, reopen PowerShell as Administrator.

| Command | Does |
| --- | --- |
| `npm run dev` | Dev server on http://localhost:5173 |
| `npm test` | Vitest suite |
| `npm run build` | Typecheck + production build (emits the service worker) |
| `npm run preview` | Serve the production build — needed to exercise the PWA |

Microphone access requires a secure context. `localhost` counts, so dev works
as-is. Testing on a phone does **not** — see "Testing on a phone" below.

## How it's put together

```
src/
  core/       Types, ids, hashing, Result/AppError, pitch maths. Pure, no DOM.
  capture/    getUserMedia + MediaRecorder, format negotiation, interruptions.
  storage/    IndexedDB (the only place that imports `idb`), export/import.
  playback/   One shared <audio> element and one object URL.
  analysis/   Decode, pitch tracking, note segmentation, the worker.
  ui/         React components and hooks.
```

`capture/` and `storage/` don't know about each other or about React. Recording
produces a value; the UI decides to save it.

### The idea the data model hangs on

Each memo has three layers, and they are deliberately not the same object:

```
AudioAsset      immutable captured bytes — the source of truth
     ↓ (v2) derived, versioned, safe to recompute at any time
AnalysisRecord  machine pitch analysis — never edited by the user
     ↓ (v3) seeded once, then independent
ScoreDocument   the user's MIDI — never auto-overwritten by re-analysis
```

Pitch algorithms will improve after memos already exist, so analysis results
carry an algorithm version and the hash of the audio they came from — stale
ones can be found and recomputed. But once a user edits their MIDI,
re-analysis must not touch it. `ScoreDocument.userEdited` enforces that;
re-seeding is an explicit, confirmed action.

All five object stores (`memos`, `audio`, `analyses`, `scores`, `scratch`)
exist at DB version 1 even though two stay empty until v2/v3, so adding those
features needs no schema migration.

### How transcription works

Runs automatically after a recording is saved, but never blocks it: the memo is
listed immediately and the transcription appears when it's ready.

```
stored audio
  -> decode to mono 22.05 kHz          main thread — AudioContext doesn't exist in workers
  -> McLeod Pitch Method per frame     46 ms window, 11.6 ms hop, in a worker
  -> median smoothing                  kills isolated octave errors
  -> hysteresis segmentation           so vibrato doesn't shred a held note
  -> global tuning correction          so singing flat still reads as the right tune
  -> notes + dense pitch contour
```

Parameters worth turning when a real recording transcribes badly all live in
[`src/analysis/constants.ts`](src/analysis/constants.ts), each with the reason
for its value. **Bump `mpmEngine.version` after changing any of them** — that's
what marks existing transcriptions stale so they can be recomputed.

Tap a memo to open it. **Play** synthesises the transcription as tones,
separately from the original recording — hearing the two back to back is the
quickest way to judge whether a transcription is right. Playback pauses and
resumes; **stop** rewinds to the start. Only one of the two audio sources plays
at a time.

The playhead tracks through the roll and auto-scrolls to follow, stays visible
when paused so the resume point is obvious, and can be dragged to play from
anywhere. Dragging it pauses first and seeks once on release rather than
rebuilding the audio graph on every frame. Dragging toward either edge scrolls
the chart, carrying the playhead on to the end (or back to the start) — the
playhead is drawn under the finger, so scrolling is the only way to reach a
time outside the visible window. Arrow keys, `Home`, and `End` seek it from the
keyboard.

The piano roll's coordinate maths lives in
[`src/ui/pianoRollGeometry.ts`](src/ui/pianoRollGeometry.ts) with both forward
(time→x, pitch→y) and inverse mappings, so rendering, hit-testing, and dragging
all resolve through the same arithmetic.

Only one memo is open at a time, and an open roll is capped to a fraction of
the window so the whole memo still fits a screen — the chart scrolls inside
that rather than growing the page. Once it is scrolled to its own top or
bottom, further scrolling carries on down the page.

The roll opens framed around the transcribed notes, widened to fill the
visible height. Dragging a note to the top or bottom row widens it further, a
few semitones at a time, up to a hard **A1–C8** ceiling; notes outside that
range are ignored rather than stretching the chart to reach them. Zoom (`−`
/ `+`) trades range for detail, keeping the pitch labels pinned beside the
chart at every level.

### Editing notes

Notes on the roll can be moved, added, and deleted. Every gesture has a
keyboard equivalent, because a drag-only editor is unusable without a pointer:

| Action | Pointer | Keyboard |
| --- | --- | --- |
| Move pitch | Drag up/down | Focus note, `↑` / `↓` |
| Move in time | Drag left/right | `←` / `→` (hold `Shift` for 10 ms steps) |
| Change length | Select, then drag the note's end | `[` / `]` (`Shift` for finer) |
| Add | Double-click empty space | — |
| Delete | Select, then **Delete note** | `Delete` or `Backspace` |
| Deselect | — | `Escape` |

Clicking a note sounds it, and moving one vertically sounds each pitch it
passes through, so an edit can be heard as well as seen. Auditioning is
independent of the transport: it starts no playback and moves no playhead.

Only the note's **end** resizes — dragging the start would shift the note in
time, which is what moving is for. The resize grip appears on the selected note
only; showing one on every note would blanket short notes in targets and make
ordinary dragging unreliable. Brackets rather than `Alt`+arrows, which are
browser back/forward.

**The first edit forks the melody away from the machine.** Until then the
transcription is what you see. From that moment a `ScoreDocument` exists and
owns the display, playback, and note list — and **re-running analysis never
touches it**. That is the guarantee the three-layer model exists for: an
improved pitch algorithm may replace an `AnalysisRecord` freely, but it can
never silently overwrite notes you placed by hand. **Reset to transcription**
is the only way back, and it asks first.

Edits persist per gesture rather than on a save button, so a closed tab loses
nothing. The audio itself is never modified by any of this.

Every memo's **Notes → Show details** panel gives the engine version, what
fraction of frames were pitched, median confidence, the detected tuning offset,
and per-note cents and confidence. The piano roll draws the raw pitch contour
behind the notes, which is how you tell a wandering voice from a segmentation
mistake.

### Decisions worth knowing before changing things

- **Microphone DSP is requested off** (`echoCancellation`, `noiseSuppression`,
  `autoGainControl`). These are tuned for speech intelligibility and destroy
  the harmonic and envelope information pitch detection needs — noise
  suppression in particular treats whistling as noise. The browser doesn't
  always honour the request, so whatever `getSettings()` reports is persisted
  onto the memo; later analysis can then tell clean audio from mangled.
- **Duration is measured with a wall clock, never read back from `<audio>`.**
  MediaRecorder writes no duration into the container, so the element reports
  `Infinity`.
- **Metadata and audio are separate stores.** Listing memos must never
  deserialize the audio.
- **Audio is stored as `ArrayBuffer`, not `Blob`.** Blobs can't be written to
  IndexedDB at all in iOS Private Browsing, and `ArrayBuffer` is transferable
  for the future analysis worker.
- **The mic stream is acquired per-recording and released on stop.** iOS
  invalidates capture tracks on backgrounding while leaving them looking
  healthy — a long-lived stream is the usual cause of a recording that turns
  out to be silent.
- **Service worker updates prompt rather than auto-apply,** and the prompt is
  suppressed while recording.

## Deployment

Pushing to `master` builds and publishes to GitHub Pages via
[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml). Tests run first
and a failure blocks the deploy.

Live at **https://sam0127.github.io/Melomemo/**

A project site is served from `/<repo>/`, not the domain root, so `vite.config.ts`
sets `base` and derives the manifest's `start_url` and `scope` from it. Getting
that wrong means an installed app launches to a 404 and the service worker
never controls the page. Override with `BASE_PATH` to build for a custom domain:

```
BASE_PATH=/ npm run build
```

Because the deployed site is HTTPS, the microphone and PWA install both work
there — which makes it the easiest way to try this on a phone.

## Testing on a phone

`getUserMedia` needs HTTPS off localhost. Either:

- `npx vite --host` behind a tunnel (`cloudflared tunnel --url http://localhost:5173`), or
- add `@vitejs/plugin-basic-ssl` (already a dev dependency) to `vite.config.ts`
  and accept the self-signed certificate.

Test on a **real iPhone**, not the simulator — the audio-session bugs this code
guards against don't reproduce there. Worth exercising specifically:

1. Background the app mid-recording → the partial take is saved, not lost.
2. Background, return, record again → the second recording contains audio.
3. Check `capture.dsp` on a saved memo to see what iOS actually honoured.

## Known limitations

- **Exported WebM files carry no duration.** The audio is complete, but some
  external players show the length as unknown. Rewriting the container metadata
  on export is deferred.
- **On iOS, Safari and the installed home-screen app have separate storage.**
  Memos recorded in the browser are not visible in the installed app. The app
  explains this and points at Back up / Restore, which is the way across.
- **Browser storage is evictable.** The app requests persistent storage after
  your first recording, but it's granted at the browser's discretion. Back up
  anything you care about.
- **Transcription accuracy is unproven on real voices.** The pipeline is tested
  against synthetic signals with known answers — steady tones across the sung
  and whistled range, vibrato, glides, harmonics, noise, and deliberately flat
  singing. No real singing has been through it. Expect to turn the constants.
- **Note timings are in milliseconds, not rhythm.** Nothing is snapped to a
  beat; that needs tempo estimation, which is deferred.
- **Transcription assumes one note at a time**, which is what humming and
  whistling are. Chords are out of scope.
- **Backups include your edits but not transcriptions.** Hand-edited notes
  can't be recreated, so they travel with the archive. Analyses are left out
  deliberately — they're recomputable from the audio, and their dense per-frame
  pitch data would multiply every backup's size. An imported memo therefore
  shows a Transcribe button.
