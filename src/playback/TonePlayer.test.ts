import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QuantizedNote } from '../core/types.ts';
import { TonePlayer, WAVEFORM } from './TonePlayer.ts';

/**
 * jsdom has no Web Audio, so the graph is faked. What is worth asserting here
 * is not the sound but the transport bookkeeping: which memo is loaded, what
 * the status is, where the playhead sits, and that pausing then resuming
 * schedules the remainder correctly. A desync between those and the audible
 * truth is exactly the class of bug this player exists to prevent.
 */

class FakeParam {
  value = 0;
  setValueAtTime() {}
  linearRampToValueAtTime() {}
}

class FakeOscillator {
  type = 'sine';
  frequency = new FakeParam();
  started: number | null = null;
  stopped: number | null = null;
  onended: unknown = null;
  connect() {}
  disconnect() {}
  start(t: number) {
    this.started = t;
  }
  stop(t?: number) {
    this.stopped = t ?? 0;
  }
}

class FakeGain {
  gain = new FakeParam();
  connect() {}
  disconnect() {}
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  state = 'running';
  /** Advanced by tests to simulate audio time passing. */
  currentTime = 0;
  destination = {};
  oscillators: FakeOscillator[] = [];

  constructor() {
    FakeAudioContext.instances.push(this);
  }
  createOscillator() {
    const osc = new FakeOscillator();
    this.oscillators.push(osc);
    return osc;
  }
  createGain() {
    return new FakeGain();
  }
  async resume() {
    this.state = 'running';
  }
  async close() {
    this.state = 'closed';
  }
}

function notes(...midis: number[]): QuantizedNote[] {
  return midis.map((midi, index) => ({
    midi,
    startMs: index * 500,
    durationMs: 400,
    centsDeviation: 0,
    confidence: 0.9,
  }));
}

function context(): FakeAudioContext {
  return FakeAudioContext.instances[0]!;
}

