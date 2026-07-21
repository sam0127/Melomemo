import { describe, expect, it } from 'vitest';
import type { QuantizedNote } from '../core/types.ts';
import {
  DEFAULT_ROW_HEIGHT,
  MAX_ROLL_MIDI,
  MIN_ROLL_MIDI,
  clampRollMidi,
  createRollGeometry,
  defaultPitchRange,
  isAccidental,
  rangeIncluding,
  rollViewportHeight,
} from './pianoRollGeometry.ts';

function note(midi: number, startMs: number, durationMs: number): QuantizedNote {
  return { midi, startMs, durationMs, centsDeviation: 0, confidence: 0.9 };
}

const NOTES = [note(60, 0, 500), note(64, 600, 500), note(67, 1200, 500)];

/** The same range the component opens at, so tests and renderer agree. */
function rangeFor(notes: QuantizedNote[], rowHeight = DEFAULT_ROW_HEIGHT) {
  return defaultPitchRange(notes, rowHeight, rollViewportHeight(800));
}

function geometryFor(notes: QuantizedNote[], durationMs: number, rowHeight = DEFAULT_ROW_HEIGHT) {
  return createRollGeometry(notes, durationMs, {
    rowHeight,
    range: rangeFor(notes, rowHeight),
  });
}

describe('piano roll geometry', () => {
  const geometry = geometryFor(NOTES, 2000);

  it('places time zero at the left edge and the end at the right', () => {
    expect(geometry.xForMs(0)).toBe(0);
    expect(geometry.xForMs(geometry.totalMs)).toBeCloseTo(geometry.width, 5);
  });

  it('puts higher notes higher on the chart', () => {
    expect(geometry.yForMidi(72)).toBeLessThan(geometry.yForMidi(60));
  });

  it('covers every note it was given', () => {
    expect(geometry.lowestMidi).toBeLessThanOrEqual(60);
    expect(geometry.highestMidi).toBeGreaterThanOrEqual(67);
  });

  it('never ends before the audio or the notes it contains', () => {
    // A transcription can run past the recording's reported duration, and a
    // chart that stopped short would clip the last note.
    const overrunning = geometryFor([note(60, 0, 9000)], 1000);
    expect(overrunning.totalMs).toBeGreaterThanOrEqual(9000);
  });

  /*
   * The inverses are what note editing runs on: dragging a note asks what time
   * and pitch a pixel represents. They are tested because deriving them
   * separately is exactly how an editor ends up dropping notes a row away from
   * where they were released.
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

    it('measures a duration as the distance between its endpoints', () => {
      const width = geometry.widthForMs(500);
      expect(width).toBeCloseTo(geometry.xForMs(500) - geometry.xForMs(0), 5);
    });

    it('tracks the row height when zoomed', () => {
      const range = { low: 55, high: 75 };
      const at14 = createRollGeometry(NOTES, 2000, { rowHeight: 14, range });
      const at28 = createRollGeometry(NOTES, 2000, { rowHeight: 28, range });

      // Same rows, twice the height.
      expect(at28.height).toBe(at14.height * 2);
      // And the inverse still lands in the right row at the new scale.
      expect(at28.midiForY(at28.yForMidi(64) + 14)).toBe(64);
    });

    it('shows fewer semitones as it zooms in, still filling the view', () => {
      // The default range adapts to the row height, so zooming trades range
      // for detail rather than growing the chart past its window.
      const viewport = rollViewportHeight(800);
      const wide = defaultPitchRange(NOTES, 14, viewport);
      const close = defaultPitchRange(NOTES, 28, viewport);
      expect(close.high - close.low).toBeLessThan(wide.high - wide.low);
    });
  });

  it('still produces a usable range with no notes', () => {
    // An empty score needs somewhere to put the first note.
    const empty = geometryFor([], 1000);
    expect(empty.height).toBeGreaterThan(0);
    expect(empty.highestMidi).toBeGreaterThan(empty.lowestMidi);
  });
});

describe('pitch bounds', () => {
  it('clamps to the playable range', () => {
    expect(clampRollMidi(0)).toBe(MIN_ROLL_MIDI);
    expect(clampRollMidi(127)).toBe(MAX_ROLL_MIDI);
    expect(clampRollMidi(60)).toBe(60);
  });

  it('never opens outside the bounds, however extreme the notes', () => {
    const range = rangeFor([note(MIN_ROLL_MIDI, 0, 100), note(MAX_ROLL_MIDI, 0, 100)]);
    expect(range.low).toBeGreaterThanOrEqual(MIN_ROLL_MIDI);
    expect(range.high).toBeLessThanOrEqual(MAX_ROLL_MIDI);
  });

  it('ignores notes outside the bounds when framing the view', () => {
    // A stray note far outside the singable range must not stretch the chart
    // to reach it.
    const withOutlier = rangeFor([note(60, 0, 500), note(5, 0, 500)]);
    const withoutOutlier = rangeFor([note(60, 0, 500)]);
    expect(withOutlier).toEqual(withoutOutlier);
  });

  it('fills the visible height rather than leaving a half-empty box', () => {
    const rowHeight = DEFAULT_ROW_HEIGHT;
    const viewport = rollViewportHeight(800);
    // One note would otherwise need only a handful of rows.
    const range = defaultPitchRange([note(60, 0, 500)], rowHeight, viewport);
    expect((range.high - range.low + 1) * rowHeight).toBeGreaterThanOrEqual(viewport);
  });
});

describe('rangeIncluding', () => {
  it('widens upwards with headroom when a note reaches the top', () => {
    const widened = rangeIncluding({ low: 60, high: 72 }, 72);
    expect(widened.high).toBeGreaterThan(72);
    // There has to be somewhere left to drag to.
    expect(widened.low).toBe(60);
  });

  it('widens downwards when a note reaches the bottom', () => {
    const widened = rangeIncluding({ low: 60, high: 72 }, 60);
    expect(widened.low).toBeLessThan(60);
    expect(widened.high).toBe(72);
  });

  it('stops at the hard bounds', () => {
    const atTop = rangeIncluding({ low: 96, high: MAX_ROLL_MIDI }, MAX_ROLL_MIDI);
    expect(atTop.high).toBe(MAX_ROLL_MIDI);
    const atBottom = rangeIncluding({ low: MIN_ROLL_MIDI, high: 48 }, MIN_ROLL_MIDI);
    expect(atBottom.low).toBe(MIN_ROLL_MIDI);
  });

  it('returns the same object when nothing needs to change', () => {
    // Identity is the signal that no re-render or scroll fix is needed.
    const range = { low: 50, high: 80 };
    expect(rangeIncluding(range, 65)).toBe(range);
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
