import { describe, expect, it } from 'vitest';
import { midiToHz, midiToName } from '../core/pitch.ts';
import {
  concat,
  glide,
  noise,
  silence,
  tone,
  withNoiseFloor,
} from '../test/signals.ts';
import { trackPitch } from './pitchTrack.ts';
import { segmentNotes } from './segmentation.ts';

/**
 * End-to-end checks of the transcription maths against signals whose correct
 * answer is known exactly. This cannot tell us how the pipeline handles a real
 * voice — only a real recording can — but it does pin down the arithmetic and
 * catch regressions in the segmentation rules.
 */

function transcribe(samples: Float32Array) {
  return segmentNotes(trackPitch(samples));
}

const noteNames = (samples: Float32Array) =>
  transcribe(samples).notes.map((n) => midiToName(n.midi));

describe('transcribing steady tones', () => {
  it('identifies a sustained A4', () => {
    const { notes } = transcribe(tone(440, 800));
    expect(notes).toHaveLength(1);
    expect(notes[0]!.midi).toBe(69);
    expect(Math.abs(notes[0]!.centsDeviation)).toBeLessThan(15);
  });

  it('reads a note sequence in order', () => {
    // C4 E4 G4 — a plain arpeggio, separated by short silences.
    const melody = concat(
      tone(midiToHz(60), 400),
      silence(120),
      tone(midiToHz(64), 400),
      silence(120),
      tone(midiToHz(67), 400),
    );
    expect(noteNames(melody)).toEqual(['C4', 'E4', 'G4']);
  });

  it('tracks pitch across the range people actually sing', () => {
    // Low male through high female, roughly D2 to A5.
    for (const midi of [38, 48, 60, 69, 81]) {
      const { notes } = transcribe(tone(midiToHz(midi), 600));
      expect(notes).toHaveLength(1);
      expect(notes[0]!.midi).toBe(midi);
    }
  });

  it('tracks whistling frequencies', () => {
    // Whistling sits far above the sung range and is nearly a pure sine, which
    // is precisely why the analysis rate was chosen above 16 kHz.
    for (const hz of [1200, 2000, 2800]) {
      const { notes } = transcribe(tone(hz, 600));
      expect(notes).toHaveLength(1);
      const recovered = midiToHz(notes[0]!.midi + notes[0]!.centsDeviation / 100);
      expect(Math.abs(1200 * Math.log2(recovered / hz))).toBeLessThan(35);
    }
  });

  it('is not fooled by harmonics into reporting an overtone', () => {
    // A voice is not a sine. The fundamental must win over its partials.
    const rich = tone(midiToHz(57), 700, { harmonics: [0.5, 0.35, 0.2, 0.1] });
    const { notes } = transcribe(rich);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.midi).toBe(57);
  });
});

describe('segmentation rules', () => {
  it('keeps a note with vibrato whole instead of splitting it', () => {
    // ±50 cents at 5.5 Hz is ordinary singing vibrato. Rounding each frame to
    // a semitone would shred this into dozens of alternating notes.
    const sung = tone(midiToHz(62), 1200, { vibratoCents: 50, vibratoHz: 5.5 });
    const { notes } = transcribe(sung);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.midi).toBe(62);
  });

  it('does not split on a brief gap inside a held note', () => {
    // Consonants and breaths interrupt voicing without ending the note.
    const held = concat(
      tone(midiToHz(64), 400),
      silence(35),
      tone(midiToHz(64), 400),
    );
    expect(transcribe(held).notes).toHaveLength(1);
  });

  it('splits on a long gap', () => {
    const separated = concat(
      tone(midiToHz(64), 400),
      silence(250),
      tone(midiToHz(64), 400),
    );
    expect(transcribe(separated).notes).toHaveLength(2);
  });

  it('separates adjacent notes with no silence between them', () => {
    // Legato: the hardest case, since only the pitch change marks the boundary.
    const legato = concat(tone(midiToHz(60), 500), tone(midiToHz(62), 500));
    expect(noteNames(legato)).toEqual(['C4', 'D4']);
  });

  it('discards blips too short to be intentional', () => {
    const withBlip = concat(
      tone(midiToHz(60), 500),
      tone(midiToHz(75), 25),
      tone(midiToHz(60), 500),
    );
    for (const note of transcribe(withBlip).notes) {
      expect(note.durationMs).toBeGreaterThanOrEqual(70);
    }
  });

  it('reports timings that follow the signal', () => {
    const melody = concat(
      silence(200),
      tone(midiToHz(60), 500),
      silence(200),
      tone(midiToHz(67), 500),
    );
    const { notes } = transcribe(melody);
    expect(notes).toHaveLength(2);
    // Generous tolerance: a ~46 ms window cannot place an edge more precisely.
    expect(notes[0]!.startMs).toBeGreaterThan(140);
    expect(notes[0]!.startMs).toBeLessThan(280);
    expect(notes[1]!.startMs).toBeGreaterThan(840);
    expect(notes[1]!.startMs).toBeLessThan(980);
  });
});

describe('rejecting what is not a melody', () => {
  it('finds no notes in silence', () => {
    expect(transcribe(silence(1000)).notes).toEqual([]);
  });

  it('finds no notes in noise', () => {
    expect(transcribe(noise(1000, 0.2)).notes).toEqual([]);
  });

  it('still finds the tune over a quiet room', () => {
    const sung = withNoiseFloor(tone(midiToHz(65), 700), 0.004);
    const { notes } = transcribe(sung);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.midi).toBe(65);
  });

  it('returns nothing for audio shorter than one analysis window', () => {
    expect(transcribe(tone(440, 5)).notes).toEqual([]);
  });
});

describe('tuning offset', () => {
  it('recovers the intended notes from consistently flat singing', () => {
    // Sung 45 cents flat throughout. Rounding raw pitch would put every note a
    // semitone low; correcting for the bias first recovers the actual tune.
    const flat = (midi: number) => midiToHz(midi) * Math.pow(2, -45 / 1200);
    const melody = concat(
      tone(flat(60), 400),
      silence(120),
      tone(flat(64), 400),
      silence(120),
      tone(flat(67), 400),
      silence(120),
      tone(flat(72), 400),
    );

    const { notes, estimatedOffsetCents } = transcribe(melody);
    expect(notes.map((n) => n.midi)).toEqual([60, 64, 67, 72]);
    expect(estimatedOffsetCents).toBeLessThan(-30);
    expect(estimatedOffsetCents).toBeGreaterThan(-60);
  });

  it('reports no bias for singing that is in tune', () => {
    const melody = concat(
      tone(midiToHz(60), 400),
      silence(120),
      tone(midiToHz(64), 400),
      silence(120),
      tone(midiToHz(67), 400),
    );
    expect(Math.abs(transcribe(melody).estimatedOffsetCents)).toBeLessThan(15);
  });
});

describe('glides', () => {
  it('does not invent a long run of notes for a slide', () => {
    // A scoop between two pitches should not read as a chromatic scale.
    const scoop = concat(
      tone(midiToHz(60), 300),
      glide(midiToHz(60), midiToHz(67), 200),
      tone(midiToHz(67), 300),
    );
    const { notes } = transcribe(scoop);
    expect(notes.length).toBeLessThanOrEqual(4);
    expect(notes[0]!.midi).toBe(60);
    expect(notes.at(-1)!.midi).toBe(67);
  });
});
