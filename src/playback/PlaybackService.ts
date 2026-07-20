import type { MemoId } from '../core/types.ts';

/**
 * Plays memos through a single shared audio element.
 *
 * One element and one object URL for the whole app, rather than an <audio> per
 * list row: object URLs are only freed when explicitly revoked, and iOS
 * additionally struggles with many live media elements competing for the audio
 * session. Centralizing ownership also makes "starting one memo stops the
 * other" fall out for free instead of needing coordination between rows.
 */

export interface PlaybackState {
  memoId: MemoId | null;
  playing: boolean;
  currentTimeMs: number;
}

export type PlaybackListener = (state: PlaybackState) => void;

export class PlaybackService {
  #audio: HTMLAudioElement | null = null;
  #objectUrl: string | null = null;
  #memoId: MemoId | null = null;
  #listeners = new Set<PlaybackListener>();

  /**
   * Adopts the rendered <audio controls> element.
   *
   * The element is real and on the page rather than detached, so playback gets
   * the platform's native transport for free — already keyboard operable,
   * already labelled for screen readers, already familiar. Hand-built
   * transport controls are one of the most common accessibility regressions in
   * audio apps, and there is nothing here that warrants taking that on.
   */
  attach(element: HTMLAudioElement): () => void {
    this.#audio = element;
    element.preload = 'metadata';
    const emit = () => this.#emit();
    for (const event of ['play', 'pause', 'timeupdate', 'ended'] as const) {
      element.addEventListener(event, emit);
    }
    return () => {
      for (const event of ['play', 'pause', 'timeupdate', 'ended'] as const) {
        element.removeEventListener(event, emit);
      }
      if (this.#audio === element) this.#audio = null;
    };
  }

  #element(): HTMLAudioElement {
    // Only reached when nothing has been attached — i.e. under test.
    if (!this.#audio) {
      const audio = new Audio();
      audio.preload = 'metadata';
      this.attach(audio);
    }
    return this.#audio!;
  }

  subscribe(listener: PlaybackListener): () => void {
    this.#listeners.add(listener);
    listener(this.state);
    return () => this.#listeners.delete(listener);
  }

  get state(): PlaybackState {
    const audio = this.#audio;
    return {
      memoId: this.#memoId,
      playing: !!audio && !audio.paused && !audio.ended,
      currentTimeMs: audio ? audio.currentTime * 1000 : 0,
    };
  }

  #emit(): void {
    const state = this.state;
    for (const listener of this.#listeners) listener(state);
  }

  /**
   * Loads and plays a memo, replacing whatever was playing.
   *
   * The blob is rebuilt from the stored ArrayBuffer here rather than being
   * kept around, so audio bytes are only resident while actually in use.
   */
  async play(memoId: MemoId, data: ArrayBuffer, mimeType: string): Promise<void> {
    const audio = this.#element();

    if (this.#memoId !== memoId) {
      this.#releaseUrl();
      const blob = new Blob([data], { type: mimeType });
      this.#objectUrl = URL.createObjectURL(blob);
      this.#memoId = memoId;
      audio.src = this.#objectUrl;
    }

    try {
      await audio.play();
    } catch {
      // Rejects when the gesture requirement is not met or the load was
      // superseded; the paused state is already correct, so surfacing this
      // would only produce noise.
    }
    this.#emit();
  }

  pause(): void {
    this.#audio?.pause();
    this.#emit();
  }

  toggle(memoId: MemoId, data: ArrayBuffer, mimeType: string): Promise<void> {
    if (this.#memoId === memoId && this.state.playing) {
      this.pause();
      return Promise.resolve();
    }
    return this.play(memoId, data, mimeType);
  }

  /** Seeks within the current memo. */
  seekMs(ms: number): void {
    if (this.#audio) {
      this.#audio.currentTime = ms / 1000;
      this.#emit();
    }
  }

  /** Called when a memo is deleted, so its object URL does not outlive it. */
  stopIfPlaying(memoId: MemoId): void {
    if (this.#memoId === memoId) this.reset();
  }

  reset(): void {
    this.#audio?.pause();
    if (this.#audio) this.#audio.removeAttribute('src');
    this.#releaseUrl();
    this.#memoId = null;
    this.#emit();
  }

  #releaseUrl(): void {
    if (this.#objectUrl) {
      URL.revokeObjectURL(this.#objectUrl);
      this.#objectUrl = null;
    }
  }

  dispose(): void {
    this.reset();
    this.#listeners.clear();
    this.#audio = null;
  }
}
