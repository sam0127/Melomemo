import { useEffect, useState } from 'react';
import { isStale } from '../../analysis/registry.ts';
import { midiToName } from '../../core/pitch.ts';
import type { AnalysisRecord, Memo } from '../../core/types.ts';
import type { MemoRepository } from '../../storage/memoRepository.ts';
import { PianoRoll } from './PianoRoll.tsx';

interface TranscriptionPanelProps {
  memo: Memo;
  repository: MemoRepository;
  isRunning: boolean;
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
  onRetranscribe,
}: TranscriptionPanelProps) {
  const [analysis, setAnalysis] = useState<AnalysisRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [showDetails, setShowDetails] = useState(false);

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

  const { notes, quality, tuning } = analysis;
  const stale = isStale(analysis.algorithmId, analysis.algorithmVersion);

  return (
    <div className="transcription">
      {stale && (
        <p className="transcription__warning">
          This was transcribed by an older version of the analysis. Re-running
          it may give a better result.
        </p>
      )}

      {notes.length === 0 ? (
        <p className="transcription__status">
          No notes were found — try humming a little louder or more steadily.
        </p>
      ) : (
        <>
          <PianoRoll analysis={analysis} durationMs={memo.capture.durationMs} />

          {/*
            The accessible equivalent of the chart above. Listing the note
            names in order is the part a screen-reader user can actually use.
          */}
          <p className="transcription__notes">
            <span className="visually-hidden">Notes in order: </span>
            {notes.map((note) => midiToName(note.midi)).join(' ')}
          </p>
        </>
      )}

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
      </div>

      {showDetails && (
        <div className="transcription__details">
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
