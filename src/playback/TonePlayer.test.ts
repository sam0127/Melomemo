import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QuantizedNote } from '../core/types.ts';
import { TonePlayer, WAVEFORM } from './TonePlayer.ts';

/**
 * jsdom has no Web Audio, so the graph is faked. What is worth asserting here
 * is not the sound but the bookkeeping: which memo the player believes it is
 * playing, and that subscribers are told the truth. A desync there showed the
 * wrong button label while audio was audibly playing.
 */

class FakeParam {
  events: Array<[string, number, number]> = [];
  value = 0;
  setValueAtTime(v: number, t: number) {
    this.events.push(['set', v, t]);
  }
  linearRampToValueAtTime(v: number, t: number) {
    this.events.push(['ramp', v, t]);
  }
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

describe('TonePlayer', () => {
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

    const context = FakeAudioContext.instances[0]!;
    expect(context.oscillators).toHaveLength(2);
    expect(context.oscillators[0]!.frequency.value).toBeCloseTo(440, 5);
    expect(context.oscillators[1]!.frequency.value).toBeCloseTo(523.25, 1);
    // Asserted against the exported constant rather than a literal, so
    // changing the waveform doesn't silently leave this test checking the old
    // one.
    expect(context.oscillators.every((o) => o.type === WAVEFORM)).toBe(true);
  });

  it('schedules notes at their transcribed offsets', async () => {
    const player = new TonePlayer();
    await player.play('memo-1', notes(60, 62, 64));

    const context = FakeAudioContext.instances[0]!;
    const starts = context.oscillators.map((o) => o.started!);
    expect(starts[1]! - starts[0]!).toBeCloseTo(0.5, 5);
    expect(starts[2]! - starts[1]!).toBeCloseTo(0.5, 5);
  });

  it('reports which memo is playing', async () => {
    const player = new TonePlayer();
    expect(player.currentMemoId).toBeNull();

    await player.play('memo-1', notes(60));
    expect(player.currentMemoId).toBe('memo-1');
    expect(player.playing).toBe(true);

    player.stop();
    expect(player.currentMemoId).toBeNull();
    expect(player.playing).toBe(false);
  });

  it('tells subscribers which memo is playing, not just that something is', async () => {
    // The UI decides which row shows "Stop" from this, so the id has to travel
    // with the transition.
    const seen: Array<string | null> = [];
    const player = new TonePlayer();
    player.subscribe((state) => seen.push(state.memoId));

    await player.play('memo-1', notes(60));
    player.stop();

    expect(seen).toEqual([null, 'memo-1', null]);
  });

  it('replaces a sequence already playing rather than layering it', async () => {
    const player = new TonePlayer();
    await player.play('memo-1', notes(60, 62));
    await player.play('memo-2', notes(67));

    expect(player.currentMemoId).toBe('memo-2');
    const context = FakeAudioContext.instances[0]!;
    // The first sequence's voices must be stopped, not left ringing.
    expect(context.oscillators.slice(0, 2).every((o) => o.stopped !== null)).toBe(true);
  });

  it('returns to idle once the sequence finishes on its own', async () => {
    const player = new TonePlayer();
    await player.play('memo-1', notes(60, 62));
    expect(player.playing).toBe(true);

    // Without this the button would stay on "Stop" after the audio ended.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(player.playing).toBe(false);
    expect(player.currentMemoId).toBeNull();
  });

  it('does nothing for an empty transcription', async () => {
    const player = new TonePlayer();
    await player.play('memo-1', []);
    expect(player.playing).toBe(false);
    expect(FakeAudioContext.instances).toHaveLength(0);
  });
});
