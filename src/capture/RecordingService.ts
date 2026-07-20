import {
  appError,
  failure,
  fromDomException,
  ok,
  type AppError,
  type Result,
} from '../core/result.ts';
import { detectPlatform } from '../core/platform.ts';
import type { CaptureInfo, CapturedAudio, TerminationReason } from '../core/types.ts';
import { isRecordingSupported, negotiateMimeType } from './mimeNegotiation.ts';
import {
  watchInterruptions,
  type InterruptionReason,
} from './interruptions.ts';

/** Hard ceiling on a single take. */
export const MAX_RECORDING_MS = 120_000;

/**
 * Chunk interval. Requesting periodic chunks means an abrupt end still leaves
 * recoverable audio, instead of a single final blob that never arrives.
 */
const TIMESLICE_MS = 1000;

/** Elapsed-time tick. Fine enough for a smooth countdown, cheap enough to ignore. */
const TICK_MS = 100;

export type RecordingState = 'idle' | 'preparing' | 'recording' | 'finalizing';

export interface RecordingCallbacks {
  onStateChange?: (state: RecordingState) => void;
  onElapsed?: (elapsedMs: number) => void;
  /** Fires for every ending — user stop, time limit, and interruption alike. */
  onCaptured?: (captured: CapturedAudio) => void;
  onInterrupted?: (reason: InterruptionReason) => void;
  onError?: (error: AppError) => void;
  /** Periodic snapshot so a killed browser process is still recoverable. */
  onFlush?: (snapshot: RecordingSnapshot) => void;
}

export interface RecordingSnapshot {
  startedAt: number;
  mimeType: string;
  durationMs: number;
  chunks: Blob[];
}

/**
 * Microphone constraints.
 *
 * All three processors are requested off. They exist to make speech
 * intelligible, not to preserve a signal: noise suppression is spectral
 * subtraction and strips exactly the harmonics a pitch estimator reads (it is
 * especially destructive to whistling, which it treats as noise), and
 * automatic gain control applies time-varying gain that ruins the amplitude
 * envelopes used to find note boundaries.
 *
 * Requested as bare, non-exact constraints on purpose — `exact` would make
 * getUserMedia reject outright on a device that cannot comply, trading a
 * degraded recording for no recording.
 */
const AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
  channelCount: 1,
};

/**
 * Normalizes a reported DSP setting to a tri-state.
 *
 * `undefined` means the browser declined to report it, which is genuinely
 * different from "off" — v2 needs to tell "confirmed clean" from "unknown".
 * A string value (e.g. "remote-only") counts as the processor being active.
 */
function normalizeDspSetting(value: boolean | string | undefined): boolean | null {
  if (value === undefined) return null;
  if (typeof value === 'string') return value !== 'none';
  return value;
}

export class RecordingService {
  #state: RecordingState = 'idle';
  #callbacks: RecordingCallbacks;

  #stream: MediaStream | null = null;
  #recorder: MediaRecorder | null = null;
  #chunks: Blob[] = [];
  #stopWatching: (() => void) | null = null;

  #startedAtWallClock = 0;
  #startedAtMonotonic = 0;
  #elapsedMs = 0;
  #tickTimer: ReturnType<typeof setInterval> | null = null;

  #terminationReason: TerminationReason = 'user';
  /**
   * Captured immediately after acquisition: a stopped track reports empty
   * settings, so reading them at finalize time would be too late.
   */
  #settings: MediaTrackSettings | null = null;
  #deviceLabel: string | null = null;
  #requestedMimeType = '';

  constructor(callbacks: RecordingCallbacks = {}) {
    this.#callbacks = callbacks;
  }

  get state(): RecordingState {
    return this.#state;
  }

  get elapsedMs(): number {
    return this.#elapsedMs;
  }

