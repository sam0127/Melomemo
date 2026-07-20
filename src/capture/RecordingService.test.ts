import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_RECORDING_MS, RecordingService } from './RecordingService.ts';
import type { CapturedAudio } from '../core/types.ts';

/**
 * jsdom implements neither MediaRecorder nor getUserMedia, so both are faked.
 * The fakes reproduce the behaviours that actually cause bugs in the field —
 * chunk blobs with an empty type, a mimeType that differs from the one
 * requested, and a stop event that arrives after the final chunk.
 */

class FakeTrack extends EventTarget {
  readyState: MediaStreamTrackState = 'live';
  label = 'Fake mic';
  stopped = false;
  #settings: MediaTrackSettings;

  constructor(settings: MediaTrackSettings) {
    super();
    this.#settings = settings;
  }

  getSettings(): MediaTrackSettings {
    // A stopped track reports nothing, which is why the service reads settings
    // at acquisition rather than at finalize.
    return this.stopped ? {} : this.#settings;
  }

  stop() {
    this.stopped = true;
    this.readyState = 'ended';
  }
}

class FakeStream {
  #tracks: FakeTrack[];
  constructor(tracks: FakeTrack[]) {
    this.#tracks = tracks;
  }
  getAudioTracks() {
    return this.#tracks;
  }
  getTracks() {
    return this.#tracks;
  }
}

class FakeMediaRecorder extends EventTarget {
  static supported = ['audio/webm;codecs=opus', 'audio/webm'];
  static instances: FakeMediaRecorder[] = [];
  static isTypeSupported(type: string) {
    return FakeMediaRecorder.supported.includes(type);
  }

  /** Intentionally not the requested string — the service must read this back. */
  mimeType = 'audio/webm;codecs=opus';
  state: RecordingState_ = 'inactive';
  requested: string | undefined;

  constructor(_stream: unknown, options?: { mimeType?: string }) {
    super();
    this.requested = options?.mimeType;
    FakeMediaRecorder.instances.push(this);
  }

  start(_timeslice?: number) {
    this.state = 'recording';
  }

  stop() {
    this.state = 'inactive';
    // Chunk blobs commonly carry an empty type; the final blob's type has to
    // come from mimeType instead. The stop event must follow the last chunk.
    this.dispatchEvent(
      Object.assign(new Event('dataavailable'), {
        data: new Blob([new Uint8Array([1, 2, 3, 4])], { type: '' }),
      }),
    );
    this.dispatchEvent(new Event('stop'));
  }

  emitChunk(bytes = 4) {
    this.dispatchEvent(
      Object.assign(new Event('dataavailable'), {
        data: new Blob([new Uint8Array(bytes)], { type: '' }),
      }),
    );
  }
}

type RecordingState_ = 'inactive' | 'recording' | 'paused';

const DEFAULT_SETTINGS: MediaTrackSettings = {
  sampleRate: 48000,
  channelCount: 1,
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
};

let currentTrack: FakeTrack;
let lastConstraints: MediaStreamConstraints | undefined;

function installMocks(settings: MediaTrackSettings = DEFAULT_SETTINGS) {
  currentTrack = new FakeTrack(settings);
  lastConstraints = undefined;
  vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
  vi.stubGlobal('navigator', {
    ...navigator,
    userAgent: 'test',
    mediaDevices: {
      getUserMedia: vi.fn(async (constraints?: MediaStreamConstraints) => {
        lastConstraints = constraints;
        return new FakeStream([currentTrack]) as unknown as MediaStream;
      }),
    },
  });
}

