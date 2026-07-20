/// <reference lib="webworker" />
import type { AnalysisPayload } from './AnalysisEngine.ts';
import { getEngine } from './registry.ts';

/**
 * Runs the pitch analysis off the main thread.
 *
 * Only the CPU-heavy stage lives here. Decoding stays on the main thread
 * because AudioContext is not available in workers — see decode.ts. Samples
 * arrive transferred rather than copied, so the handoff costs nothing
 * regardless of recording length.
 */

export interface AnalysisRequest {
  requestId: string;
  algorithmId: string;
  samples: ArrayBuffer;
  sampleRate: number;
  params?: Record<string, unknown>;
}

export type AnalysisResponse =
  | { requestId: string; ok: true; payload: AnalysisPayload }
  | { requestId: string; ok: false; message: string };

self.addEventListener('message', (event: MessageEvent<AnalysisRequest>) => {
  const { requestId, algorithmId, samples, sampleRate, params } = event.data;

  try {
    const engine = getEngine(algorithmId);
    if (!engine) {
      throw new Error(`Unknown analysis engine: ${algorithmId}`);
    }

    const payload = engine.analyze(
      { samples: new Float32Array(samples), sampleRate },
      params,
    );

    // The dense f0 buffers are the bulk of the response; transferring rather
    // than structured-cloning them keeps the handoff cheap.
    const transfer: Transferable[] = [
      payload.f0.hz,
      payload.f0.confidence,
      payload.f0.rms,
    ];
    (self as unknown as Worker).postMessage(
      { requestId, ok: true, payload } satisfies AnalysisResponse,
      transfer,
    );
  } catch (error) {
    (self as unknown as Worker).postMessage({
      requestId,
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    } satisfies AnalysisResponse);
  }
});