  #setState(state: RecordingState): void {
    this.#state = state;
    this.#callbacks.onStateChange?.(state);
  }

  /**
   * Acquires the microphone and begins recording.
   *
   * The stream is acquired per-recording and released on stop, never held
   * open. iOS invalidates capture tracks when the app is backgrounded while
   * leaving the track object looking healthy, so a long-lived stream is the
   * most common cause of a recording that silently contains nothing.
   */
  async start(): Promise<Result<void>> {
    if (this.#state !== 'idle') {
      return failure('unknown', `Cannot start while ${this.#state}.`);
    }
    if (!isRecordingSupported()) {
      return failure(
        'recording-unsupported',
        'This browser cannot record audio.',
      );
    }

    this.#setState('preparing');

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: AUDIO_CONSTRAINTS,
      });
    } catch (e) {
      this.#setState('idle');
      return { ok: false, error: fromDomException(e, 'Could not open the microphone.') };
    }

    const track = stream.getAudioTracks()[0];
    if (!track || track.readyState !== 'live') {
      stream.getTracks().forEach((t) => t.stop());
      this.#setState('idle');
      return failure('no-mic', 'The microphone track was not available.');
    }

    // Record what the browser actually applied rather than what we asked for.
    // Chrome has applied AGC despite the constraint, and WebKit has ignored
    // echoCancellation, so the request alone proves nothing about the audio.
    this.#settings = track.getSettings();
    this.#deviceLabel = track.label || null;

    const mimeType = negotiateMimeType();
    this.#requestedMimeType = mimeType;

    let recorder: MediaRecorder;
    try {
      // audioBitsPerSecond is deliberately unset: high values from Chrome
      // produce files other engines refuse to decode.
      recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);
    } catch (e) {
      stream.getTracks().forEach((t) => t.stop());
      this.#setState('idle');
      return {
        ok: false,
        error: appError(
          'unsupported-format',
          'No supported recording format was available.',
          e,
        ),
      };
    }

    this.#stream = stream;
    this.#recorder = recorder;
    this.#chunks = [];
    this.#terminationReason = 'user';

    recorder.addEventListener('dataavailable', (event) => {
      if (event.data && event.data.size > 0) {
        this.#chunks.push(event.data);
        // Snapshot on each chunk so an unrecoverable kill still leaves audio.
        this.#callbacks.onFlush?.({
          startedAt: this.#startedAtWallClock,
          mimeType: this.#effectiveMimeType(),
          durationMs: performance.now() - this.#startedAtMonotonic,
          chunks: [...this.#chunks],
        });
      }
    });

    recorder.addEventListener('stop', () => {
      void this.#finalize();
    });

    this.#stopWatching = watchInterruptions({
      stream,
      recorder,
      onInterrupt: (reason) => {
        this.#callbacks.onInterrupted?.(reason);
        this.stop('interruption');
      },
    });

    try {
      recorder.start(TIMESLICE_MS);
    } catch (e) {
      this.#teardown();
      this.#setState('idle');
      return {
        ok: false,
        error: appError('unknown', 'Recording failed to start.', e),
      };
    }

    this.#startedAtWallClock = Date.now();
    this.#startedAtMonotonic = performance.now();
    this.#elapsedMs = 0;
    this.#setState('recording');
    this.#startTicker();

    return ok(undefined);
  }

  /**
   * Ends the recording. The captured audio arrives via `onCaptured`, not as a
   * return value, so that a stop triggered by an interruption delivers its
   * result through exactly the same path as one the user asked for.
   */
  stop(reason: TerminationReason = 'user'): void {
    if (this.#state !== 'recording') return;

    this.#terminationReason = reason;
    this.#elapsedMs = performance.now() - this.#startedAtMonotonic;
    this.#stopTicker();
    this.#setState('finalizing');

    try {
      this.#recorder?.stop();
    } catch (e) {
      this.#callbacks.onError?.(
        appError('unknown', 'Recording failed to stop cleanly.', e),
      );
      void this.#finalize();
    }
  }

  /** Releases the microphone without producing a memo. */
  cancel(): void {
    if (this.#state === 'idle') return;
    this.#chunks = [];
    this.#teardown();
    this.#setState('idle');
  }

  dispose(): void {
    this.cancel();
  }

  #startTicker(): void {
    this.#stopTicker();
    this.#tickTimer = setInterval(() => {
      this.#elapsedMs = performance.now() - this.#startedAtMonotonic;
      this.#callbacks.onElapsed?.(this.#elapsedMs);
      if (this.#elapsedMs >= MAX_RECORDING_MS) {
        this.stop('limit');
      }
    }, TICK_MS);
  }

  #stopTicker(): void {
    if (this.#tickTimer !== null) {
      clearInterval(this.#tickTimer);
      this.#tickTimer = null;
    }
  }

  /**
   * The container MediaRecorder actually produced. The requested type is only
   * ever a request, and BlobEvent chunks frequently carry an empty type, so
   * this is the one trustworthy source.
   */
  #effectiveMimeType(): string {
    return this.#recorder?.mimeType || this.#requestedMimeType || 'audio/webm';
  }

  /**
   * Assembles the recording. Runs from the recorder's `stop` event, which
   * fires only after the final `dataavailable` — assembling any earlier
   * truncates the tail.
   */
  async #finalize(): Promise<void> {
    if (this.#state !== 'finalizing') return;

    const mimeType = this.#effectiveMimeType();
    const chunks = this.#chunks;
    this.#chunks = [];

    const settings = this.#settings;
    const deviceLabel = this.#deviceLabel;
    const durationMs = this.#elapsedMs;
    const terminatedBy = this.#terminationReason;
    const capturedAt = this.#startedAtWallClock;

    // Release the microphone before anything else: iOS keeps audio output
    // routed to the speaker while a capture stream is live, which makes
    // playing the memo back immediately afterwards loud and echoey.
    this.#teardown();
    this.#setState('idle');

    if (chunks.length === 0) {
      this.#callbacks.onError?.(
        appError('interrupted', 'The recording was empty.'),
      );
      return;
    }

    try {
      // The type must be set explicitly here; chunk blobs often report ''.
      const blob = new Blob(chunks, { type: mimeType });
      const data = await blob.arrayBuffer();

      const capture: CaptureInfo = {
        mimeType,
        requestedMimeType: this.#requestedMimeType,
        durationMs,
        byteLength: data.byteLength,
        sampleRate: settings?.sampleRate ?? null,
        channelCount: settings?.channelCount ?? 1,
        dsp: {
          // echoCancellation may be reported as a string ("all",
          // "remote-only") rather than a boolean under newer specs, so all
          // three are normalized rather than trusted to be booleans.
          echoCancellation: normalizeDspSetting(settings?.echoCancellation),
          noiseSuppression: normalizeDspSetting(settings?.noiseSuppression),
          autoGainControl: normalizeDspSetting(settings?.autoGainControl),
        },
        deviceLabel,
        capturedAt,
        platform: detectPlatform(),
        terminatedBy,
      };

      this.#callbacks.onCaptured?.({ data, capture });
    } catch (e) {
      this.#callbacks.onError?.(
        appError('unknown', 'Could not assemble the recording.', e),
      );
    }
  }

  #teardown(): void {
    this.#stopTicker();
    this.#stopWatching?.();
    this.#stopWatching = null;

    // Stopping every track is what turns the OS recording indicator off.
    this.#stream?.getTracks().forEach((track) => track.stop());
    this.#stream = null;
    this.#recorder = null;
    this.#settings = null;
    this.#deviceLabel = null;
  }
}

/**
 * Asks for microphone permission ahead of time, then immediately releases it.
 *
 * Without this the grant prompt appears after the user hits Record, eating the
 * first seconds of whatever they were about to sing.
 */
export async function prewarmMicrophonePermission(): Promise<boolean> {
  if (!isRecordingSupported()) return false;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: AUDIO_CONSTRAINTS,
    });
    stream.getTracks().forEach((track) => track.stop());
    return true;
  } catch {
    return false;
  }
}
