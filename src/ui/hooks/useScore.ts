import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AnalysisRecord,
  Memo,
  ScoreDocument,
  ScoreNote,
} from '../../core/types.ts';
import type { MemoRepository } from '../../storage/memoRepository.ts';
import {
  addNote,
  moveNote,
  removeNote,
  seedScoreFromAnalysis,
} from '../../score/scoreEdits.ts';

/**
 * The user's editable score for one memo.
 *
 * No score row exists until the first edit. But the notes on screen must be
 * editable *before* that — and editing references notes by id — so the hook
 * holds one pre-seeded candidate document built from the analysis. The UI
 * displays the candidate's notes, and the first edit persists that same
 * candidate. If display and seeding each minted their own ids, the first drag
 * would commit against ids that no longer exist and silently do nothing.
 *
 * From the first edit onward the score is what the panel shows and plays, and
 * re-running analysis never touches it — that separation is the point of the
 * whole layer. Each gesture persists immediately; there is no dirty state for
 * a closed tab to lose.
 */
export function useScore(
  repository: MemoRepository,
  memo: Memo,
  analysis: AnalysisRecord | null,
): {
  /** What to draw and play: the saved score's notes, else the candidate's. */
  notes: ScoreNote[];
  /** True once edits have been persisted — drives the "Edited" badge. */
  edited: boolean;
  moveNote: (noteId: string, midi: number, startMs: number) => void;
  createNote: (midi: number, startMs: number) => void;
  deleteNote: (noteId: string) => void;
  /** Discards edits so the machine transcription shows again. */
  reset: () => Promise<void>;
} {
  const [score, setScore] = useState<ScoreDocument | null>(null);

  // Rebuilt only when the analysis itself changes (e.g. re-transcription).
  const candidate = useMemo(
    () => (analysis ? seedScoreFromAnalysis(memo.id, analysis) : null),
    [memo.id, analysis],
  );

  // The latest document, readable synchronously inside a gesture handler —
  // two quick edits must not both fork from the same stale render.
  const scoreRef = useRef<ScoreDocument | null>(null);
  scoreRef.current = score;

  useEffect(() => {
    let cancelled = false;
    // Queried unconditionally rather than gated on memo.currentScoreId: the
    // memo prop comes from the list, which is not reloaded per edit, so its
    // pointer is stale the moment the first edit seeds a score. The
    // repository reads the memo row fresh and cannot be stale.
    void repository.getScore(memo.id).then((result) => {
      if (!cancelled) setScore(result.ok ? result.value : null);
    });
    return () => {
      cancelled = true;
    };
  }, [repository, memo.id]);

  /** Applies an edit, persisting the candidate first if no score exists yet. */
  const apply = useCallback(
    (edit: (current: ScoreDocument) => ScoreDocument) => {
      const base = scoreRef.current ?? candidate;
      if (!base) return;

      const next = edit(base);
      scoreRef.current = next;
      setScore(next);
      // Persisted per gesture, not debounced: an edit the user just made is
      // exactly the thing that must survive a closed tab.
      void repository.saveScore(next);
    },
    [repository, candidate],
  );

  return {
    notes: score?.notes ?? candidate?.notes ?? [],
    edited: score !== null,
    moveNote: useCallback(
      (noteId, midi, startMs) =>
        apply((current) => moveNote(current, noteId, midi, startMs)),
      [apply],
    ),
    createNote: useCallback(
      (midi, startMs) => apply((current) => addNote(current, midi, startMs).score),
      [apply],
    ),
    deleteNote: useCallback(
      (noteId) => apply((current) => removeNote(current, noteId)),
      [apply],
    ),
    reset: useCallback(async () => {
      await repository.deleteScore(memo.id);
      scoreRef.current = null;
      setScore(null);
    }, [repository, memo.id]),
  };
}
