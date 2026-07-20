/**
 * Equal-temperament conversions.
 *
 * Unused by v1 (which records and plays back only) but small, pure, and the
 * natural home for the tuning reference that v2 analysis and v3 MIDI both
 * need to agree on.
 */

/** Concert pitch. A4 = MIDI 69. */
export const DEFAULT_A4_HZ = 440;

const A4_MIDI = 69;
const SEMITONES_PER_OCTAVE = 12;
const CENTS_PER_SEMITONE = 100;

const NOTE_NAMES = [
  'C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B',
] as const;

/** Fractional MIDI note number for a frequency. Not rounded — see quantize. */
export function hzToMidi(hz: number, a4Hz: number = DEFAULT_A4_HZ): number {
  return A4_MIDI + SEMITONES_PER_OCTAVE * Math.log2(hz / a4Hz);
}

export function midiToHz(midi: number, a4Hz: number = DEFAULT_A4_HZ): number {
  return a4Hz * Math.pow(2, (midi - A4_MIDI) / SEMITONES_PER_OCTAVE);
}

/** Signed interval between two frequencies, in cents. */
export function centsBetween(fromHz: number, toHz: number): number {
  return CENTS_PER_SEMITONE * SEMITONES_PER_OCTAVE * Math.log2(toHz / fromHz);
}

/**
 * Snaps a frequency to the nearest equal-tempered note, keeping the deviation
 * rather than discarding it.
 *
 * The deviation is the point: it is how we later tell "sung slightly flat"
 * from "sung a different note", and how a global tuning offset gets estimated.
 */
export function quantizeHz(
  hz: number,
  a4Hz: number = DEFAULT_A4_HZ,
): { midi: number; centsDeviation: number } {
  const exact = hzToMidi(hz, a4Hz);
  const midi = Math.round(exact);
  return { midi, centsDeviation: (exact - midi) * CENTS_PER_SEMITONE };
}

/** Scientific pitch notation, e.g. 69 -> "A4". */
export function midiToName(midi: number): string {
  const n = Math.round(midi);
  const name = NOTE_NAMES[((n % 12) + 12) % 12]!;
  const octave = Math.floor(n / 12) - 1;
  return `${name}${octave}`;
}