describe('TonePlayer transport', () => {
  beforeEach(() => {
    FakeAudioContext.instances = [];
    vi.stubGlobal('AudioContext', FakeAudioContext);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('sounds one oscillator per note at equal-tempered pitch', async () => {
    const player = new TonePlayer();
    await player.play('memo-1', notes(69, 72)); // A4, C5

    expect(context().oscillators).toHaveLength(2);
    expect(context().oscillators[0]!.frequency.value).toBeCloseTo(440, 5);
    expect(context().oscillators[1]!.frequency.value).toBeCloseTo(523.25, 1);
    // Asserted against the exported constant rather than a literal, so
    // changing the waveform cannot leave this test checking the old one.
    expect(context().oscillators.every((o) => o.type === WAVEFORM)).toBe(true);
  });

  it('schedules notes at their transcribed offsets', async () => {
    const player = new TonePlayer();
    await player.play('memo-1', notes(60, 62, 64));

    const starts = context().oscillators.map((o) => o.started!);
    expect(starts[1]! - starts[0]!).toBeCloseTo(0.5, 5);
    expect(starts[2]! - starts[1]!).toBeCloseTo(0.5, 5);
  });

  it('moves through playing, paused, and back', async () => {
    const player = new TonePlayer();
    expect(player.status).toBe('idle');

    await player.play('memo-1', notes(60, 62, 64));
    expect(player.status).toBe('playing');

    player.pause();
    expect(player.status).toBe('paused');
    expect(player.currentMemoId).toBe('memo-1');

    await player.resume();
    expect(player.status).toBe('playing');

    player.stop();
    expect(player.status).toBe('idle');
  });

  it('tracks position from audio time, and holds it across a pause', async () => {
    const player = new TonePlayer();
    await player.play('memo-1', notes(60, 62, 64));

    // The run starts LEAD_S after currentTime; advance 0.66s of audio time,
    // which is 0.6s past the lead.
    context().currentTime += 0.66;
    expect(player.positionMs).toBeCloseTo(600, 0);

    player.pause();
    // Audio time marching on must not move a paused playhead.
    context().currentTime += 5;
    expect(player.positionMs).toBeCloseTo(600, 0);
  });

  it('resumes by scheduling only what remains', async () => {
    const player = new TonePlayer();
    // Three notes: 0-400, 500-900, 1000-1400 ms.
    await player.play('memo-1', notes(60, 62, 64));

    context().currentTime += 0.06 + 0.7; // lead + 700ms: inside the second note
    player.pause();
    const before = context().oscillators.length;

    await player.resume();
    const scheduled = context().oscillators.slice(before);

    // The first note is over; the second restarts truncated, the third whole.
    expect(scheduled).toHaveLength(2);
    const [second, third] = scheduled;
    // Resumed run's own lead-relative offsets: the straddling note starts
    // immediately, the next one 300ms later (1000 - 700).
    expect(third!.started! - second!.started!).toBeCloseTo(0.3, 5);
    // The truncated note ends 200ms in (900 - 700), when it always would have.
    expect(second!.stopped! - second!.started!).toBeCloseTo(0.2, 5);
  });

  it('restart plays from the beginning whatever the state', async () => {
    const player = new TonePlayer();
    await player.play('memo-1', notes(60, 62));
    context().currentTime += 0.8;
    player.pause();

    await player.restart();
    expect(player.status).toBe('playing');
    expect(player.positionMs).toBeCloseTo(0, 0);
    // A full restart schedules every note again.
    expect(context().oscillators.length).toBe(4);
  });

  it('tells subscribers the status and memo together', async () => {
    const seen: Array<[string, string | null]> = [];
    const player = new TonePlayer();
    player.subscribe((state) => seen.push([state.status, state.memoId]));

    await player.play('memo-1', notes(60));
    player.pause();
    await player.resume();
    player.stop();

    expect(seen).toEqual([
      ['idle', null],
      ['playing', 'memo-1'],
      ['paused', 'memo-1'],
      ['playing', 'memo-1'],
      ['idle', 'memo-1'],
    ]);
  });

  it('replaces a sequence already playing rather than layering it', async () => {
    const player = new TonePlayer();
    await player.play('memo-1', notes(60, 62));
    await player.play('memo-2', notes(67));

    expect(player.currentMemoId).toBe('memo-2');
    // The first sequence's voices must be stopped, not left ringing.
    expect(
      context().oscillators.slice(0, 2).every((o) => o.stopped !== null),
    ).toBe(true);
  });

  it('returns to idle at the start once the sequence finishes on its own', async () => {
    const player = new TonePlayer();
    await player.play('memo-1', notes(60, 62));
    expect(player.status).toBe('playing');

    // Without this the button would stay on "Pause" after the audio ended,
    // and a subsequent play would resume from the end and do nothing.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(player.status).toBe('idle');
    expect(player.positionMs).toBe(0);
  });

  describe('seeking', () => {
    it('cues a memo without sounding it', () => {
      const player = new TonePlayer();
      player.load('memo-1', notes(60, 62));

      // Nothing audible yet — but the transport now holds the memo, so its
      // playhead can be scrubbed before anything has played.
      expect(FakeAudioContext.instances).toHaveLength(0);
      expect(player.currentMemoId).toBe('memo-1');
      expect(player.status).toBe('paused');
      expect(player.positionMs).toBe(0);
    });

    it('leaves the position alone when the same memo is re-loaded', () => {
      const player = new TonePlayer();
      player.load('memo-1', notes(60, 62));
      player.seek(400);

      // Re-rendering must not drag the playhead back to the start.
      player.load('memo-1', notes(60, 62));
      expect(player.positionMs).toBe(400);
    });

    it('moves the resume point when not playing', () => {
      const player = new TonePlayer();
      player.load('memo-1', notes(60, 62, 64));
      player.seek(700);
      expect(player.positionMs).toBe(700);
      expect(player.status).toBe('paused');
    });

    it('reschedules from the new position when playing', async () => {
      const player = new TonePlayer();
      await player.play('memo-1', notes(60, 62, 64));
      const before = context().oscillators.length;

      player.seek(1000);
      await Promise.resolve();
      await Promise.resolve();

      // Only the note at 1000ms onwards is rebuilt.
      expect(context().oscillators.length).toBeGreaterThan(before);
      expect(player.status).toBe('playing');
    });

    it('clamps to the bounds of the sequence', () => {
      const player = new TonePlayer();
      player.load('memo-1', notes(60, 62)); // ends at 900ms
      player.seek(-500);
      expect(player.positionMs).toBe(0);
      player.seek(999_999);
      expect(player.positionMs).toBe(TonePlayer.durationOf(notes(60, 62)));
    });

    it('ignores a seek when nothing is loaded', () => {
      const player = new TonePlayer();
      player.seek(500);
      expect(player.status).toBe('idle');
      expect(player.currentMemoId).toBeNull();
    });
  });

  describe('auditioning a pitch', () => {
    it('sounds the requested pitch', async () => {
      const player = new TonePlayer();
      await player.previewPitch(69);

      expect(context().oscillators).toHaveLength(1);
      expect(context().oscillators[0]!.frequency.value).toBeCloseTo(440, 5);
      expect(context().oscillators[0]!.type).toBe(WAVEFORM);
    });

    it('is monophonic, so dragging across rows does not pile up', async () => {
      const player = new TonePlayer();
      await player.previewPitch(60);
      await player.previewPitch(62);
      await player.previewPitch(64);

      const [first, second, third] = context().oscillators;
      // Each audition replaces the one before it; only the newest still rings.
      expect(first!.stopped).not.toBeNull();
      expect(second!.stopped).not.toBeNull();
      expect(third!.stopped).toBeCloseTo(third!.started! + 0.22, 5);
    });

    it('leaves an idle transport idle', async () => {
      const player = new TonePlayer();
      await player.previewPitch(60);

      // Clicking a note to hear it must not look like starting playback.
      expect(player.status).toBe('idle');
      expect(player.currentMemoId).toBeNull();
      expect(player.positionMs).toBe(0);
    });

    it('does not interrupt playback in progress', async () => {
      const player = new TonePlayer();
      await player.play('memo-1', notes(60, 62, 64));
      const transportVoices = [...context().oscillators];
      // Scheduled at creation, each to its own note end. A teardown would
      // instead call stop() with no argument, rewriting these to 0.
      const scheduledStops = transportVoices.map((v) => v.stopped);

      context().currentTime += 0.5;
      await player.previewPitch(72);

      expect(player.status).toBe('playing');
      expect(player.currentMemoId).toBe('memo-1');
      // The sequence's own voices are untouched — auditioning is not a
      // transport operation.
      expect(transportVoices.map((v) => v.stopped)).toEqual(scheduledStops);
    });

    it('does not move the playhead', async () => {
      const player = new TonePlayer();
      player.load('memo-1', notes(60, 62));
      player.seek(400);
      await player.previewPitch(72);

      expect(player.positionMs).toBe(400);
      expect(player.status).toBe('paused');
    });
  });

  it('does nothing for an empty transcription', async () => {
    const player = new TonePlayer();
    await player.play('memo-1', []);
    expect(player.status).toBe('idle');
    expect(FakeAudioContext.instances).toHaveLength(0);
  });
});
