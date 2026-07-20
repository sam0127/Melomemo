import { useEffect, useRef, useState } from 'react';
import { hzToMidi, midiToName } from '../../core/pitch.ts';
import type { QuantizedNote, ScoreNote } from '../../core/types.ts';
import {
  createRollGeometry,
  isAccidental,
  type RollGeometry,
} from '../pianoRollGeometry.ts';

/** The dense pitch contour, with the frame parameters needed to place it in time. */
export interface ContourData {
  hz: Float32Array;
  sampleRate: number;
  hopSizeSamples: number;
  frameSizeSamples: number;
}

/**
 * Editing callbacks. When present, notes must be ScoreNotes (stable ids) and
 * the roll becomes interactive: notes drag with the pointer and move with the
 * keyboard, empty space creates on double-click, and a selected note exposes
 * a delete affordance for pointers without a Delete key.
 */
export interface RollEditor {
  onMove: (noteId: string, midi: number, startMs: number) => void;
  onCreate: (midi: number, startMs: number) => void;
  onDelete: (noteId: string) => void;
}

interface PianoRollProps {
  /**
   * Plain notes rather than an AnalysisRecord, so the same component draws
   * both a read-only transcription and the user's editable score.
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
  editor?: RollEditor | undefined;
}

/** Pointer movement below this is a click (select); above it, a drag begins. */
const DRAG_THRESHOLD_PX = 4;

/** Keyboard time nudge. Shift gives the fine step. */
const NUDGE_MS = 50;
const FINE_NUDGE_MS = 10;

interface DragState {
  noteId: string;
  pointerId: number;
  originX: number;
  originY: number;
  /** The note's values when the gesture began. */
  startMidi: number;
  startMs: number;
  /** Becomes true once the threshold is crossed; a click never sets it. */
  moved: boolean;
}

/** What the dragged note currently shows, before the edit is committed. */
interface DragPreview {
  noteId: string;
  midi: number;
  startMs: number;
}

function describeNote(note: QuantizedNote): string {
  return `${midiToName(note.midi)}, ${(note.startMs / 1000).toFixed(2)} seconds`;
}

/**
 * Notes drawn against time, with the raw pitch contour behind them and a
 * playhead during playback. With an editor attached, the notes themselves
 * become the editing surface.
 *
 * The contour is the point of the chart for judging a transcription: notes
 * alone show what was decided, the contour shows what the detector heard.
 * It stays visible during editing as the reference to edit against.
 */
export function PianoRoll({
  notes,
  contour,
  durationMs,
  isPlaying,
  getPositionMs,
  editor,
}: PianoRollProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const playheadRef = useRef<SVGGElement>(null);
  const dragRef = useRef<DragState | null>(null);

  const [preview, setPreview] = useState<DragPreview | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');

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

  if (notes.length === 0 && !editor) return null;

  const announce = (message: string) => {
    // A live region only fires on change; identical successive messages need
    // a nudge to re-announce.
    setAnnouncement((current) => (current === message ? `${message} ` : message));
  };

  /** Event coordinates in the SVG's own space, scroll position included. */
  const svgPoint = (event: { clientX: number; clientY: number }) => {
    const rect = svgRef.current!.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const clampMidiToRange = (midi: number) =>
    Math.min(highestMidi, Math.max(lowestMidi, midi));

  // --- pointer editing -----------------------------------------------------

  const handleNotePointerDown = (
    event: React.PointerEvent<SVGRectElement>,
    note: ScoreNote,
  ) => {
    if (!editor) return;
    // Only primary-button drags; a right-click is the context menu's.
    if (event.button !== 0) return;
    event.stopPropagation();

    // jsdom lacks pointer capture; the guard keeps tests honest.
    event.currentTarget.setPointerCapture?.(event.pointerId);
    dragRef.current = {
      noteId: note.id,
      pointerId: event.pointerId,
      originX: event.clientX,
      originY: event.clientY,
      startMidi: note.midi,
      startMs: note.startMs,
      moved: false,
    };
    setSelectedId(note.id);
  };

  const dragTarget = (event: React.PointerEvent): DragPreview | null => {
    const drag = dragRef.current;
    if (!drag) return null;

    const dx = event.clientX - drag.originX;
    const dy = event.clientY - drag.originY;
    if (!drag.moved) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return null;
      drag.moved = true;
    }

    // Delta-based rather than absolute: the note moves by how far the pointer
    // travelled, so grabbing a note anywhere on its body feels anchored.
    const midi = clampMidiToRange(
      drag.startMidi - Math.round(dy / rowHeight),
    );
    const startMs = Math.max(0, drag.startMs + geometry.msForX(dx));
    return { noteId: drag.noteId, midi, startMs };
  };

  const handleNotePointerMove = (event: React.PointerEvent<SVGRectElement>) => {
    const target = dragTarget(event);
    if (target) setPreview(target);
  };

  const handleNotePointerUp = (event: React.PointerEvent<SVGRectElement>) => {
    const drag = dragRef.current;
    if (!drag || !editor) return;
    const target = dragTarget(event);
    dragRef.current = null;
    setPreview(null);

    // A press that never crossed the threshold is a selection, already done
    // on pointerdown. Only a real drag commits an edit.
    if (target && drag.moved) {
      editor.onMove(drag.noteId, target.midi, target.startMs);
      announce(`Moved to ${midiToName(target.midi)}, ${(target.startMs / 1000).toFixed(2)} seconds`);
    }
  };

  const handleNotePointerCancel = () => {
    dragRef.current = null;
    setPreview(null);
  };

  const handleBackgroundDoubleClick = (
    event: React.MouseEvent<SVGSVGElement>,
  ) => {
    if (!editor) return;
    const { x, y } = svgPoint(event);
    const midi = clampMidiToRange(geometry.midiForY(y));
    const startMs = Math.max(0, geometry.msForX(x));
    editor.onCreate(midi, startMs);
    announce(`Added ${midiToName(midi)} at ${(startMs / 1000).toFixed(2)} seconds`);
  };

  // --- keyboard editing ----------------------------------------------------

  const handleNoteKeyDown = (
    event: React.KeyboardEvent<SVGRectElement>,
    note: ScoreNote,
  ) => {
    if (!editor) return;
    const nudge = event.shiftKey ? FINE_NUDGE_MS : NUDGE_MS;
    let midi = note.midi;
    let startMs = note.startMs;

    switch (event.key) {
      case 'ArrowUp':
        midi = clampMidiToRange(midi + 1);
        break;
      case 'ArrowDown':
        midi = clampMidiToRange(midi - 1);
        break;
      case 'ArrowLeft':
        startMs = Math.max(0, startMs - nudge);
        break;
      case 'ArrowRight':
        startMs = startMs + nudge;
        break;
      case 'Delete':
      case 'Backspace':
        event.preventDefault();
        editor.onDelete(note.id);
        setSelectedId(null);
        announce(`Deleted ${midiToName(note.midi)}`);
        return;
      case 'Escape':
        setSelectedId(null);
        (event.currentTarget as unknown as { blur?: () => void }).blur?.();
        return;
      default:
        return;
    }

    // Arrow keys otherwise scroll the container out from under the edit.
    event.preventDefault();
    editor.onMove(note.id, midi, startMs);
    announce(`${midiToName(midi)}, ${(startMs / 1000).toFixed(2)} seconds`);
  };

  // --- render --------------------------------------------------------------

  const selectedNote = editor
    ? (notes as readonly ScoreNote[]).find((note) => note.id === selectedId) ?? null
    : null;

  const contourPath = contour ? buildContourPath(contour, geometry) : null;

  const summary =
    notes.length === 0
      ? 'Empty score. Double-click to add a note.'
      : `Pitch chart: ${notes.length} notes from ` +
        `${midiToName(Math.min(...notes.map((n) => n.midi)))} to ` +
        `${midiToName(Math.max(...notes.map((n) => n.midi)))}.`;

  return (
    <div>
      <div
        className="piano-roll"
        ref={scrollRef}
        tabIndex={0}
        role="group"
        aria-label={
          editor ? 'Note editor, scrollable. Notes are focusable.' : 'Pitch chart, scrollable'
        }
      >
        <svg
          className="piano-roll__svg"
          ref={svgRef}
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          // Read-only: one labelled image. Editable: role="img" would hide
          // the focusable notes from assistive tech entirely, so the svg
          // stays a plain container and each note carries its own label.
          role={editor ? undefined : 'img'}
          aria-label={editor ? undefined : summary}
          onDoubleClick={editor ? handleBackgroundDoubleClick : undefined}
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
                  isAccidental(midi)
                    ? 'piano-roll__row--accidental'
                    : 'piano-roll__row'
                }
              />
            );
          })}

          {contourPath && (
            <path className="piano-roll__contour" d={contourPath} fill="none" />
          )}

          {notes.map((note, index) => {
            const scoreNote = editor ? (note as ScoreNote) : null;
            const dragged =
              preview && scoreNote && preview.noteId === scoreNote.id;
            const midi = dragged ? preview.midi : note.midi;
            const startMs = dragged ? preview.startMs : note.startMs;

            return (
              <rect
                key={scoreNote?.id ?? `${note.startMs}-${index}`}
                className="piano-roll__note"
                data-editable={editor ? true : undefined}
                data-selected={
                  scoreNote && selectedId === scoreNote.id ? true : undefined
                }
                data-dragging={dragged || undefined}
                x={geometry.xForMs(startMs)}
                y={geometry.yForMidi(midi) + 1}
                width={Math.max(3, geometry.widthForMs(note.durationMs))}
                height={rowHeight - 2}
                rx={2}
                // Confidence as opacity, so a shaky transcription looks shaky
                // rather than as definite as a clean one. Dragging goes solid.
                opacity={dragged ? 1 : 0.45 + 0.55 * Math.min(1, note.confidence)}
                {...(editor && scoreNote
                  ? {
                      tabIndex: 0,
                      role: 'button',
                      'aria-label': `Note ${describeNote(note)}. Arrow keys move, Delete removes.`,
                      onPointerDown: (event) =>
                        handleNotePointerDown(event, scoreNote),
                      onPointerMove: handleNotePointerMove,
                      onPointerUp: handleNotePointerUp,
                      onPointerCancel: handleNotePointerCancel,
                      onKeyDown: (event) => handleNoteKeyDown(event, scoreNote),
                      onFocus: () => setSelectedId(scoreNote.id),
                    }
                  : {})}
              />
            );
          })}

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

      {editor && (
        <div className="piano-roll__editbar">
          {selectedNote ? (
            <>
              <span className="piano-roll__selection">
                {describeNote(selectedNote)}
              </span>
              {/*
                Touch has no Delete key, and a drag can't delete; without this
                button removal would be keyboard-only.
              */}
              <button
                type="button"
                className="button"
                onClick={() => {
                  editor.onDelete(selectedNote.id);
                  setSelectedId(null);
                  announce(`Deleted ${midiToName(selectedNote.midi)}`);
                }}
              >
                Delete note
              </button>
            </>
          ) : (
            <span className="piano-roll__hint">
              Drag notes to move them. Double-click empty space to add one.
            </span>
          )}
        </div>
      )}

      {/* Edits change the SVG silently; this is how non-visual users hear them. */}
      <div className="visually-hidden" aria-live="polite">
        {announcement}
      </div>
    </div>
  );
}

function buildContourPath(
  contour: ContourData,
  geometry: RollGeometry,
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
