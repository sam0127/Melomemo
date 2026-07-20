import { describe, expect, it } from 'vitest';
import {
  centsBetween,
  hzToMidi,
  midiToHz,
  midiToName,
  quantizeHz,
} from './pitch.ts';

describe('equal temperament conversions', () => {
  it('anchors A4 to MIDI 69 at 440 Hz', () => {
    expect(hzToMidi(440)).toBeCloseTo(69, 10);
    expect(midiToHz(69)).toBeCloseTo(440, 10);
  });

  it('treats an octave as twelve semitones', () => {
    expect(hzToMidi(880)).toBeCloseTo(81, 10);
    expect(centsBetween(440, 880)).toBeCloseTo(1200, 10);
  });

  it('round-trips across the range a person can sing or whistle', () => {
    for (const midi of [36, 48, 60, 69, 72, 84, 96]) {
      expect(hzToMidi(midiToHz(midi))).toBeCloseTo(midi, 10);
    }
  });

  it('honours a shifted tuning reference', () => {
    // Baroque pitch: what reads as A4 at 440 is flat of it at 415.
    expect(hzToMidi(415, 415)).toBeCloseTo(69, 10);
    expect(hzToMidi(415, 440)).toBeLessThan(69);
  });
});

describe('quantizeHz', () => {
  it('keeps the deviation instead of discarding it', () => {
    // A performance sung consistently flat is information about the singer,
    // not noise to be rounded away.
    const flat = quantizeHz(midiToHz(69) * Math.pow(2, -40 / 1200));
    expect(flat.midi).toBe(69);
    expect(flat.centsDeviation).toBeCloseTo(-40, 6);
  });

  it('reports no deviation for a note exactly in tune', () => {
    const exact = quantizeHz(440);
    expect(exact.midi).toBe(69);
    expect(exact.centsDeviation).toBeCloseTo(0, 10);
  });

  it('snaps to the nearer neighbour at the boundary', () => {
    // 60 cents sharp of A4 is closer to A#4 than to A4.
    const sharp = quantizeHz(midiToHz(69) * Math.pow(2, 60 / 1200));
    expect(sharp.midi).toBe(70);
    expect(sharp.centsDeviation).toBeCloseTo(-40, 6);
  });
});

describe('midiToName', () => {
  it('uses scientific pitch notation', () => {
    expect(midiToName(69)).toBe('A4');
    expect(midiToName(60)).toBe('C4');
    expect(midiToName(21)).toBe('A0');
  });
});
