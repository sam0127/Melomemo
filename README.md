# Melomemo

Record a tune you're humming or whistling before you lose it. A local-first
PWA — recordings never leave the device.

**Current:** record, save, browse, play back, export/import, and automatic
pitch transcription into equal temperament.
**Next:** save the transcription as an editable MIDI track alongside the raw
audio, then let it be edited.

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
- **Backups don't include transcriptions.** They're derived data and are
  recomputed on demand, so an imported memo shows a Transcribe button.
