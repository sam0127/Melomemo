import { useEffect, useId, useRef, useState } from 'react';
import {
  formatDuration,
  formatDurationSpoken,
  formatTimestamp,
} from '../../core/format.ts';
import type { Memo } from '../../core/types.ts';
import type { MemoRepository } from '../../storage/memoRepository.ts';
import type { NotePlaybackControls } from '../notePlayback.ts';
import { TranscriptionPanel } from './TranscriptionPanel.tsx';

interface MemoRowProps {
  memo: Memo;
  isCurrent: boolean;
  isPlaying: boolean;
  isTranscribing: boolean;
  repository: MemoRepository;
  notePlayback: NotePlaybackControls;
  onTogglePlay: (memo: Memo) => void;
  onTranscribe: (memo: Memo) => void;
  onRename: (memo: Memo, title: string) => void;
  onExport: (memo: Memo) => void;
  onDelete: (memo: Memo) => void;
}

/** Short status shown on the row itself, so the list conveys progress at a glance. */
function transcriptionSummary(memo: Memo, isTranscribing: boolean): string | null {
  if (isTranscribing) return 'Transcribing…';
  switch (memo.analysisState?.status) {
    case 'ok':
      return 'Transcribed';
    case 'failed':
      return 'Transcription failed';
    case 'unsupported':
      return 'Cannot transcribe';
    default:
      return null;
  }
}

export function MemoRow({
  memo,
  isCurrent,
  isPlaying,
  isTranscribing,
  repository,
  notePlayback,
  onTogglePlay,
  onTranscribe,
  onRename,
  onExport,
  onDelete,
}: MemoRowProps) {
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(memo.title);
  const [showTranscription, setShowTranscription] = useState(false);

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
  const summary = transcriptionSummary(memo, isTranscribing);
  const status = memo.analysisState?.status;
  /*
   * Imported memos, ones recorded before transcription existed, and ones whose
   * analysis failed all need a way back in — otherwise a single failure leaves
   * a memo permanently untranscribed.
   */
  const canTranscribe =
    !isTranscribing && (memo.analysisState == null || status === 'failed');
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
      data-open={showTranscription || undefined}
      /*
       * The whole row is a tap target for opening the memo, but it also holds
       * buttons and a form. A click that originated in one of those is that
       * control's, not the row's — without this check, playing a memo or
       * confirming a delete would also toggle the panel.
       *
       * This is a pointer convenience only. Keyboard and assistive tech go
       * through the title button below, which is a real control and carries
       * the expanded state.
       */
      onClick={(event) => {
        if ((event.target as Element).closest('button, input, form, .transcription')) {
          return;
        }
        setShowTranscription((open) => !open);
      }}
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
        <div className="memo-row__titlerow">
          <button
            type="button"
            className="memo-row__title"
            aria-expanded={showTranscription}
            onClick={() => setShowTranscription((open) => !open)}
          >
            {memo.title}
          </button>
          <button
            type="button"
            ref={renameButtonRef}
            className="memo-row__rename-button"
            aria-label={`Rename ${memo.title}`}
            onClick={beginEditing}
          >
            {/* Decorative: the accessible name is on the button. */}
            <svg
              viewBox="0 0 16 16"
              width="14"
              height="14"
              aria-hidden="true"
              focusable="false"
            >
              <path
                d="M11.6 1.6a1.4 1.4 0 0 1 2 2l-.9.9-2-2 .9-.9ZM9.8 3.4l2 2L5 12.2l-2.6.6.6-2.6 6.8-6.8Z"
                fill="currentColor"
              />
            </svg>
          </button>
        </div>
        <span className="memo-row__sub">
          {formatTimestamp(memo.createdAt)}
          {' · '}
          <span aria-hidden="true">{formatDuration(memo.capture.durationMs)}</span>
          {/* "0:42" is read as a clock time; the spoken form is for listeners. */}
          <span className="visually-hidden">
            {formatDurationSpoken(memo.capture.durationMs)}
          </span>
          {summary && (
            <>
              {' · '}
              <span className="memo-row__transcription-status">{summary}</span>
            </>
          )}
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
          {canTranscribe && (
            <button
              type="button"
              className="button"
              aria-label={`Transcribe ${memo.title}`}
              onClick={() => onTranscribe(memo)}
            >
              {status === 'failed' ? 'Retry' : 'Transcribe'}
            </button>
          )}
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

      {showTranscription && (
        <TranscriptionPanel
          memo={memo}
          repository={repository}
          isRunning={isTranscribing}
          notePlayback={notePlayback}
          onRetranscribe={onTranscribe}
        />
      )}
    </li>
  );
}
