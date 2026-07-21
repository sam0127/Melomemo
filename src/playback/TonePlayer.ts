import { midiToHz } from '../core/pitch.ts';
import type { QuantizedNote } from '../core/types.ts';

/**
 * Plays a transcription back as tones, with transport controls.
 *
 * Deliberately separate from PlaybackService, which plays the original
 * recording: hearing the two side by side is the only practical way to judge
 * whether a transcription is right. This one synthesises the *quantized*
 * notes — equal-tempered, at concert pitch — so what you hear is exactly what
 * was written down, including its mistakes.
 *
 * One oscillator per note, sawtooth rather than sine: the harmonics make the
 * pitch far easier to place by ear when comparing against a recording.
 *
 * There is no such thing as pausing a Web Audio oscillator. "Pause" therefore
 * means stopping every voice, remembering the position, and rescheduling the
 * remaining notes from that offset on resume — including any note that
 * straddles the pause point, which restarts truncated so it ends when it
 * originally would have.
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

/**
 * How long an audition blip lasts. Long enough to hear the pitch, short enough
 * that dragging across several rows does not turn into a drone.
 */
const PREVIEW_MS = 220;

export type TransportStatus = 'idle' | 'playing' | 'paused';

export interface TonePlayerState {
  status: TransportStatus;
  /** Which memo is loaded, so a list of memos can show controls on the right row. */
  memoId: string | null;
}

export type TonePlayerListener = (state: TonePlayerState) => void;

/**
 * The player owns the transport state rather than the UI tracking it
 * alongside. Two copies of the same fact drift, and any ordering between them
 * leaves a button showing the wrong label. One source of truth, published
 * through the subscription.
 *
 * Position is deliberately *not* published: it changes every frame, and
 * pushing it through React state would re-render the list sixty times a
 * second. Callers poll `positionMs` from an animation frame instead.
 */
export class TonePlayer {
  #context: AudioContext | null = null;
  #master: GainNode | null = null;
  #voices: OscillatorNode[] = [];
  /**
   * Auditioned pitches, kept apart from #voices so the transport's own
   * teardown never touches them and they never appear as playback.
   */
  #previewVoice: OscillatorNode | null = null;
  #endTimer: ReturnType<typeof setTimeout> | null = null;
  #listeners = new Set<TonePlayerListener>();

  #status: TransportStatus = 'idle';
  #memoId: string | null = null;
  /**
   * Readonly, and never copied on the way in: callers hand the same array the
   * UI is rendering, so identity is meaningful and updateNotes can tell an
   * actual edit from a re-render.
   */
  #notes: readonly QuantizedNote[] = [];
  /** Position the current run started from, in ms. */
  #offsetMs = 0;
  /** context.currentTime when the current run started. */
  #startedAt = 0;
  #durationMs = 0;

  get status(): TransportStatus {
    return this.#status;
  }

  get playing(): boolean {
    return this.#status === 'playing';
  }

  /** Read directly by handlers, so a toggle never acts on a stale render. */
  get currentMemoId(): string | null {
    return this.#memoId;
  }

  get durationMs(): number {
    return this.#durationMs;
  }

