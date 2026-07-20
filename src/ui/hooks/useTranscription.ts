import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnalysisClient } from '../../analysis/analysisClient.ts';
import { transcribeMemo } from '../../analysis/transcriber.ts';
import type { Memo, MemoId } from '../../core/types.ts';
import type { MemoRepository } from '../../storage/memoRepository.ts';

/**
 * Drives transcription in the background after a memo is saved.
 *
 * Deliberately fire-and-forget from the UI's point of view: the memo is saved
 * and listed the instant recording stops, and the transcription appears when
 * it appears. Making the user wait on analysis to see their recording would
 * put the slowest, least reliable stage in front of the one that matters.
 */
export function useTranscription(
  repository: MemoRepository,
  onUpdated: () => void | Promise<void>,
) {
  const client = useMemo(() => new AnalysisClient(), []);
  const [running, setRunning] = useState<ReadonlySet<MemoId>>(new Set());

  const onUpdatedRef = useRef(onUpdated);
  onUpdatedRef.current = onUpdated;

  useEffect(() => () => client.dispose(), [client]);

  const run = useCallback(
    async (memo: Memo) => {
      setRunning((current) => new Set(current).add(memo.id));
      try {
        await transcribeMemo(repository, client, memo);
      } finally {
        setRunning((current) => {
          const next = new Set(current);
          next.delete(memo.id);
          return next;
        });
        // Refresh regardless of outcome: a failure is recorded on the memo and
        // the list needs to show it.
        await onUpdatedRef.current();
      }
    },
    [repository, client],
  );

  return {
    /** Memos currently being transcribed, for per-row progress. */
    running,
    transcribe: run,
    isRunning: (id: MemoId) => running.has(id),
  };
}