/** Waits for the finalize microtask chain (blob -> arrayBuffer) to settle. */
async function flush() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('RecordingService', () => {
  beforeEach(() => {
    FakeMediaRecorder.instances = [];
    installMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('requests the microphone with audio processing disabled', async () => {
    const service = new RecordingService();
    await service.start();

    // These are not cosmetic: noise suppression and AGC destroy the harmonic
    // and envelope information that later pitch analysis depends on.
    const audio = lastConstraints?.audio as MediaTrackConstraints;
    expect(audio.echoCancellation).toBe(false);
    expect(audio.noiseSuppression).toBe(false);
    expect(audio.autoGainControl).toBe(false);

    // Bare constraints, never `exact` — exact would fail acquisition outright
    // on a device that cannot comply.
    expect(audio.echoCancellation).not.toHaveProperty('exact');
  });

  it('persists the container the recorder produced, not the one requested', async () => {
    let captured: CapturedAudio | null = null;
    const service = new RecordingService({ onCaptured: (c) => (captured = c) });

    await service.start();
    service.stop('user');
    await flush();

    expect(captured).not.toBeNull();
    expect(captured!.capture.mimeType).toBe('audio/webm;codecs=opus');
  });

  it('measures duration from the clock rather than the media element', async () => {
    // MediaRecorder writes no duration into the container, so a media element
    // reports Infinity for these files. Wall-clock timing is the only source.
    vi.useFakeTimers({ toFake: ['performance', 'setInterval', 'clearInterval', 'Date'] });

    let captured: CapturedAudio | null = null;
    const service = new RecordingService({ onCaptured: (c) => (captured = c) });
    await service.start();

    vi.advanceTimersByTime(5_000);
    service.stop('user');

    vi.useRealTimers();
    await flush();

    expect(captured!.capture.durationMs).toBeGreaterThanOrEqual(5_000);
    expect(Number.isFinite(captured!.capture.durationMs)).toBe(true);
  });

  it('records the DSP settings the browser actually applied', async () => {
    vi.unstubAllGlobals();
    // The browser ignoring our request is the case worth capturing: Chrome has
    // applied AGC regardless, and WebKit has ignored echoCancellation.
    installMocks({
      ...DEFAULT_SETTINGS,
      autoGainControl: true,
      noiseSuppression: true,
    });

    let captured: CapturedAudio | null = null;
    const service = new RecordingService({ onCaptured: (c) => (captured = c) });
    await service.start();
    service.stop('user');
    await flush();

    expect(captured!.capture.dsp.autoGainControl).toBe(true);
    expect(captured!.capture.dsp.noiseSuppression).toBe(true);
    expect(captured!.capture.dsp.echoCancellation).toBe(false);
  });

  it('releases the microphone once the recording is finalized', async () => {
    const service = new RecordingService();
    await service.start();
    expect(currentTrack.stopped).toBe(false);

    service.stop('user');
    await flush();

    // Leaving the track live keeps the OS recording indicator lit and, on iOS,
    // forces audio output to the speaker.
    expect(currentTrack.stopped).toBe(true);
  });

  it('saves what was captured when the page is backgrounded', async () => {
    let captured: CapturedAudio | null = null;
    const service = new RecordingService({ onCaptured: (c) => (captured = c) });
    await service.start();
    FakeMediaRecorder.instances.at(-1)!.emitChunk(8);

    // Losing an already-performed take to a phone call or app switch is the
    // worst failure this app has; an interruption must still produce a memo.
    document.dispatchEvent(new Event('visibilitychange'));
    Object.defineProperty(document, 'visibilityState', {
      value: 'hidden',
      configurable: true,
    });
    document.dispatchEvent(new Event('visibilitychange'));
    await flush();

    expect(captured).not.toBeNull();
    expect(captured!.capture.terminatedBy).toBe('interruption');
    expect(captured!.data.byteLength).toBeGreaterThan(0);

    Object.defineProperty(document, 'visibilityState', {
      value: 'visible',
      configurable: true,
    });
  });

  it('reports a denied permission as such instead of throwing', async () => {
    vi.unstubAllGlobals();
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
    vi.stubGlobal('navigator', {
      ...navigator,
      mediaDevices: {
        getUserMedia: vi.fn(async () => {
          throw new DOMException('Denied', 'NotAllowedError');
        }),
      },
    });

    const service = new RecordingService();
    const result = await service.start();

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('permission-denied');
    expect(service.state).toBe('idle');
  });

  it('stops itself at the recording limit', async () => {
    vi.useFakeTimers({ toFake: ['performance', 'setInterval', 'clearInterval', 'Date'] });

    let captured: CapturedAudio | null = null;
    const service = new RecordingService({ onCaptured: (c) => (captured = c) });
    await service.start();

    vi.advanceTimersByTime(MAX_RECORDING_MS + 500);
    vi.useRealTimers();
    await flush();

    expect(captured).not.toBeNull();
    expect(captured!.capture.terminatedBy).toBe('limit');
  });
});
