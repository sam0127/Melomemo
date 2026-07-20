import { useCallback, useEffect, useState } from 'react';
import { createMemoFromCapture } from '../../core/memoFactory.ts';
import type { AppError } from '../../core/result.ts';
import type { CapturedAudio, Memo, MemoId } from '../../core/types.ts';
import type { MemoRepository } from '../../storage/memoRepository.ts';
import { requestPersistence } from '../../storage/persistence.ts';
import { recoverOrphanedRecording } from '../../storage/recovery.ts';

export interface UseMemosResult {
  memos: Memo[];
  loading: boolean;
  error: AppError | null;
  saveCaptured: (captured: CapturedAudio) => Promise<Memo | null>;
  rename: (id: MemoId, title: string) => Promise<void>;
  remove: (id: MemoId) => Promise<void>;
  reload: () => Promise<void>;
  clearError: () => void;
}

export function useMemos(repository: MemoRepository): UseMemosResult {
  const [memos, setMemos] = useState<Memo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<AppError | null>(null);

  const reload = useCallback(async () => {
    const result = await repository.listMemos();
    if (result.ok) setMemos(result.value);
    else setError(result.error);
  }, [repository]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      // Anything left in scratch means a previous session died mid-recording.
      // Rescue it before the list renders so it simply appears, already saved.
      await recoverOrphanedRecording(repository);
      if (cancelled) return;
      await reload();
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [repository, reload]);

  const saveCaptured = useCallback(
    async (captured: CapturedAudio): Promise<Memo | null> => {
      const { memo, audio } = await createMemoFromCapture(captured);
      const result = await repository.saveMemo(memo, audio);
      if (!result.ok) {
        setError(result.error);
        return null;
      }
      await repository.clearScratch();
      setMemos((current) => [memo, ...current]);

      // Asked for only once there is something worth protecting: browsers
      // grant persistent storage heuristically, and prompting before the user
      // has recorded anything is both likelier to be refused and worse UX.
      void requestPersistence();
      return memo;
    },
    [repository],
  );

  const rename = useCallback(
    async (id: MemoId, title: string) => {
      const result = await repository.updateMemo(id, { title });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      const updated = result.value;
      setMemos((current) =>
        current.map((memo) => (memo.id === id ? updated : memo)),
      );
    },
    [repository],
  );

  const remove = useCallback(
    async (id: MemoId) => {
      const result = await repository.deleteMemo(id);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setMemos((current) => current.filter((memo) => memo.id !== id));
    },
    [repository],
  );

  const clearError = useCallback(() => setError(null), []);

  return { memos, loading, error, saveCaptured, rename, remove, reload, clearError };
}
