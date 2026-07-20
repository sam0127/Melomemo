import type { QuantizedNote } from '../core/types.ts';

/**
 * The mapping between musical values and screen coordinates for the piano
 * roll.
 *
 * Pulled out of the component and made bidirectional on purpose. Rendering
 * only needs time→x and midi→y, but note editing needs the inverses: dragging
 * a note asks "what time and pitch is this pixel?", and creating one asks the
 * same of a click. Keeping both directions in one place means the note you
 * drop lands exactly where the renderer draws it — deriving the inverse
 * separately is how editors end up off by a row.
 */

export const PIXELS_PER_SECOND = 110;
export const ROW_HEIGHT = 11;
/** Blank rows above and below, so the highest and lowest notes aren't flush to the edge. */
const PADDING_SEMITONES = 3;
const MIN_WIDTH = 280;

export interface RollGeometry {
  width: number;
  height: number;
  totalMs: number;
  /** Inclusive MIDI range covered by the drawing, padding included. */
  lowestMidi: number;
  highestMidi: number;
  rowHeight: number;

  xForMs(ms: number): number;
  msForX(x: number): number;
  /** Top edge of the row for a note. */
  yForMidi(midi: number): number;
  /** Nearest MIDI note for a vertical position. */
  midiForY(y: number): number;
  widthForMs(durationMs: number): number;
}

export function createRollGeometry(
  notes: readonly QuantizedNote[],
  durationMs: number,
): RollGeometry {
  const midis = notes.map((note) => note.midi);
  // A roll with no notes still needs a sane range, or editing would have
  // nowhere to place the first one.
  const lowestNote = midis.length > 0 ? Math.min(...midis) : 60;
  const highestNote = midis.length > 0 ? Math.max(...midis) : 72;

  const lowestMidi = lowestNote - PADDING_SEMITONES;
  const highestMidi = highestNote + PADDING_SEMITONES;
  const semitoneSpan = Math.max(1, highestMidi - lowestMidi + 1);

  const notesEnd = notes.reduce(
    (end, note) => Math.max(end, note.startMs + note.durationMs),
    0,
  );
  // Never shorter than the audio, never shorter than the notes it contains.
  const totalMs = Math.max(durationMs, notesEnd, 1);

  const width = Math.max(MIN_WIDTH, (totalMs / 1000) * PIXELS_PER_SECOND);
  const height = semitoneSpan * ROW_HEIGHT;

  const xForMs = (ms: number) => (ms / totalMs) * width;
  const yForMidi = (midi: number) => (highestMidi - midi) * ROW_HEIGHT;

  return {
    width,
    height,
    totalMs,
    lowestMidi,
    highestMidi,
    rowHeight: ROW_HEIGHT,

    xForMs,
    yForMidi,
    msForX: (x: number) => (x / width) * totalMs,
    midiForY: (y: number) => highestMidi - Math.floor(y / ROW_HEIGHT),
    widthForMs: (durationMs: number) => (durationMs / totalMs) * width,
  };
}

/** The black keys, used to shade rows so octaves are readable at a glance. */
export function isAccidental(midi: number): boolean {
  return [1, 3, 6, 8, 10].includes(((midi % 12) + 12) % 12);
}
