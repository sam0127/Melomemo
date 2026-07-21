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

/**
 * The pitch range the roll will ever show, A1 to C8.
 *
 * Chosen to bracket what anyone can sing or whistle with room to spare, and it
 * happens to line up with the analyser's own 55–4200 Hz sanity clamp, so a
 * transcription cannot produce a note outside it. Anything beyond is treated
 * as out of range rather than stretching the chart to reach it.
 */
export const MIN_ROLL_MIDI = 33;
export const MAX_ROLL_MIDI = 108;

/** Row height at 1× zoom, and the range zooming may take it through. */
export const DEFAULT_ROW_HEIGHT = 14;
export const MIN_ROW_HEIGHT = 7;
export const MAX_ROW_HEIGHT = 40;

/** Blank rows above and below the notes, so none sits flush to an edge. */
const PADDING_SEMITONES = 3;
/** Semitones added past a dragged note when it reaches the current edge. */
export const EXPAND_SEMITONES = 4;

const MIN_WIDTH = 280;

/** Width of the fixed pitch-label column beside the scrolling chart. */
export const KEY_GUTTER_WIDTH = 34;

/**
 * How tall an open roll may be, given the window.
 *
 * Capped so the rest of the memo — its title, transport and actions — still
 * fits on screen alongside it; the chart scrolls within this rather than
 * growing the page. Lives here so the component and its tests agree on one
 * definition instead of each guessing.
 */
const VIEWPORT_FRACTION = 0.46;
const MIN_VIEWPORT_PX = 140;
const MAX_VIEWPORT_PX = 520;

export function rollViewportHeight(windowHeight: number): number {
  return Math.max(
    MIN_VIEWPORT_PX,
    Math.min(MAX_VIEWPORT_PX, Math.round(windowHeight * VIEWPORT_FRACTION)),
  );
}

export interface PitchRange {
  low: number;
  high: number;
}

export interface RollGeometry {
  width: number;
  height: number;
  totalMs: number;
  /** Inclusive MIDI range the chart currently covers. */
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

export function clampRollMidi(midi: number): number {
  return Math.min(MAX_ROLL_MIDI, Math.max(MIN_ROLL_MIDI, Math.round(midi)));
}

/** Notes the roll is willing to draw; anything else is out of range. */
export function inRange(note: QuantizedNote): boolean {
  return note.midi >= MIN_ROLL_MIDI && note.midi <= MAX_ROLL_MIDI;
}

/**
 * The pitch range to open a transcription at: every note it contains, plus
 * padding, then grown to fill the visible height so the chart does not float
 * in a half-empty box. Growth stops at the hard bounds.
 */
export function defaultPitchRange(
  notes: readonly QuantizedNote[],
  rowHeight: number,
  viewportHeight: number,
): PitchRange {
  const midis = notes.filter(inRange).map((note) => note.midi);
  // An empty score still needs somewhere to put the first note.
  const lowestNote = midis.length > 0 ? Math.min(...midis) : 55;
  const highestNote = midis.length > 0 ? Math.max(...midis) : 72;

  let low = clampRollMidi(lowestNote - PADDING_SEMITONES);
  let high = clampRollMidi(highestNote + PADDING_SEMITONES);

  // Grow outwards, alternating, until the rows fill the window or the bounds
  // stop us.
  const wanted = Math.ceil(viewportHeight / rowHeight);
  while (
    high - low + 1 < wanted &&
    (high < MAX_ROLL_MIDI || low > MIN_ROLL_MIDI)
  ) {
    if (high < MAX_ROLL_MIDI) high++;
    if (high - low + 1 >= wanted) break;
    if (low > MIN_ROLL_MIDI) low--;
  }

  return { low, high };
}

/**
 * Widens a range so a dragged note stays reachable, keeping a semitone of
 * headroom past it so there is somewhere left to drag to.
 */
export function rangeIncluding(range: PitchRange, midi: number): PitchRange {
  const low = midi <= range.low + 1
    ? Math.max(MIN_ROLL_MIDI, midi - EXPAND_SEMITONES)
    : range.low;
  const high = midi >= range.high - 1
    ? Math.min(MAX_ROLL_MIDI, midi + EXPAND_SEMITONES)
    : range.high;
  return low === range.low && high === range.high ? range : { low, high };
}

export function createRollGeometry(
  notes: readonly QuantizedNote[],
  durationMs: number,
  options: { rowHeight: number; range: PitchRange },
): RollGeometry {
  const { rowHeight, range } = options;
  const lowestMidi = range.low;
  const highestMidi = range.high;
  const semitoneSpan = Math.max(1, highestMidi - lowestMidi + 1);

  const notesEnd = notes.reduce(
    (end, note) => Math.max(end, note.startMs + note.durationMs),
    0,
  );
  // Never shorter than the audio, never shorter than the notes it contains.
  const totalMs = Math.max(durationMs, notesEnd, 1);

  const width = Math.max(MIN_WIDTH, (totalMs / 1000) * PIXELS_PER_SECOND);
  const height = semitoneSpan * rowHeight;

  const xForMs = (ms: number) => (ms / totalMs) * width;
  const yForMidi = (midi: number) => (highestMidi - midi) * rowHeight;

  return {
    width,
    height,
    totalMs,
    lowestMidi,
    highestMidi,
    rowHeight,

    xForMs,
    yForMidi,
    msForX: (x: number) => (x / width) * totalMs,
    midiForY: (y: number) => highestMidi - Math.floor(y / rowHeight),
    widthForMs: (durationMs: number) => (durationMs / totalMs) * width,
  };
}

/** The black keys, used to shade rows so octaves are readable at a glance. */
export function isAccidental(midi: number): boolean {
  return [1, 3, 6, 8, 10].includes(((midi % 12) + 12) % 12);
}
