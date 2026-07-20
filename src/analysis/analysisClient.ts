import { appError, failure, ok, type Result } from '../core/result.ts';
import { uuidv7 } from '../core/ids.ts';
import type { AnalysisPayload, PcmInput } from './AnalysisEngine.ts';
import type { AnalysisRequest, AnalysisResponse } from './analysis.worker.ts';
import { CURRENT_ENGINE, getEngine } from './registry.ts';

/**
 * Owns the analysis worker and turns its message protocol into promises.
 *
 * The worker is created lazily on first use and then kept: spinning one up
 * costs more than a short analysis, and recording several memos in a row is
 * the normal case.
 */

const WORKER_TIMEOUT_MS = 60_000;

interface Pending {
  resolve: (result: Result<AnalysisPayload>) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class AnalysisClient {
  #worker: Worker | null = null;
  #pending = new Map<string, Pending>();
  /** Set when worker construction fails, so we degrade instead of retrying forever. */
  #workerUnavailable = false;

  #ensureWorker(): Worker | null {
    if (this.#worker) return this.#worker;
    if (this.#workerUnavailable) return null;

    try {
      const worker = new Worker(new URL('./analysis.worker.ts', import.meta.url), {
        type: 'module',
      });

      worker.addEventListener('message', (event: MessageEvent<AnalysisResponse>) => {
        const response = event.data;
        const pending = this.#pending.get(response.requestId);
        if (!pending) return;
        this.#pending.delete(response.requestId);
        clearTimeout(pending.timer);
        pending.resolve(
          response.ok
            ? ok(response.payload)
            : failure('unknown', response.message),
        );
      });

      worker.addEventListener('error', (event) => {
        // A worker-level error has no request id, so every outstanding request
        // has to be failed rather than left hanging.
        this.#failAll(`Analysis worker error: ${event.message}`);
      });

      this.#worker = worker;
      return worker;
    } catch (error) {
      this.#workerUnavailable = true;
      console.warn('[melomemo] Analysis worker unavailable', error);
      return null;
    }
  }

  #failAll(message: string): void {
    for (const [, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.resolve(failure('unknown', message));
    }
    this.#pending.clear();
  }

  /**
   * Analyses samples, preferring the worker and falling back to the main
   * thread.
   *
   * The fallback matters: a blocked worker (strict CSP, an unusual embedding)
   * should degrade to a janky transcription rather than no transcription.
   */
  async analyze(
    input: PcmInput,
    algorithmId: string = CURRENT_ENGINE.algorithmId,
  ): Promise<Result<AnalysisPayload>> {
    const worker = this.#ensureWorker();

    if (!worker) {
      const engine = getEngine(algorithmId);
      if (!engine) return failure('unknown', `Unknown engine: ${algorithmId}`);
      try {
        return ok(engine.analyze(input));
      } catch (error) {
        return {
          ok: false,
          error: appError('unknown', 'Analysis failed.', error),
        };
      }
    }

    const requestId = uuidv7();
    return new Promise<Result<AnalysisPayload>>((resolve) => {
      const timer = setTimeout(() => {
        this.#pending.delete(requestId);
        resolve(failure('unknown', 'Analysis timed out.'));
      }, WORKER_TIMEOUT_MS);

      this.#pending.set(requestId, { resolve, timer });

      const request: AnalysisRequest = {
        requestId,
        algorithmId,
        samples: input.samples.buffer as ArrayBuffer,
        sampleRate: input.sampleRate,
      };
      // Transferred, so `input.samples` is detached after this call and must
      // not be reused by the caller.
      worker.postMessage(request, [request.samples]);
    });
  }

  dispose(): void {
    this.#failAll('Analysis cancelled.');
    this.#worker?.terminate();
    this.#worker = null;
  }
}
