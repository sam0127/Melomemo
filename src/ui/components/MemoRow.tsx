import { useEffect, useId, useRef, useState } from 'react';
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
  onRename: (memo: Memo, title: string) => void;
  onExport: (memo: Memo) => void;
  onDelete: (memo: Memo) => void;
}

export function MemoRow({
  memo,
  isCurrent,
  isPlaying,
  onTogglePlay,
  onRename,
  onExport,
  onDelete,
}: MemoRowProps) {
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(memo.title);

  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const renameButtonRef = useRef<HTMLButtonElement>(null);
  // Set when leaving edit mode, so focus returns to the button that opened it
  // rather than being dropped to the document.
  const restoreFocus = useRef(false);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    } else if (restoreFocus.current) {
      restoreFocus.current = false;
      renameButtonRef.current?.focus();
    }
  }, [editing]);

  const playLabel = isCurrent && isPlaying ? 'Pause' : 'Play';
  const trimmed = draft.trim();
  // An empty title would leave a row with nothing to identify or announce it.
  const canSave = trimmed.length > 0;

  const beginEditing = () => {
    setDraft(memo.title);
    setEditing(true);
  };

  const closeEditing = () => {
    restoreFocus.current = true;
    setEditing(false);
  };

  const commit = () => {
    if (!canSave) return;
    if (trimmed !== memo.title) onRename(memo, trimmed);
    closeEditing();
  };

  if (editing) {
    return (
      <li className="memo-row" data-memo-id={memo.id} data-current={isCurrent || undefined}>
        <form
          className="memo-row__rename"
          // A form so Enter submits without a keydown handler of its own.
          onSubmit={(event) => {
            event.preventDefault();
            commit();
          }}
        >
          <label className="visually-hidden" htmlFor={inputId}>
            Memo name
          </label>
          <input
            id={inputId}
            ref={inputRef}
            className="memo-row__input"
            value={draft}
            // Escape is the expected way out of an inline edit, and without it
            // keyboard users have to tab to Cancel.
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                closeEditing();
              }
            }}
            onChange={(event) => setDraft(event.target.value)}
          />
          <button type="submit" className="button" disabled={!canSave}>
            Save
          </button>
          <button type="button" className="button" onClick={closeEditing}>
            Cancel
          </button>
        </form>
      </li>
    );
  }

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
            ref={renameButtonRef}
            className="button"
            aria-label={`Rename ${memo.title}`}
            onClick={beginEditing}
          >
            Rename
          </button>
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
