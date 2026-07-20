import { describe, expect, it } from 'vitest';
import type { AnalysisRecord, ScoreDocument } from '../core/types.ts';
import { addNote, moveNote, removeNote, seedScoreFromAnalysis } from './scoreEdits.ts';

function makeAnalysis(): AnalysisRecord {
  return {
    id: 'analysis-1',
    memoId: 'memo-1',
    audioHash: 'hash',
    algorithmId: 'mpm',
    algorithmVersion: '1.0.0',
    params: {},
    createdAt: 1,
    computeMs: 5,
    status: 'ok',
    input: { sampleRate: 22050, frameSizeSamples: 1024, hopSizeSamples: 256, frameCount: 100 },
    f0: {
      hz: new ArrayBuffer(4),
      confidence: new ArrayBuffer(4),
      rms: new ArrayBuffer(4),
    },
    tuning: { referenceA4Hz: 440, estimatedOffsetCents: -12 },
    notes: [
      { midi: 64, startMs: 600, durationMs: 400, centsDeviation: 5, confidence: 0.9 },
      { midi: 60, startMs: 0, durationMs: 500, centsDeviation: -8, confidence: 0.95 },
    ],
    quality: { voicedRatio: 0.8, medianConfidence: 0.9, warnings: [] },
  };
}

function seeded(): ScoreDocument {
  return seedScoreFromAnalysis('memo-1', makeAnalysis());
}

describe('seedScoreFromAnalysis', () => {
  it('copies the transcription with stable ids, sorted by start', () => {
    const score = seeded();
    expect(score.notes).toHaveLength(2);
    // The analysis listed them out of order; the score must not.
    expect(score.notes[0]!.midi).toBe(60);
    expect(score.notes[1]!.midi).toBe(64);
    expect(new Set(score.notes.map((n) => n.id)).size).toBe(2);
    expect(score.seededFromAnalysisId).toBe('analysis-1');
  });

  it('keeps the measured deviations — they are facts about the performance', () => {
    const score = seeded();
    expect(score.notes[0]!.centsDeviation).toBe(-8);
  });

  it('is user-owned from the moment it exists', () => {
    // Seeding happens on the first edit, so there is no untouched state.
    expect(seeded().userEdited).toBe(true);
  });
});

describe('moveNote', () => {
  it('moves pitch and time and re-sorts', () => {
    const score = seeded();
    const first = score.notes[0]!;

    // Push the first note past the second.
    const moved = moveNote(score, first.id, 72, 1000);
    expect(moved.notes[1]!.id).toBe(first.id);
    expect(moved.notes[1]!.midi).toBe(72);
    expect(moved.notes[1]!.startMs).toBe(1000);
  });

  it('clamps to the MIDI range and to time zero', () => {
    const score = seeded();
    const id = score.notes[0]!.id;
    expect(moveNote(score, id, 200, -50).notes.find((n) => n.id === id)).toMatchObject({
      midi: 127,
      startMs: 0,
    });
    expect(moveNote(score, id, -5, 0).notes.find((n) => n.id === id)!.midi).toBe(0);
  });

  it('zeroes the measured deviation once the pitch is changed by hand', () => {
    // The deviation described the sung note; it does not follow the note to a
    // pitch the user chose.
    const score = seeded();
    const id = score.notes[0]!.id;
    const moved = moveNote(score, id, 62, 0);
    expect(moved.notes.find((n) => n.id === id)!.centsDeviation).toBe(0);
  });

  it('keeps the deviation when only time changes', () => {
    const score = seeded();
    const id = score.notes[0]!.id;
    const moved = moveNote(score, id, 60, 200);
    expect(moved.notes.find((n) => n.id === id)!.centsDeviation).toBe(-8);
  });

  it('ignores unknown ids without inventing an edit', () => {
    const score = seeded();
    expect(moveNote(score, 'nope', 60, 0)).toBe(score);
  });
});

describe('addNote', () => {
  it('creates at the requested position with a duration borrowed from the melody', () => {
    const score = seeded();
    const { score: next, created } = addNote(score, 67, 1200);
    expect(created.midi).toBe(67);
    expect(created.startMs).toBe(1200);
    // Median of 400 and 500 (upper median): the new note should look like it
    // belongs, not like a constant.
    expect(created.durationMs).toBe(500);
    expect(next.notes).toHaveLength(3);
    // Hand-placed notes are exactly what the user asked for.
    expect(created.centsDeviation).toBe(0);
    expect(created.confidence).toBe(1);
  });

  it('falls back to a fixed duration in an empty score', () => {
    const empty: ScoreDocument = { ...seeded(), notes: [] };
    const { created } = addNote(empty, 60, 0);
    expect(created.durationMs).toBe(300);
  });
});

describe('removeNote', () => {
  it('removes by id', () => {
    const score = seeded();
    const id = score.notes[0]!.id;
    const next = removeNote(score, id);
    expect(next.notes).toHaveLength(1);
    expect(next.notes.some((n) => n.id === id)).toBe(false);
  });

  it('ignores unknown ids', () => {
    const score = seeded();
    expect(removeNote(score, 'nope')).toBe(score);
  });
});
