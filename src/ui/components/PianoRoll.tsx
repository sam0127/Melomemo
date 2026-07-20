import { midiToName } from '../../core/pitch.ts';
import type { AnalysisRecord } from '../../core/types.ts';
import { hzToMidi } from '../../core/pitch.ts';

interface PianoRollProps {
  analysis: AnalysisRecord;
  durationMs: number;
}

const PIXELS_PER_SECOND = 110;
const ROW_HEIGHT = 11;
const PADDING_SEMITONES = 3;

/**
 * Notes drawn against time, with the raw pitch contour behind them.
 *
 * The contour is the point. Notes alone show what the transcription decided;
 * the contour underneath shows what the detector actually heard, which is the
 * only way to tell a wandering voice from a segmentation that split a held
 * note, or a genuine octave leap from a detector error.
 *
 * Presented to assistive technology as a single labelled image — the note list
 * beside it is the accessible representation of the same data, since a grid of
 * rectangles conveys nothing when read aloud.
 */
export function PianoRoll({ analysis, durationMs }: PianoRollProps) {
  const { notes } = analysis;
  if (notes.length === 0) return null;

  const lowest = Math.min(...notes.map((n) => n.midi)) - PADDING_SEMITONES;
  const highest = Math.max(...notes.map((n) => n.midi)) + PADDING_SEMITONES;
  const semitoneSpan = Math.max(1, highest - lowest + 1);

  const totalMs = Math.max(durationMs, notes.at(-1)!.startMs + notes.at(-1)!.durationMs);
  const width = Math.max(280, (totalMs / 1000) * PIXELS_PER_SECOND);
  const height = semitoneSpan * ROW_HEIGHT;

  const x = (ms: number) => (ms / totalMs) * width;
  const y = (midi: number) => (highest - midi) * ROW_HEIGHT;

  // Timing comes from the record's own frame parameters rather than the
  // current constants, so a transcription made by an earlier engine version
  // still plots correctly.
  const { sampleRate, hopSizeSamples, frameSizeSamples } = analysis.input;
  const contourHz = new Float32Array(analysis.f0.hz);
  const contourPoints: string[] = [];
  let penDown = false;
  for (let i = 0; i < contourHz.length; i++) {
    const hz = contourHz[i]!;
    if (!Number.isFinite(hz) || hz <= 0) {
      penDown = false;
      continue;
    }
    const timeMs =
      ((i * hopSizeSamples + frameSizeSamples / 2) / sampleRate) * 1000;
    const point = `${penDown ? 'L' : 'M'}${x(timeMs).toFixed(1)} ${y(hzToMidi(hz)).toFixed(1)}`;
    contourPoints.push(point);
    penDown = true;
  }

  const summary =
    `Pitch chart: ${notes.length} notes from ` +
    `${midiToName(Math.min(...notes.map((n) => n.midi)))} to ` +
    `${midiToName(Math.max(...notes.map((n) => n.midi)))}.`;

  return (
    <div className="piano-roll" tabIndex={0} role="group" aria-label="Pitch chart, scrollable">
      <svg
        className="piano-roll__svg"
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={summary}
      >
        {/* Alternating rows for the black keys, so octaves are readable. */}
        {Array.from({ length: semitoneSpan }, (_, row) => {
          const midi = highest - row;
          const isAccidental = [1, 3, 6, 8, 10].includes(((midi % 12) + 12) % 12);
          return (
            <rect
              key={midi}
              x={0}
              y={row * ROW_HEIGHT}
              width={width}
              height={ROW_HEIGHT}
              className={
                isAccidental ? 'piano-roll__row--accidental' : 'piano-roll__row'
              }
            />
          );
        })}

        {contourPoints.length > 1 && (
          <path
            className="piano-roll__contour"
            d={contourPoints.join(' ')}
            fill="none"
          />
        )}

        {notes.map((note, index) => (
          <rect
            key={`${note.startMs}-${index}`}
            className="piano-roll__note"
            x={x(note.startMs)}
            y={y(note.midi) + 1}
            width={Math.max(3, x(note.startMs + note.durationMs) - x(note.startMs))}
            height={ROW_HEIGHT - 2}
            rx={2}
            // Confidence is shown as opacity so a shaky transcription looks
            // shaky rather than as definite as a clean one.
            opacity={0.45 + 0.55 * Math.min(1, note.confidence)}
          />
        ))}
      </svg>
    </div>
  );
}
