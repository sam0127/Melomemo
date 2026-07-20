import { appError, failure, ok, type Result } from '../core/result.ts';
import { ANALYSIS_RATE } from './constants.ts';

/**
 * Decodes stored audio into mono PCM at the analysis rate.
 *
 * **This must run on the main thread.** Neither AudioContext nor
 * OfflineAudioContext is exposed in a Web Worker, and there is no worker-side
 * decodeAudioData. The spec-blessed alternative, WebCodecs `AudioDecoder`,
 * only reached Safari in 26.0 and would additionally require demuxing MP4 and
 * WebM by hand. So the split is: decode here, then transfer the resulting
 * samples to a worker for the expensive pitch work.
 *
 * Decoding is fast — tens of milliseconds for a memo — so the main thread is
 * not meaningfully blocked.
 */

export interface DecodedAudio {
  /** Mono, at ANALYSIS_RATE. */
  samples: Float32Array;
  sampleRate: number;
  durationMs: number;
}

type AudioContextConstructor = typeof OfflineAudioContext;

function offlineContextCtor(): AudioContextConstructor | null {
  if (typeof OfflineAudioContext !== 'undefined') return OfflineAudioContext;
  const legacy = (globalThis as { webkitOfflineAudioContext?: AudioContextConstructor })
    .webkitOfflineAudioContext;
  return legacy ?? null;
}

/**
 * decodeAudioData is promise-returning in modern engines but callback-only in
 * older WebKit, and the callback form ignores the return value entirely.
 */
function decodeAudioData(
  context: OfflineAudioContext,
  data: ArrayBuffer,
): Promise<AudioBuffer> {
  return new Promise((resolve, reject) => {
    const maybePromise = context.decodeAudioData(data, resolve, reject);
    if (maybePromise && typeof maybePromise.then === 'function') {
      maybePromise.then(resolve, reject);
    }
  });
}

/** Averages channels rather than taking the first, so nothing is lost if a device records stereo. */
function downmix(buffer: AudioBuffer): Float32Array {
  const channels = buffer.numberOfChannels;
  if (channels === 1) return buffer.getChannelData(0).slice();

  const out = new Float32Array(buffer.length);
  for (let channel = 0; channel < channels; channel++) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < data.length; i++) out[i]! += data[i]!;
  }
  for (let i = 0; i < out.length; i++) out[i]! /= channels;
  return out;
}

/**
 * Linear resampling, used only when the engine refuses to build a context at
 * the analysis rate.
 *
 * Linear interpolation is a poor anti-aliasing filter in general, but this
 * path only ever downsamples speech-band audio to 22.05 kHz, where the
 * artefacts land well above the fundamentals being measured.
 */
function resampleLinear(
  input: Float32Array,
  fromRate: number,
  toRate: number,
): Float32Array {
  if (fromRate === toRate) return input;
  const ratio = fromRate / toRate;
  const outLength = Math.floor(input.length / ratio);
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const position = i * ratio;
    const index = Math.floor(position);
    const fraction = position - index;
    const a = input[index] ?? 0;
    const b = input[index + 1] ?? a;
    out[i] = a + (b - a) * fraction;
  }
  return out;
}

export async function decodeToAnalysisPcm(
  data: ArrayBuffer,
): Promise<Result<DecodedAudio>> {
  const Ctor = offlineContextCtor();
  if (!Ctor) {
    return failure(
      'unsupported-format',
      'This browser cannot decode audio for analysis.',
    );
  }

  // decodeAudioData detaches the buffer it is given. The caller's copy is the
  // stored recording, so it must not be consumed here.
  const copy = data.slice(0);

  // Preferred path: decode straight to the analysis rate, since decodeAudioData
  // resamples to the context's rate for free.
  try {
    const context = new Ctor(1, 1, ANALYSIS_RATE);
    const buffer = await decodeAudioData(context, copy);
    const samples = downmix(buffer);
    return ok({
      samples,
      sampleRate: buffer.sampleRate,
      durationMs: (samples.length / buffer.sampleRate) * 1000,
    });
  } catch (preferredError) {
    // Some WebKit versions reject a context whose rate is not the hardware's.
    // Decode at whatever the engine will accept, then resample.
    try {
      const fallbackRate = 44100;
      const context = new Ctor(1, 1, fallbackRate);
      const buffer = await decodeAudioData(context, data.slice(0));
      const mono = downmix(buffer);
      const samples = resampleLinear(mono, buffer.sampleRate, ANALYSIS_RATE);
      return ok({
        samples,
        sampleRate: ANALYSIS_RATE,
        durationMs: (samples.length / ANALYSIS_RATE) * 1000,
      });
    } catch (fallbackError) {
      return {
        ok: false,
        error: appError(
          'unsupported-format',
          'The recording could not be decoded for analysis.',
          { preferredError, fallbackError },
        ),
      };
    }
  }
}
