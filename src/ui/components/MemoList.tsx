import { useRef } from 'react';
import type { Memo, MemoId } from '../../core/types.ts';
import type { MemoRepository } from '../../storage/memoRepository.ts';
import type { NotePlaybackControls } from '../notePlayback.ts';
import { MemoRow } from './MemoRow.tsx';

interface MemoListProps {
  memos: Memo[];
  currentMemoId: MemoId | null;
  isPlaying: boolean;
  repository: MemoRepository;
  isTranscribing: (id: MemoId) => boolean;
  /** Only one memo is open at a time, so this lives above the rows. */
  openMemoId: MemoId | null;
  onToggleOpen: (id: MemoId, open: boolean) => void;
  notePlayback: NotePlaybackControls;
  onTogglePlay: (memo: Memo) => void;
  onTranscribe: (memo: Memo) => void;
  onRename: (memo: Memo, title: string) => void;
  onExport: (memo: Memo) => void;
  onDelete: (memo: Memo) => void;
}

export function MemoList({
  memos,
  currentMemoId,
  isPlaying,
  repository,
  openMemoId,
  onToggleOpen,
  isTranscribing,
  notePlayback,
  onTogglePlay,
  onTranscribe,
  onRename,
  onExport,
  onDelete,
}: MemoListProps) {
  const listRef = useRef<HTMLUListElement>(null);

  /**
   * Deleting removes the element that currently holds focus, which otherwise
   * drops the user back to the top of the document. Focus is moved to the row
   * that takes its place, or to the list itself when the last one goes.
   */
  const handleDelete = (memo: Memo) => {
    const index = memos.findIndex((m) => m.id === memo.id);
    const next = memos[index + 1] ?? memos[index - 1] ?? null;

    onDelete(memo);

    // Deferred a frame so the target exists after React removes the old row.
    requestAnimationFrame(() => {
      const list = listRef.current;
      if (!list) return;
      if (next) {
        list
          .querySelector<HTMLButtonElement>(`[data-memo-id="${next.id}"] button`)
          ?.focus();
      } else {
        list.focus();
      }
    });
  };

  if (memos.length === 0) {
    return (
      <p className="empty-state">
        No memos yet. Press <strong>New memo</strong> and sing or whistle
        something.
      </p>
    );
  }

  return (
    <ul
      className="memo-list"
      ref={listRef}
      // Focusable only as a programmatic target for post-delete focus, never
      // as a tab stop of its own.
      tabIndex={-1}
    >
      {memos.map((memo) => (
        <MemoRow
          key={memo.id}
          memo={memo}
          isCurrent={memo.id === currentMemoId}
          isPlaying={isPlaying}
          isTranscribing={isTranscribing(memo.id)}
          isOpen={openMemoId === memo.id}
          onToggleOpen={(open) => onToggleOpen(memo.id, open)}
          repository={repository}
          notePlayback={notePlayback}
          onTogglePlay={onTogglePlay}
          onTranscribe={onTranscribe}
          onRename={onRename}
          onExport={onExport}
          onDelete={handleDelete}
        />
      ))}
    </ul>
  );
}
