import type { QuantizedNote } from '../core/types.ts';
import {
  MAX_GAP_MS,
  MIN_NOTE_MS,
  SPLIT_CONFIRM_FRAMES,
  SPLIT_SEMITONES,
  frameCentreMs,
  framesToMs,
} from './constants.ts';
import type { PitchTrack } from './pitchTrack.ts';

/**
 * Turns a continuous pitch contour into discrete notes.
 *
 * The hard part is deciding what counts as one note. Singing is not piecewise
 * constant: it scoops into pitches, wobbles with vibrato, and drifts. Rounding
 * each frame to a semitone and grouping equal values fragments a held note the
 * moment vibrato crosses a boundary, so this tracks a note's centre and only
 * splits when the pitch leaves it convincingly and stays away.
 */

interface OpenNote {
  startFrame: number;
  endFrame: number;
  midis: number[];
  clarities: number[];
  sum: number;
}

function median(values: number[]): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export interface SegmentationResult {
  notes: QuantizedNote[];
  /** Overall flat/sharp bias of the performance, in cents. */
  estimatedOffsetCents: number;
}

export function segmentNotes(track: PitchTrack): SegmentationResult {
  const maxGapFrames = Math.max(1, Math.round(MAX_GAP_MS / framesToMs(1)));

  const raw: OpenNote[] = [];
  let current: OpenNote | null = null;
  let gapFrames = 0;
  /** Frames that have left the current note's centre but not yet confirmed a split. */
  let pending: Array<{ frame: number; midi: number; clarity: number }> = [];

  const open = (frame: number, midi: number, clarity: number): OpenNote => ({
    startFrame: frame,
    endFrame: frame,
    midis: [midi],
    clarities: [clarity],
    sum: midi,
  });

  const extend = (note: OpenNote, frame: number, midi: number, clarity: number) => {
    note.endFrame = frame;
    note.midis.push(midi);
    note.clarities.push(clarity);
    note.sum += midi;
  };

  for (let i = 0; i < track.frameCount; i++) {
    const midi = track.midi[i]!;
    const clarity = track.clarity[i]!;

    if (Number.isNaN(midi)) {
      if (current) {
        gapFrames++;
        // A brief unvoiced patch is a consonant or a breath, not a note
        // boundary; only a sustained one ends the note.
        if (gapFrames > maxGapFrames) {
          raw.push(current);
          current = null;
          pending = [];
        }
      }
      continue;
    }

    gapFrames = 0;

    if (!current) {
      current = open(i, midi, clarity);
      continue;
    }

    const centre = current.sum / current.midis.length;

    if (Math.abs(midi - centre) > SPLIT_SEMITONES) {
      pending.push({ frame: i, midi, clarity });
      if (pending.length >= SPLIT_CONFIRM_FRAMES) {
        // The departure held, so it was a real move. The note ends before the
        // first departing frame, and those frames seed the next note.
        raw.push(current);
        const [first, ...rest] = pending;
        current = open(first!.frame, first!.midi, first!.clarity);
        for (const p of rest) extend(current, p.frame, p.midi, p.clarity);
        pending = [];
      }
      continue;
    }

    // Came back within tolerance, so the excursion was a scoop or an overshoot
    // rather than a new note. Those frames belong to this note after all.
    for (const p of pending) extend(current, p.frame, p.midi, p.clarity);
    pending = [];
    extend(current, i, midi, clarity);
  }

  if (current) {
    for (const p of pending) extend(current, p.frame, p.midi, p.clarity);
    raw.push(current);
  }

  // Fractional pitch first, so a consistent tuning bias can be measured before
  // anything is rounded to a semitone.
  const measured = raw
    .map((note) => {
      const startMs = frameCentreMs(note.startFrame);
      // The final frame represents its own hop of time, so the note runs to
      // the start of the frame after it.
      const endMs = frameCentreMs(note.endFrame + 1);
      return {
        fractionalMidi: median(note.midis),
        confidence: mean(note.clarities),
        startMs,
        durationMs: endMs - startMs,
      };
    })
    .filter((note) => note.durationMs >= MIN_NOTE_MS && !Number.isNaN(note.fractionalMidi));

  const estimatedOffsetCents = estimateTuningOffset(
    measured.map((n) => n.fractionalMidi),
  );
  const offsetSemitones = estimatedOffsetCents / 100;

  const notes: QuantizedNote[] = measured.map((note) => {
    // Correcting for the singer's overall bias before rounding: someone
    // consistently 45 cents flat is singing the right tune, and rounding their
    // raw pitch would put every note a semitone low.
    const corrected = note.fractionalMidi - offsetSemitones;
    const midi = Math.round(corrected);
    return {
      midi,
      startMs: note.startMs,
      durationMs: note.durationMs,
      centsDeviation: (corrected - midi) * 100,
      confidence: note.confidence,
    };
  });

  return { notes, estimatedOffsetCents };
}

/**
 * Estimates how flat or sharp the whole performance sits, in cents.
 *
 * Unaccompanied singing is rarely at concert pitch, and the bias is usually
 * consistent across a phrase. Measuring it lets the transcription recover the
 * intended intervals instead of scattering notes across semitone boundaries.
 *
 * Needs a few notes to be meaningful — with one or two, the "bias" is
 * indistinguishable from those notes simply being out of tune.
 */
export function estimateTuningOffset(fractionalMidis: number[]): number {
  if (fractionalMidis.length < 3) return 0;
  const deviations = fractionalMidis.map((m) => {
    const frac = m - Math.round(m);
    return frac * 100;
  });
  return median(deviations);
}
