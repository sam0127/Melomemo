import { midiToHz } from '../core/pitch.ts';
import type { QuantizedNote } from '../core/types.ts';

/**
 * Plays a transcription back as tones.
 *
 * Deliberately separate from PlaybackService, which plays the original
 * recording: hearing the two side by side is the only practical way to judge
 * whether a transcription is right. This one synthesises the *quantized*
 * notes — equal-tempered, at concert pitch — so what you hear is exactly what
 * was written down, including its mistakes.
 *
 * One oscillator per note, sawtooth rather than sine: the harmonics make the
 * pitch far easier to place by ear when comparing against a recording, which
 * is the whole purpose of playing this back.
 */

/** Single source of truth for the waveform, so docs and tests cannot drift from it. */
export const WAVEFORM: OscillatorType = 'sawtooth';

/** Ramp lengths, in seconds. Without them each note starts and ends with an audible click. */
const ATTACK_S = 0.008;
const RELEASE_S = 0.05;

/** Scheduling lead, so the first note isn't clipped by setup cost. */
const LEAD_S = 0.06;

/** Per-note level. Low enough that several overlapping notes cannot clip. */
const NOTE_GAIN = 0.22;

export interface TonePlayerState {
  playing: boolean;
  /** Which memo is sounding, so a list of memos can show it on the right row. */
  memoId: string | null;
}

export type TonePlayerListener = (state: TonePlayerState) => void;

/**
 * The player owns which memo is playing, rather than the UI tracking that
 * alongside it. Two copies of the same fact drift: the UI would set "playing"
 * optimistically while the player emitted its own transitions, and any
 * ordering between them left the button showing the wrong label. One source of
 * truth, published through the subscription, removes the possibility.
 */
export class TonePlayer {
  #context: AudioContext | null = null;
  #master: GainNode | null = null;
  #voices: OscillatorNode[] = [];
  #endTimer: ReturnType<typeof setTimeout> | null = null;
  #memoId: string | null = null;
  #listeners = new Set<TonePlayerListener>();

  get playing(): boolean {
    return this.#memoId !== null;
  }

  /** Read directly by handlers, so a toggle never acts on a stale render. */
  get currentMemoId(): string | null {
    return this.#memoId;
  }

  subscribe(listener: TonePlayerListener): () => void {
    this.#listeners.add(listener);
    listener(this.#state());
    return () => this.#listeners.delete(listener);
  }

  #state(): TonePlayerState {
    return { playing: this.#memoId !== null, memoId: this.#memoId };
  }

  #emit(memoId: string | null): void {
    this.#memoId = memoId;
    const state = this.#state();
    for (const listener of this.#listeners) listener(state);
  }

  /**
   * The context is created on first play, never at construction: iOS requires
   * a user gesture, and an AudioContext created outside one starts suspended
   * and silently plays nothing.
   */
  async #ensureContext(): Promise<AudioContext | null> {
    if (!this.#context) {
      const Ctor =
        typeof AudioContext !== 'undefined'
          ? AudioContext
          : (globalThis as { webkitAudioContext?: typeof AudioContext })
              .webkitAudioContext;
      if (!Ctor) return null;
      this.#context = new Ctor();
      this.#master = this.#context.createGain();
      this.#master.gain.value = 1;
      this.#master.connect(this.#context.destination);
    }

    // Safari parks the context in 'suspended', and in an iOS-only
    // 'interrupted' state after a call. Both need an explicit resume.
    if (this.#context.state !== 'running') {
      try {
        await this.#context.resume();
      } catch {
        // Resuming can reject when not in a gesture; playing will be silent,
        // which the caller cannot do anything about.
      }
    }
    return this.#context;
  }

  /** Plays a sequence. Any sequence already playing is replaced. */
  async play(memoId: string, notes: QuantizedNote[]): Promise<void> {
    this.stop();
    if (notes.length === 0) return;

    const context = await this.#ensureContext();
    if (!context || !this.#master) return;

    const startAt = context.currentTime + LEAD_S;
    let lastEnd = startAt;

    for (const note of notes) {
      const noteStart = startAt + note.startMs / 1000;
      // A note shorter than its own ramps would never reach full level.
      const noteEnd =
        noteStart + Math.max(note.durationMs / 1000, ATTACK_S + RELEASE_S);

      const oscillator = context.createOscillator();
      oscillator.type = WAVEFORM;
      oscillator.frequency.value = midiToHz(note.midi);

      const gain = context.createGain();
      gain.gain.setValueAtTime(0, noteStart);
      gain.gain.linearRampToValueAtTime(NOTE_GAIN, noteStart + ATTACK_S);
      gain.gain.setValueAtTime(NOTE_GAIN, Math.max(noteEnd - RELEASE_S, noteStart + ATTACK_S));
      gain.gain.linearRampToValueAtTime(0, noteEnd);

      oscillator.connect(gain);
      gain.connect(this.#master);
      oscillator.start(noteStart);
      oscillator.stop(noteEnd);

      this.#voices.push(oscillator);
      if (noteEnd > lastEnd) lastEnd = noteEnd;
    }

    this.#emit(memoId);

    // Driven by a timer rather than the last oscillator's `ended` event,
    // because `stop()` fires that event too and would race with it.
    this.#endTimer = setTimeout(
      () => {
        this.#endTimer = null;
        this.#voices = [];
        this.#emit(null);
      },
      Math.max(0, (lastEnd - context.currentTime) * 1000) + 50,
    );
  }

  stop(): void {
    if (this.#endTimer !== null) {
      clearTimeout(this.#endTimer);
      this.#endTimer = null;
    }
    for (const voice of this.#voices) {
      try {
        voice.onended = null;
        voice.stop();
        voice.disconnect();
      } catch {
        // Already stopped, or never started; nothing to release.
      }
    }
    this.#voices = [];
    if (this.#memoId !== null) this.#emit(null);
  }

  dispose(): void {
    this.stop();
    this.#listeners.clear();
    void this.#context?.close().catch(() => {});
    this.#context = null;
    this.#master = null;
  }
}