  /** Current playhead position in ms. Cheap enough to call every frame. */
  get positionMs(): number {
    if (this.#status !== 'playing' || !this.#context) return this.#offsetMs;
    const elapsed = (this.#context.currentTime - this.#startedAt) * 1000;
    // Clamped: the scheduling lead means elapsed starts negative.
    return Math.min(this.#durationMs, Math.max(0, this.#offsetMs + elapsed));
  }

  subscribe(listener: TonePlayerListener): () => void {
    this.#listeners.add(listener);
    listener(this.#state());
    return () => this.#listeners.delete(listener);
  }

  #state(): TonePlayerState {
    return { status: this.#status, memoId: this.#memoId };
  }

  #emit(status: TransportStatus, memoId: string | null): void {
    this.#status = status;
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
        // Resuming can reject outside a gesture; playback will be silent,
        // which the caller cannot do anything about.
      }
    }
    return this.#context;
  }

  static durationOf(notes: readonly QuantizedNote[]): number {
    return notes.reduce(
      (end, note) => Math.max(end, note.startMs + note.durationMs),
      0,
    );
  }

  /** Starts a sequence from `fromMs`, replacing anything already playing. */
  async play(
    memoId: string,
    notes: readonly QuantizedNote[],
    fromMs = 0,
  ): Promise<void> {
    this.#silence();

    this.#memoId = memoId;
    this.#notes = notes;
    this.#durationMs = TonePlayer.durationOf(notes);

    if (notes.length === 0 || fromMs >= this.#durationMs) {
      this.#offsetMs = 0;
      this.#emit('idle', notes.length === 0 ? null : memoId);
      return;
    }

    const context = await this.#ensureContext();
    if (!context || !this.#master) return;

    this.#offsetMs = Math.max(0, fromMs);
    this.#startedAt = context.currentTime + LEAD_S;

    for (const note of notes) {
      const noteEndMs = note.startMs + note.durationMs;
      // Already finished before where we are resuming from.
      if (noteEndMs <= this.#offsetMs) continue;

      // A note straddling the resume point restarts, shortened so it still
      // ends when it was always going to.
      const startMs = Math.max(note.startMs, this.#offsetMs);
      const noteStart = this.#startedAt + (startMs - this.#offsetMs) / 1000;
      const noteEnd = Math.max(
        noteStart + (noteEndMs - startMs) / 1000,
        noteStart + ATTACK_S + RELEASE_S,
      );

      const oscillator = context.createOscillator();
      oscillator.type = WAVEFORM;
      oscillator.frequency.value = midiToHz(note.midi);

      const gain = context.createGain();
      gain.gain.setValueAtTime(0, noteStart);
      gain.gain.linearRampToValueAtTime(NOTE_GAIN, noteStart + ATTACK_S);
      gain.gain.setValueAtTime(
        NOTE_GAIN,
        Math.max(noteEnd - RELEASE_S, noteStart + ATTACK_S),
      );
      gain.gain.linearRampToValueAtTime(0, noteEnd);

      oscillator.connect(gain);
      gain.connect(this.#master);
      oscillator.start(noteStart);
      oscillator.stop(noteEnd);
      this.#voices.push(oscillator);
    }

    this.#emit('playing', memoId);

    // Driven by a timer rather than the last oscillator's `ended` event,
    // because stopping a voice fires that event too and would race with it.
    const remainingMs = this.#durationMs - this.#offsetMs;
    this.#endTimer = setTimeout(() => {
      this.#endTimer = null;
      this.#voices = [];
      this.#offsetMs = 0;
      this.#emit('idle', this.#memoId);
    }, remainingMs + LEAD_S * 1000 + 50);
  }

  /**
   * Arms a memo without sounding it, so its playhead can be scrubbed before
   * anything has been played. Loading a different memo replaces the current
   * one; re-loading the same one leaves the position alone, or dragging the
   * playhead would jump back to the start on every render.
   */
  load(memoId: string, notes: readonly QuantizedNote[]): void {
    if (this.#memoId === memoId) {
      this.#notes = notes;
      this.#durationMs = TonePlayer.durationOf(notes);
      return;
    }
    this.#silence();
    this.#notes = notes;
    this.#durationMs = TonePlayer.durationOf(notes);
    this.#offsetMs = 0;
    // 'paused' rather than 'idle': idle means the transport holds nothing, and
    // this memo is now cued at a position, ready for play to resume from it.
    this.#emit('paused', memoId);
  }

  /**
   * Moves the playhead. While playing, the sequence is rescheduled from the
   * new position; otherwise only the resume point moves.
   *
   * Rescheduling tears down and rebuilds every voice, so callers scrubbing
   * continuously should pause first and seek once on release rather than
   * calling this per frame.
   */
  seek(ms: number): void {
    if (!this.#memoId) return;
    const clamped = Math.min(this.#durationMs, Math.max(0, ms));

    if (this.#status === 'playing') {
      void this.play(this.#memoId, this.#notes, clamped);
      return;
    }

    this.#offsetMs = clamped;
    // Idle means "at the start with nothing cued", which is no longer true.
    if (this.#status === 'idle') this.#emit('paused', this.#memoId);
    else this.#emit(this.#status, this.#memoId);
  }

  /**
   * Adopts a new set of notes for the memo the transport is holding.
   *
   * Playback schedules every voice up front, so without this an edit made
   * after play() is inaudible until the next start — pause, move a note, and
   * resume, and it would sound where it used to be. The stored notes are what
   * resume() and restart() replay, so keeping them current is the whole fix.
   *
   * Ignored for any memo the transport is not on, and for an unchanged array:
   * this is called from a render effect, and rescheduling emits state, which
   * would re-run the effect and reschedule again without that guard.
   */
  updateNotes(memoId: string, notes: readonly QuantizedNote[]): void {
    if (this.#memoId !== memoId || this.#notes === notes) return;

    const at = this.positionMs;
    this.#notes = notes;
    this.#durationMs = TonePlayer.durationOf(notes);
    // Deleting the tail can leave the playhead beyond the end.
    this.#offsetMs = Math.min(this.#offsetMs, this.#durationMs);

    // Scheduled voices cannot be edited in place, so rebuild from where the
    // playhead is. Any note sounding across that instant re-articulates —
    // the cost of hearing the change without waiting for a restart.
    if (this.#status === 'playing') {
      void this.play(memoId, notes, at);
    }
  }

  /**
   * Sounds a single pitch, for auditioning a note while editing.
   *
   * Deliberately outside the transport: it emits no state, moves no playhead,
   * and its voice is not among those a play/pause/stop tears down. Clicking a
   * note to hear it must not look like starting playback.
   *
   * Monophonic — a new audition replaces the one before it, so dragging up a
   * row at a time sounds like one note changing pitch rather than a pile-up.
   */
  async previewPitch(midi: number): Promise<void> {
    const context = await this.#ensureContext();
    if (!context || !this.#master) return;

    this.#stopPreview();

    const start = context.currentTime;
    const end = start + PREVIEW_MS / 1000;

    const oscillator = context.createOscillator();
    oscillator.type = WAVEFORM;
    oscillator.frequency.value = midiToHz(midi);

    const gain = context.createGain();
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(NOTE_GAIN, start + ATTACK_S);
    gain.gain.setValueAtTime(
      NOTE_GAIN,
      Math.max(end - RELEASE_S, start + ATTACK_S),
    );
    gain.gain.linearRampToValueAtTime(0, end);

    oscillator.connect(gain);
    gain.connect(this.#master);
    oscillator.start(start);
    oscillator.stop(end);
    this.#previewVoice = oscillator;
  }

  #stopPreview(): void {
    if (!this.#previewVoice) return;
    try {
      this.#previewVoice.onended = null;
      this.#previewVoice.stop();
      this.#previewVoice.disconnect();
    } catch {
      // Already finished on its own; nothing to release.
    }
    this.#previewVoice = null;
  }

  /** Holds position so `resume` can continue from it. */
  pause(): void {
    if (this.#status !== 'playing') return;
    const position = this.positionMs;
    this.#silence();
    this.#offsetMs = position;
    this.#emit('paused', this.#memoId);
  }

  async resume(): Promise<void> {
    if (this.#status !== 'paused' || !this.#memoId) return;
    await this.play(this.#memoId, this.#notes, this.#offsetMs);
  }

  /** Plays from the beginning, whatever the current state. */
  async restart(): Promise<void> {
    if (!this.#memoId) return;
    await this.play(this.#memoId, this.#notes, 0);
  }

  /** Stops and rewinds. */
  stop(): void {
    this.#silence();
    this.#offsetMs = 0;
    if (this.#status !== 'idle') this.#emit('idle', this.#memoId);
  }

  /** Silences the graph without touching transport state. */
  #silence(): void {
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
  }

  dispose(): void {
    this.#silence();
    this.#stopPreview();
    this.#listeners.clear();
    void this.#context?.close().catch(() => {});
    this.#context = null;
    this.#master = null;
    this.#status = 'idle';
    this.#memoId = null;
  }
}
