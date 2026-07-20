import { uuidv7 } from '../core/ids.ts';
import { failure, ok, type Result } from '../core/result.ts';
import type { AnalysisRecord, AnalysisState, Memo } from '../core/types.ts';
import type { MemoRepository } from '../storage/memoRepository.ts';
import type { AnalysisClient } from './analysisClient.ts';
import { decodeToAnalysisPcm } from './decode.ts';
import { CURRENT_ENGINE } from './registry.ts';

/**
 * Runs a memo through the whole transcription pipeline and records the result.
 *
 * Sequenced deliberately: the memo's status is written before the work starts,
 * so a transcription interrupted by a closed tab reads as `failed` on next
 * launch rather than sitting on `running` forever.
 */

function stateFor(status: AnalysisState['status']): AnalysisState {
  return {
    currentAnalysisId: null,
    algorithmId: CURRENT_ENGINE.algorithmId,
    algorithmVersion: CURRENT_ENGINE.version,
    status,
    updatedAt: Date.now(),
  };
}

export async function transcribeMemo(
  repository: MemoRepository,
  client: AnalysisClient,
  memo: Memo,
): Promise<Result<AnalysisRecord>> {
  await repository.setAnalysisState(memo.id, stateFor('running'));

  const audio = await repository.getAudio(memo.id);
  if (!audio.ok) {
    await repository.setAnalysisState(memo.id, stateFor('failed'));
    return audio;
  }

  // Decoding is main-thread only — AudioContext does not exist in workers.
  const decoded = await decodeToAnalysisPcm(audio.value.data);
  if (!decoded.ok) {
    await repository.setAnalysisState(
      memo.id,
      // A container this browser cannot decode is not a failure that retrying
      // will fix, so it is marked distinctly.
      stateFor('unsupported'),
    );
    return decoded;
  }

  const analysed = await client.analyze({
    samples: decoded.value.samples,
    sampleRate: decoded.value.sampleRate,
  });
  if (!analysed.ok) {
    await repository.setAnalysisState(memo.id, stateFor('failed'));
    return analysed;
  }

  const record: AnalysisRecord = {
    id: uuidv7(),
    memoId: memo.id,
    // Binds the result to the exact bytes it came from.
    audioHash: memo.audioHash,
    algorithmId: CURRENT_ENGINE.algorithmId,
    algorithmVersion: CURRENT_ENGINE.version,
    createdAt: Date.now(),
    status: 'ok',
    ...analysed.value,
  };

  const saved = await repository.saveAnalysis(record);
  if (!saved.ok) {
    await repository.setAnalysisState(memo.id, stateFor('failed'));
    return saved;
  }

  return ok(record);
}

/**
 * Marks a memo for re-transcription and runs it.
 *
 * Separate from the automatic path because recomputation is the user's call:
 * an improved engine may produce a better result, but it costs battery and, in
 * v3, would be the point at which a hand-edited score could be overwritten.
 */
export async function retranscribeMemo(
  repository: MemoRepository,
  client: AnalysisClient,
  memoId: string,
): Promise<Result<AnalysisRecord>> {
  const memo = await repository.getMemo(memoId);
  if (!memo.ok) return failure('not-found', `No memo with id ${memoId}.`);
  return transcribeMemo(repository, client, memo.value);
}
