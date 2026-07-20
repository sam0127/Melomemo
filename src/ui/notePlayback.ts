import type { Memo, MemoId, QuantizedNote } from '../core/types.ts';
import type { TransportStatus } from '../playback/TonePlayer.ts';

/**
 * Transport for note playback, passed down as one object.
 *
 * Bundled rather than spread across separate props because the list already
 * threads several callbacks through two layers, and this set will keep growing
 * as note editing arrives — seek, select, drag. One named interface keeps that
 * growth in a single place instead of widening every component signature.
 */
export interface NotePlaybackControls {
  /** Transport state for a given memo; 'idle' for any memo not loaded. */
  statusFor: (memoId: MemoId) => TransportStatus;
  /** Starts, or pauses if this memo is already playing. */
  toggle: (memo: Memo, notes: readonly QuantizedNote[]) => void;
  /** Plays from the beginning regardless of current state. */
  restart: (memo: Memo, notes: readonly QuantizedNote[]) => void;
  /**
   * Current playhead position in ms. A function, not a value: it changes every
   * frame and is polled from an animation frame rather than pushed through
   * React state.
   */
  positionMs: () => number;
}
