import type { AnalysisRecord } from '../core/types.ts';

/**
 * The seam that lets the transcription algorithm be replaced.
 *
 * Pitch detection is the part of this app most likely to be rewritten — better
 * methods exist, and the current one will be found wanting on real voices. An
 * engine is therefore a pure function from samples to a result, identified by
 * id and version, so that swapping or improving it is a matter of registering
 * a new implementation. Everything downstream keys off those two fields to
 * decide what is stale.
 */

export interface PcmInput {
  /** Mono samples at `sampleRate`. Transferred into the worker, not copied. */
  samples: Float32Array;
  sampleRate: number;
}

/**
 * What an engine produces. The fields it cannot know — its own id, which memo
 * this was, the hash of the source audio — are filled in by the caller.
 */
export type AnalysisPayload = Omit<
  AnalysisRecord,
  'id' | 'memoId' | 'audioHash' | 'status' | 'createdAt' | 'algorithmId' | 'algorithmVersion'
>;

export interface AnalysisEngine {
  readonly algorithmId: string;
  /**
   * Bumping this marks every existing analysis stale and eligible for
   * recomputation. It must change whenever output would differ for the same
   * input — including parameter changes, not just code changes.
   */
  readonly version: string;
  readonly defaultParams: Readonly<Record<string, unknown>>;
  analyze(input: PcmInput, params?: Record<string, unknown>): AnalysisPayload;
}
