import { useState } from 'react';
import {
  formatDuration,
  formatDurationSpoken,
  formatTimestamp,
} from '../../core/format.ts';
import type { Memo } from '../../core/types.ts';

interface MemoRowProps {
  memo: Memo;
  isCurrent: boolean;
  isPlaying: boolean;
  onTogglePlay: (memo: Memo) => void;
  onExport: (memo: Memo) => void;
  onDelete: (memo: Memo) => void;
}

export function MemoRow({
  memo,
  isCurrent,
  isPlaying,
  onTogglePlay,
  onExport,
  onDelete,
}: MemoRowProps) {
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const playLabel = isCurrent && isPlaying ? 'Pause' : 'Play';

  return (
    <li
      className="memo-row"
      // Identifies the row so focus can be moved here after a sibling is
      // deleted; the list stays a plain ul/li with no wrapper elements.
      data-memo-id={memo.id}
      data-current={isCurrent || undefined}
    >
      <button
        type="button"
        className="memo-row__play"
        // The visible glyph is decorative, so the name has to carry both the
        // action and which memo it applies to — every row would otherwise
        // announce as an identical "Play" button.
        aria-label={`${playLabel} ${memo.title}`}
        onClick={() => onTogglePlay(memo)}
      >
        <span aria-hidden="true">{isCurrent && isPlaying ? '❚❚' : '▶'}</span>
      </button>

      <div className="memo-row__meta">
        <span className="memo-row__title">{memo.title}</span>
        <span className="memo-row__sub">
          {formatTimestamp(memo.createdAt)}
          {' · '}
          <span aria-hidden="true">{formatDuration(memo.capture.durationMs)}</span>
          {/* "0:42" is read as a clock time; the spoken form is for listeners. */}
          <span className="visually-hidden">
            {formatDurationSpoken(memo.capture.durationMs)}
          </span>
        </span>
      </div>

      {confirmingDelete ? (
        <div className="memo-row__confirm" role="group" aria-label={`Delete ${memo.title}?`}>
          <span className="memo-row__confirm-text">Delete?</span>
          <button
            type="button"
            className="button button--danger"
            // Autofocus keeps a keyboard user's focus inside the choice they
            // just opened instead of leaving it on a button that is now gone.
            autoFocus
            onClick={() => onDelete(memo)}
          >
            Yes
          </button>
          <button
            type="button"
            className="button"
            onClick={() => setConfirmingDelete(false)}
          >
            Cancel
          </button>
        </div>
      ) : (
        <div className="memo-row__actions">
          <button
            type="button"
            className="button"
            aria-label={`Export ${memo.title}`}
            onClick={() => onExport(memo)}
          >
            Export
          </button>
          <button
            type="button"
            className="button"
            aria-label={`Delete ${memo.title}`}
            onClick={() => setConfirmingDelete(true)}
          >
            Delete
          </button>
        </div>
      )}
    </li>
  );
}
