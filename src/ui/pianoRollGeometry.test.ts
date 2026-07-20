import { describe, expect, it } from 'vitest';
import type { QuantizedNote } from '../core/types.ts';
import { createRollGeometry, isAccidental } from './pianoRollGeometry.ts';

function note(midi: number, startMs: number, durationMs: number): QuantizedNote {
  return { midi, startMs, durationMs, centsDeviation: 0, confidence: 0.9 };
}

describe('piano roll geometry', () => {
  const notes = [note(60, 0, 500), note(64, 600, 500), note(67, 1200, 500)];
  const geometry = createRollGeometry(notes, 2000);

  it('places time zero at the left edge and the end at the right', () => {
    expect(geometry.xForMs(0)).toBe(0);
    expect(geometry.xForMs(geometry.totalMs)).toBeCloseTo(geometry.width, 5);
  });

  it('puts higher notes higher on the chart', () => {
    expect(geometry.yForMidi(72)).toBeLessThan(geometry.yForMidi(60));
  });

  it('pads the pitch range so edge notes are not flush to the border', () => {
    expect(geometry.lowestMidi).toBeLessThan(60);
    expect(geometry.highestMidi).toBeGreaterThan(67);
  });

  it('never ends before the audio or the notes it contains', () => {
    // A transcription can run past the recording's reported duration, and a
    // chart that stopped short would clip the last note.
    const overrunning = createRollGeometry([note(60, 0, 9000)], 1000);
    expect(overrunning.totalMs).toBeGreaterThanOrEqual(9000);
  });

  /*
   * The inverses are what note editing runs on: dragging a note asks what time
   * and pitch a pixel represents. They are tested now, before that feature
   * exists, because deriving them separately later is exactly how an editor
   * ends up dropping notes a row away from where they were released.
   */
  describe('inverse mappings', () => {
    it('round-trips time through x', () => {
      for (const ms of [0, 250, 1000, 1999]) {
        expect(geometry.msForX(geometry.xForMs(ms))).toBeCloseTo(ms, 5);
      }
    });

    it('recovers the note whose row contains a point', () => {
      for (const midi of [60, 64, 67, 70]) {
        // Anywhere inside the row must resolve to that row's note, so a drag
        // released mid-row does not land a semitone off.
        const top = geometry.yForMidi(midi);
        expect(geometry.midiForY(top + 0.1)).toBe(midi);
        expect(geometry.midiForY(top + geometry.rowHeight / 2)).toBe(midi);
        expect(geometry.midiForY(top + geometry.rowHeight - 0.1)).toBe(midi);
      }
    });

    it('agrees with where notes are actually drawn', () => {
      const drawn = geometry.yForMidi(64);
      expect(geometry.midiForY(drawn + geometry.rowHeight / 2)).toBe(64);
    });

    it('measures a duration as the distance between its endpoints', () => {
      const width = geometry.widthForMs(500);
      expect(width).toBeCloseTo(geometry.xForMs(500) - geometry.xForMs(0), 5);
    });
  });

  it('still produces a usable range with no notes', () => {
    // An empty score needs somewhere to put the first note.
    const empty = createRollGeometry([], 1000);
    expect(empty.height).toBeGreaterThan(0);
    expect(empty.highestMidi).toBeGreaterThan(empty.lowestMidi);
  });
});

describe('isAccidental', () => {
  it('marks the black keys', () => {
    expect(isAccidental(61)).toBe(true); // C#4
    expect(isAccidental(60)).toBe(false); // C4
    expect(isAccidental(71)).toBe(false); // B4
    // Must hold in every octave, including below MIDI zero's octave boundary.
    expect(isAccidental(1)).toBe(true);
    expect(isAccidental(13)).toBe(true);
  });
});
