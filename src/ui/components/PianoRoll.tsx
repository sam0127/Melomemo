import { useEffect, useRef, useState } from 'react';
import { hzToMidi, midiToName } from '../../core/pitch.ts';
import type { QuantizedNote, ScoreNote } from '../../core/types.ts';
import { MIN_NOTE_DURATION_MS } from '../../score/scoreEdits.ts';
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
  onResize: (noteId: string, durationMs: number) => void;
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

/**
 * Width of the resize grip straddling a note's end, in px.
 *
 * Sized for a fingertip rather than a cursor, but capped against the note's
 * own width below so a short note doesn't become all grip and impossible to
 * move.
 */
const HANDLE_WIDTH_PX = 14;

interface DragState {
  noteId: string;
  pointerId: number;
  /** Moving the note, or dragging its end to change its length. */
  mode: 'move' | 'resize';
  originX: number;
  originY: number;
  /** The note's values when the gesture began. */
  startMidi: number;
  startMs: number;
  startDurationMs: number;
  /** Becomes true once the threshold is crossed; a click never sets it. */
  moved: boolean;
}

/** What the dragged note currently shows, before the edit is committed. */
interface DragPreview {
  noteId: string;
  midi: number;
  startMs: number;
  durationMs: number;
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

  /*
   * Touch drags, which CSS alone cannot deliver here.
   *
   * `touch-action` is only hit-tested against the top-level <svg>, never
   * against individual shapes inside it, so `touch-action: none` on a note
   * rect is silently inert. On Android that left every note drag being claimed
   * by the browser: vertical drags triggered pull-to-refresh, horizontal ones
   * panned the scroller, and the resulting pointercancel killed the drag.
   *
   * Putting `touch-action: none` on the <svg> would fix it by making the roll
   * unscrollable, which is worse. Instead the default is cancelled only for
   * gestures that begin on a note — the listener must be non-passive, since a
   * passive one cannot preventDefault, and it has to be attached natively
   * because React's synthetic touch listeners are passive.
   */
  useEffect(() => {
    const svg = svgRef.current;
    if (!editor || !svg) return;

    const onTouchStart = (event: TouchEvent) => {
      const target = event.target as Element | null;
      // Matched on the notes' own classes, not on [data-editable] — the <svg>
      // also carries that attribute (for its touch-action rule), so an
      // attribute selector would match every touch on empty space too and
      // leave the roll unscrollable. The resize grip must be listed here as
      // well, or dragging it on Android gets claimed as a scroll exactly as
      // note drags used to be.
      //
      // Cancelling at touchstart is what stops the browser claiming the
      // gesture; by touchmove the decision is already made.
      if (target?.closest?.('.piano-roll__note, .piano-roll__handle')) {
        event.preventDefault();
      }
    };
    const onTouchMove = (event: TouchEvent) => {
      if (dragRef.current) event.preventDefault();
    };

    svg.addEventListener('touchstart', onTouchStart, { passive: false });
    svg.addEventListener('touchmove', onTouchMove, { passive: false });
    return () => {
      svg.removeEventListener('touchstart', onTouchStart);
      svg.removeEventListener('touchmove', onTouchMove);
    };
  }, [editor]);

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

