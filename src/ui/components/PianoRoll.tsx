import { useEffect, useRef } from 'react';
import { hzToMidi, midiToName } from '../../core/pitch.ts';
import type { QuantizedNote } from '../../core/types.ts';
import {
  createRollGeometry,
  isAccidental,
} from '../pianoRollGeometry.ts';

/** The dense pitch contour, with the frame parameters needed to place it in time. */
export interface ContourData {
  hz: Float32Array;
  sampleRate: number;
  hopSizeSamples: number;
  frameSizeSamples: number;
}

interface PianoRollProps {
  /**
   * Plain notes rather than an AnalysisRecord, so the same component can draw
   * an editable score once notes become editable.
   */
  notes: readonly QuantizedNote[];
  contour?: ContourData | null;
  durationMs: number;
  isPlaying: boolean;
  /**
   * Polled per animation frame rather than passed as a value. A position prop
   * would re-render the whole memo list sixty times a second.
   */
  getPositionMs?: (() => number) | undefined;
}

/**
 * Notes drawn against time, with the raw pitch contour behind them and a
 * playhead during playback.
 *
 * The contour is the point of the chart. Notes alone show what the
 * transcription decided; the contour underneath shows what the detector
 * actually heard, which is the only way to tell a wandering voice from a
 * segmentation that split a held note.
 *
 * Presented to assistive technology as a single labelled image — the note list
 * beside it is the accessible representation of the same data, since a grid of
 * rectangles conveys nothing when read aloud.
 */
export function PianoRoll({
  notes,
  contour,
  durationMs,
  isPlaying,
  getPositionMs,
}: PianoRollProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const playheadRef = useRef<SVGGElement>(null);

  const geometry = createRollGeometry(notes, durationMs);
  const { width, height, lowestMidi, highestMidi, rowHeight } = geometry;
  const semitoneSpan = highestMidi - lowestMidi + 1;

  /*
   * The playhead is animated by writing to the DOM directly rather than
   * through React state. At 60fps a state update would re-render every memo
   * row in the list each frame; moving one transform costs nothing.
   *
   * Browsers suspend requestAnimationFrame entirely while the tab is hidden.
   * That is fine here by construction: position is read from the audio clock
   * each tick rather than accumulated per frame, so the playhead freezes while
   * hidden and lands exactly right on the first frame after the tab returns.
   */
  useEffect(() => {
    const playhead = playheadRef.current;
    if (!playhead) return;

    if (!isPlaying || !getPositionMs) {
      playhead.style.display = 'none';
      return;
    }

    playhead.style.display = '';
    let frame = 0;

    const tick = () => {
      const x = geometry.xForMs(getPositionMs());
      playhead.setAttribute('transform', `translate(${x.toFixed(2)} 0)`);

      // Follow the playhead only when it has actually left the visible
      // window, so a user who has scrolled to look at something isn't
      // constantly yanked back.
      const scroller = scrollRef.current;
      if (scroller) {
        const left = scroller.scrollLeft;
        const right = left + scroller.clientWidth;
        if (x < left || x > right - 24) {
          // Keeps a third of the view as lead-in rather than pinning the
          // playhead to the edge.
          scroller.scrollLeft = Math.max(0, x - scroller.clientWidth / 3);
        }
      }

      frame = requestAnimationFrame(tick);
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
    // geometry is recreated each render but is a pure function of these.
  }, [isPlaying, getPositionMs, width, durationMs, notes]);

  if (notes.length === 0) return null;

  const contourPath = contour ? buildContourPath(contour, geometry) : null;

  const summary =
    `Pitch chart: ${notes.length} notes from ` +
    `${midiToName(Math.min(...notes.map((n) => n.midi)))} to ` +
    `${midiToName(Math.max(...notes.map((n) => n.midi)))}.`;

  return (
    <div
      className="piano-roll"
      ref={scrollRef}
      tabIndex={0}
      role="group"
      aria-label="Pitch chart, scrollable"
    >
      <svg
        className="piano-roll__svg"
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={summary}
      >
        {Array.from({ length: semitoneSpan }, (_, row) => {
          const midi = highestMidi - row;
          return (
            <rect
              key={midi}
              x={0}
              y={row * rowHeight}
              width={width}
              height={rowHeight}
              className={
                isAccidental(midi) ? 'piano-roll__row--accidental' : 'piano-roll__row'
              }
            />
          );
        })}

        {contourPath && (
          <path className="piano-roll__contour" d={contourPath} fill="none" />
        )}

        {notes.map((note, index) => (
          <rect
            key={`${note.startMs}-${index}`}
            className="piano-roll__note"
            x={geometry.xForMs(note.startMs)}
            y={geometry.yForMidi(note.midi) + 1}
            width={Math.max(3, geometry.widthForMs(note.durationMs))}
            height={rowHeight - 2}
            rx={2}
            // Confidence as opacity, so a shaky transcription looks shaky
            // rather than as definite as a clean one.
            opacity={0.45 + 0.55 * Math.min(1, note.confidence)}
          />
        ))}

        {/* Position is conveyed by the audio itself; this is purely visual. */}
        <g ref={playheadRef} style={{ display: 'none' }} aria-hidden="true">
          <line
            className="piano-roll__playhead"
            x1={0}
            y1={0}
            x2={0}
            y2={height}
          />
        </g>
      </svg>
    </div>
  );
}

function buildContourPath(
  contour: ContourData,
  geometry: ReturnType<typeof createRollGeometry>,
): string | null {
  const { hz, sampleRate, hopSizeSamples, frameSizeSamples } = contour;
  const points: string[] = [];
  let penDown = false;

  for (let i = 0; i < hz.length; i++) {
    const value = hz[i]!;
    if (!Number.isFinite(value) || value <= 0) {
      // Unvoiced: lift the pen so silence isn't drawn as a line between
      // whatever happened either side of it.
      penDown = false;
      continue;
    }
    const timeMs =
      ((i * hopSizeSamples + frameSizeSamples / 2) / sampleRate) * 1000;
    const x = geometry.xForMs(timeMs).toFixed(1);
    // Half a row lower than the raw mapping: yForMidi gives a row's top edge,
    // and the contour has to line up with the centre of the note rectangles
    // drawn in that row, not their tops.
    const y = (geometry.yForMidi(hzToMidi(value)) + geometry.rowHeight / 2).toFixed(1);
    points.push(`${penDown ? 'L' : 'M'}${x} ${y}`);
    penDown = true;
  }

  return points.length > 1 ? points.join(' ') : null;
}
