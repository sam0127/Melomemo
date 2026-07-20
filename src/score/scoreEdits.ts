import { uuidv7 } from '../core/ids.ts';
import type {
  AnalysisRecord,
  MemoId,
  ScoreDocument,
  ScoreNote,
} from '../core/types.ts';

/**
 * Every way a score can change, as pure functions.
 *
 * Kept out of React and out of the drag handlers so the rules — clamping,
 * ordering, the userEdited flag — hold no matter which gesture invoked them.
 * A keyboard nudge and a pointer drag go through the same door, which is what
 * keeps their results identical.
 *
 * Each operation returns a new document with `updatedAt` bumped and
 * `userEdited` true; callers persist the result. Notes stay sorted by
 * startMs throughout, so consumers can rely on playback order without
 * re-sorting.
 */

/** MIDI note range is 0..127 by definition. */
const MIN_MIDI = 0;
const MAX_MIDI = 127;

/** Fallback length for a created note when the score is empty. */
const DEFAULT_NOTE_MS = 300;

/**
 * Shortest a note can be dragged. Below this a note is invisible on the roll
 * and inaudible in playback, so it would look like the resize deleted it.
 */
export const MIN_NOTE_DURATION_MS = 40;

const clampMidi = (midi: number): number =>
  Math.min(MAX_MIDI, Math.max(MIN_MIDI, Math.round(midi)));

const byStart = (a: ScoreNote, b: ScoreNote): number => a.startMs - b.startMs;

function withEdit(
  score: ScoreDocument,
  notes: ScoreNote[],
): ScoreDocument {
  return {
    ...score,
    notes: [...notes].sort(byStart),
    userEdited: true,
    updatedAt: Date.now(),
  };
}

/**
 * Builds the initial score from a transcription.
 *
 * This is the one moment machine output flows into the user's layer. The
 * cents deviation and confidence come along — they are facts about the
 * performance — but from here on the analysis and the score live separate
 * lives, and re-running analysis never touches this document again.
 */
export function seedScoreFromAnalysis(
  memoId: MemoId,
  analysis: AnalysisRecord,
): ScoreDocument {
  const now = Date.now();
  return {
    id: uuidv7(),
    memoId,
    createdAt: now,
    updatedAt: now,
    seededFromAnalysisId: analysis.id,
    // Seeding happens lazily, on the user's first edit — so the document is
    // user-touched from the moment it exists.
    userEdited: true,
    ppq: 480,
    tempoBpm: 120,
    notes: analysis.notes
      .map((note) => ({ ...note, id: uuidv7() }))
      .sort(byStart),
  };
}

/** Moves a note to a new pitch and/or start time. Unknown ids are a no-op. */
export function moveNote(
  score: ScoreDocument,
  noteId: string,
  midi: number,
  startMs: number,
): ScoreDocument {
  const index = score.notes.findIndex((note) => note.id === noteId);
  if (index === -1) return score;

  const existing = score.notes[index]!;
  const moved: ScoreNote = {
    ...existing,
    midi: clampMidi(midi),
    startMs: Math.max(0, Math.round(startMs)),
    // A note the user has placed by hand is exactly where they put it; the
    // measured deviation belonged to the performance, not to this position.
    centsDeviation: existing.midi === clampMidi(midi) ? existing.centsDeviation : 0,
  };

  const notes = [...score.notes];
  notes[index] = moved;
  return withEdit(score, notes);
}

/**
 * Creates a note at the given pitch and time.
 *
 * Duration defaults to the median of the notes already present — a new note
 * should look like it belongs to this melody, not like a constant — falling
 * back to a fixed length in an empty score.
 */
export function addNote(
  score: ScoreDocument,
  midi: number,
  startMs: number,
): { score: ScoreDocument; created: ScoreNote } {
  const durations = score.notes.map((note) => note.durationMs).sort((a, b) => a - b);
  const median =
    durations.length === 0
      ? DEFAULT_NOTE_MS
      : durations[durations.length >> 1]!;

  const created: ScoreNote = {
    id: uuidv7(),
    midi: clampMidi(midi),
    startMs: Math.max(0, Math.round(startMs)),
    durationMs: median,
    // Hand-placed: exactly on pitch, and as certain as it gets.
    centsDeviation: 0,
    confidence: 1,
  };

  return { score: withEdit(score, [...score.notes, created]), created };
}

/**
 * Changes how long a note lasts, leaving its start where it is.
 *
 * Only the end moves — dragging the start would shift the note in time, which
 * is what moveNote is for, and conflating the two makes a resize feel like it
 * dragged the whole note.
 */
export function resizeNote(
  score: ScoreDocument,
  noteId: string,
  durationMs: number,
): ScoreDocument {
  const index = score.notes.findIndex((note) => note.id === noteId);
  if (index === -1) return score;

  const notes = [...score.notes];
  notes[index] = {
    ...notes[index]!,
    durationMs: Math.max(MIN_NOTE_DURATION_MS, Math.round(durationMs)),
  };
  return withEdit(score, notes);
}

/** Removes a note. Unknown ids are a no-op. */
export function removeNote(score: ScoreDocument, noteId: string): ScoreDocument {
  const remaining = score.notes.filter((note) => note.id !== noteId);
  if (remaining.length === score.notes.length) return score;
  return withEdit(score, remaining);
}