  const beginDrag = (
    event: React.PointerEvent<SVGRectElement>,
    note: ScoreNote,
    mode: 'move' | 'resize',
  ) => {
    if (!editor) return;
    // Only primary-button drags; a right-click is the context menu's.
    if (event.button !== 0) return;
    event.stopPropagation();

    /*
     * Capture keeps events flowing when the pointer leaves the note mid-drag,
     * which is an enhancement rather than a requirement — so a failure must
     * not take the drag with it. It throws NotFoundError whenever the browser
     * does not consider the id an active pointer, and an uncaught throw here
     * aborts the handler before the drag is ever registered, silently
     * disabling dragging altogether.
     */
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId);
    } catch {
      // Drag proceeds uncaptured.
    }

    dragRef.current = {
      noteId: note.id,
      pointerId: event.pointerId,
      mode,
      originX: event.clientX,
      originY: event.clientY,
      startMidi: note.midi,
      startMs: note.startMs,
      startDurationMs: note.durationMs,
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

    if (drag.mode === 'resize') {
      // Only the end follows the pointer; pitch and start stay put.
      const durationMs = Math.max(
        MIN_NOTE_DURATION_MS,
        drag.startDurationMs + geometry.msForX(dx),
      );
      return {
        noteId: drag.noteId,
        midi: drag.startMidi,
        startMs: drag.startMs,
        durationMs,
      };
    }

    // Delta-based rather than absolute: the note moves by how far the pointer
    // travelled, so grabbing a note anywhere on its body feels anchored.
    const midi = clampMidiToRange(
      drag.startMidi - Math.round(dy / rowHeight),
    );
    const startMs = Math.max(0, drag.startMs + geometry.msForX(dx));
    return {
      noteId: drag.noteId,
      midi,
      startMs,
      durationMs: drag.startDurationMs,
    };
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
      if (drag.mode === 'resize') {
        editor.onResize(drag.noteId, target.durationMs);
        announce(`Length ${(target.durationMs / 1000).toFixed(2)} seconds`);
      } else {
        editor.onMove(drag.noteId, target.midi, target.startMs);
        announce(
          `Moved to ${midiToName(target.midi)}, ${(target.startMs / 1000).toFixed(2)} seconds`,
        );
      }
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
      // Brackets rather than a modifier+arrow: Alt+Arrow is browser
      // back/forward, and Shift+Arrow is already the fine time nudge.
      case '[':
      case ']': {
        event.preventDefault();
        const step = event.shiftKey ? FINE_NUDGE_MS : NUDGE_MS;
        const durationMs = Math.max(
          MIN_NOTE_DURATION_MS,
          note.durationMs + (event.key === ']' ? step : -step),
        );
        editor.onResize(note.id, durationMs);
        announce(`Length ${(durationMs / 1000).toFixed(2)} seconds`);
        return;
      }
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
          data-editable={editor ? true : undefined}
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
            const durationMs = dragged ? preview.durationMs : note.durationMs;

            const x = geometry.xForMs(startMs);
            const width = Math.max(3, geometry.widthForMs(durationMs));
            const selected = scoreNote != null && selectedId === scoreNote.id;

            return (
              <g key={scoreNote?.id ?? `${note.startMs}-${index}`}>
                <rect
                  className="piano-roll__note"
                  data-editable={editor ? true : undefined}
                  data-selected={selected || undefined}
                  data-dragging={dragged || undefined}
                  x={x}
                  y={geometry.yForMidi(midi) + 1}
                  width={width}
                  height={rowHeight - 2}
                  rx={2}
                  // Confidence as opacity, so a shaky transcription looks shaky
                  // rather than as definite as a clean one. Dragging goes solid.
                  opacity={dragged ? 1 : 0.45 + 0.55 * Math.min(1, note.confidence)}
                  {...(editor && scoreNote
                    ? {
                        tabIndex: 0,
                        role: 'button',
                        'aria-label': `Note ${describeNote(note)}. Arrow keys move, brackets change length, Delete removes.`,
                        onPointerDown: (event) =>
                          beginDrag(event, scoreNote, 'move'),
                        onPointerMove: handleNotePointerMove,
                        onPointerUp: handleNotePointerUp,
                        onPointerCancel: handleNotePointerCancel,
                        onKeyDown: (event) => handleNoteKeyDown(event, scoreNote),
                        onFocus: () => setSelectedId(scoreNote.id),
                      }
                    : {})}
                />

                {/*
                  The resize grip, on the selected note only — showing one on
                  every note would cover short notes in targets and make plain
                  dragging unreliable. It straddles the end so the edge itself
                  is grabbable, capped against the note's width so a short note
                  keeps enough body left to drag.
                */}
                {editor && scoreNote && selected && (
                  <rect
                    className="piano-roll__handle"
                    x={x + width - Math.min(HANDLE_WIDTH_PX, width * 0.6) / 2}
                    y={geometry.yForMidi(midi) + 1}
                    width={Math.min(HANDLE_WIDTH_PX, width * 0.6)}
                    height={rowHeight - 2}
                    role="button"
                    aria-label={`Change length of ${midiToName(note.midi)}`}
                    onPointerDown={(event) =>
                      beginDrag(event, scoreNote, 'resize')
                    }
                    onPointerMove={handleNotePointerMove}
                    onPointerUp={handleNotePointerUp}
                    onPointerCancel={handleNotePointerCancel}
                  />
                )}
              </g>
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
              Drag notes to move them. Select one to drag its end and change
              its length. Double-click empty space to add a note.
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
