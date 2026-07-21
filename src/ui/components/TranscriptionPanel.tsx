import { useCallback, useEffect, useState } from 'react';
import { isStale } from '../../analysis/registry.ts';
import { midiToName } from '../../core/pitch.ts';
import type { AnalysisRecord, Memo } from '../../core/types.ts';
import type { MemoRepository } from '../../storage/memoRepository.ts';
import { useScore } from '../hooks/useScore.ts';
import type { NotePlaybackControls } from '../notePlayback.ts';
import { PianoRoll } from './PianoRoll.tsx';

interface TranscriptionPanelProps {
  memo: Memo;
  repository: MemoRepository;
  isRunning: boolean;
  notePlayback: NotePlaybackControls;
  onRetranscribe: (memo: Memo) => void;
}

const WARNING_TEXT: Record<string, string> = {
  'too-short': 'Too short to analyse.',
  'no-pitch-detected': 'No clear pitch was found.',
  'mostly-unvoiced': 'Most of this recording had no clear pitch, so the notes below rest on little evidence.',
  'very-short': 'Very short, so the transcription may be unreliable.',
  'significant-tuning-offset': 'Sung noticeably off concert pitch — the intervals were read relative to your own tuning.',
};

function formatSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(2)}s`;
}

/**
 * Signed cents, without the "-0" that toFixed produces for a tiny negative
 * deviation — a note dead in tune should not read as flat.
 */
function formatCents(cents: number): string {
  const rounded = Math.round(cents);
  if (rounded === 0) return '0';
  return rounded > 0 ? `+${rounded}` : String(rounded);
}

export function TranscriptionPanel({
  memo,
  repository,
  isRunning,
  notePlayback,
  onRetranscribe,
}: TranscriptionPanelProps) {
  const [analysis, setAnalysis] = useState<AnalysisRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [showDetails, setShowDetails] = useState(false);
  const [confirmingReset, setConfirmingReset] = useState(false);

  // The user's editable layer. Until they touch a note this mirrors the
  // analysis; from the first edit it is an independent document that
  // re-transcription never overwrites.
  const scoreApi = useScore(repository, memo, analysis);

  // Bound to this memo so the playhead reads this memo's position, not
  // whatever the transport is paused at on another. Memoized because
  // PianoRoll's animation-frame effect depends on its identity.
  const getPositionMs = useCallback(
    () => notePlayback.positionMs(memo),
    [notePlayback, memo],
  );

  // Hand every edit to the transport, which schedules its voices up front and
  // would otherwise keep replaying the notes as they were when play started.
  // A no-op unless this memo is the one loaded, and unless the notes actually
  // changed — the array identity is the signal.
  const { syncNotes } = notePlayback;
  const scoreNotes = scoreApi.notes;
  useEffect(() => {
    syncNotes(memo, scoreNotes);
  }, [syncNotes, memo, scoreNotes]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void repository.getAnalysis(memo.id).then((result) => {
      if (cancelled) return;
      setAnalysis(result.ok ? result.value : null);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
    // Re-fetches when the memo's analysis pointer changes, i.e. after a run.
  }, [repository, memo.id, memo.analysisState?.currentAnalysisId]);

  if (isRunning) {
    return (
      <div className="transcription" role="status">
        <p className="transcription__status">Transcribing…</p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="transcription">
        <p className="transcription__status">Loading transcription…</p>
      </div>
    );
  }

  const status = memo.analysisState?.status;

  if (!analysis) {
    return (
      <div className="transcription">
        <p className="transcription__status">
          {status === 'failed'
            ? 'Transcription failed for this memo.'
            : status === 'unsupported'
              ? 'This browser could not decode this recording for analysis.'
              : 'Not transcribed yet.'}
        </p>
      </div>
    );
  }

  const { quality, tuning } = analysis;
  // What the panel draws, plays, and lists: the user's notes once edited,
  // otherwise the transcription (via the hook's id-stable candidate).
  const notes = scoreApi.notes;
  const stale = isStale(analysis.algorithmId, analysis.algorithmVersion);
  // Named apart from the analysis `status` above; these are unrelated states.
  const transportStatus = notePlayback.statusFor(memo.id);
  const isPlayingNotes = transportStatus === 'playing';
  const isPaused = transportStatus === 'paused';

  return (
    <div className="transcription">
      {stale && (
        <p className="transcription__warning">
          This was transcribed by an older version of the analysis. Re-running
          it may give a better result.
        </p>
      )}

      {notes.length === 0 && (
        <p className="transcription__status">
          No notes were found — try humming a little louder or more steadily.
          You can still add notes by hand below.
        </p>
      )}

      {scoreApi.edited && (
        <p className="transcription__edited">
          <strong>Edited</strong> — showing your notes, not the machine
          transcription.
        </p>
      )}

      {
        <>
          {/*
            Hearing the transcription next to the recording is the practical
            way to judge it — a wrong note is far more obvious played back than
            read as a letter.
          */}
          {/*
            Icon-only, so the accessible name is the only thing carrying the
            meaning — it has to say which memo, since several rows can be open
            at once.
          */}
          <div className="transcription__transport" role="group" aria-label="Note playback">
            <button
              type="button"
              className="button button--icon"
              aria-label={
                isPlayingNotes
                  ? `Pause notes for ${memo.title}`
                  : isPaused
                    ? `Resume notes for ${memo.title}`
                    : `Play notes for ${memo.title}`
              }
              onClick={() => notePlayback.toggle(memo, notes)}
            >
              <span aria-hidden="true">{isPlayingNotes ? '❚❚' : '▶'}</span>
            </button>
            <button
              type="button"
              className="button button--icon"
              aria-label={`Stop notes for ${memo.title}`}
              // Idle already means stopped at the start.
              disabled={transportStatus === 'idle'}
              onClick={notePlayback.stop}
            >
              <span aria-hidden="true">■</span>
            </button>
          </div>

          <PianoRoll
            notes={notes}
            contour={{
              hz: new Float32Array(analysis.f0.hz),
              sampleRate: analysis.input.sampleRate,
              hopSizeSamples: analysis.input.hopSizeSamples,
              frameSizeSamples: analysis.input.frameSizeSamples,
            }}
            durationMs={memo.capture.durationMs}
            transport={transportStatus}
            getPositionMs={getPositionMs}
            scrubber={{
              onScrubStart: () => notePlayback.beginScrub(memo, notes),
              onScrubEnd: (ms) => notePlayback.endScrub(memo, notes, ms),
            }}
            editor={{
              onMove: scoreApi.moveNote,
              onResize: scoreApi.resizeNote,
              onCreate: scoreApi.createNote,
              onDelete: scoreApi.deleteNote,
            }}
            onPreviewPitch={notePlayback.previewPitch}
          />
        </>
      }

      {quality.warnings.map((warning) => (
        <p key={warning} className="transcription__warning">
          {WARNING_TEXT[warning] ?? warning}
        </p>
      ))}

      {/*
        Accuracy is the thing that will need iterating on, so the numbers
        behind a transcription are available rather than hidden in a console.
      */}
      <div className="transcription__actions">
        <button
          type="button"
          className="button"
          aria-expanded={showDetails}
          onClick={() => setShowDetails((open) => !open)}
        >
          {showDetails ? 'Hide details' : 'Show details'}
        </button>
        <button
          type="button"
          className="button"
          aria-label={`Transcribe ${memo.title} again`}
          onClick={() => onRetranscribe(memo)}
        >
          Transcribe again
        </button>

        {scoreApi.edited &&
          (confirmingReset ? (
            <div
              className="memo-row__confirm"
              role="group"
              aria-label="Discard your edits?"
            >
              <span className="memo-row__confirm-text">Discard edits?</span>
              <button
                type="button"
                className="button button--danger"
                // Keeps a keyboard user's focus inside the choice they opened.
                autoFocus
                onClick={() => {
                  setConfirmingReset(false);
                  void scoreApi.reset();
                }}
              >
                Yes
              </button>
              <button
                type="button"
                className="button"
                onClick={() => setConfirmingReset(false)}
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="button"
              // The confirmation is not ceremony: this throws away hand edits,
              // which is the one loss the score layer exists to prevent
              // happening silently.
              aria-label={`Reset ${memo.title} to the machine transcription`}
              onClick={() => setConfirmingReset(true)}
            >
              Reset to transcription
            </button>
          ))}
      </div>

      {showDetails && (
        <div className="transcription__details">
          {/*
            The notes as a scannable line. Not the chart's accessible
            equivalent any more — each note on the roll is a focusable control
            carrying its own label, so nothing is hidden behind this toggle.
          */}
          {notes.length > 0 && (
            <p className="transcription__notes">
              <span className="visually-hidden">Notes in order: </span>
              {notes.map((note) => midiToName(note.midi)).join(' ')}
            </p>
          )}

          <dl className="transcription__stats">
            <div>
              <dt>Engine</dt>
              <dd>
                {analysis.algorithmId} v{analysis.algorithmVersion}
              </dd>
            </div>
            <div>
              <dt>Pitched</dt>
              <dd>{Math.round(quality.voicedRatio * 100)}% of frames</dd>
            </div>
            <div>
              <dt>Median confidence</dt>
              <dd>{quality.medianConfidence.toFixed(2)}</dd>
            </div>
            <div>
              <dt>Tuning offset</dt>
              <dd>{formatCents(tuning.estimatedOffsetCents)} cents</dd>
            </div>
            <div>
              <dt>Analysed in</dt>
              <dd>{analysis.computeMs} ms</dd>
            </div>
          </dl>

          {notes.length > 0 && (
            <table className="transcription__table">
              <caption className="visually-hidden">
                Detected notes with timing and confidence
              </caption>
              <thead>
                <tr>
                  <th scope="col">Note</th>
                  <th scope="col">Start</th>
                  <th scope="col">Length</th>
                  <th scope="col">Cents</th>
                  <th scope="col">Confidence</th>
                </tr>
              </thead>
              <tbody>
                {notes.map((note, index) => (
                  <tr key={`${note.startMs}-${index}`}>
                    <td>{midiToName(note.midi)}</td>
                    <td>{formatSeconds(note.startMs)}</td>
                    <td>{formatSeconds(note.durationMs)}</td>
                    <td>{formatCents(note.centsDeviation)}</td>
                    <td>{note.confidence.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
