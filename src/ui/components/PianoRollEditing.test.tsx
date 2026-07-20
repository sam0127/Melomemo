import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { ScoreNote } from '../../core/types.ts';
import { createRollGeometry } from '../pianoRollGeometry.ts';
import { PianoRoll, type RollEditor } from './PianoRoll.tsx';

/**
 * Editing gestures, pinned down in jsdom. Pointer capture does not exist
 * there — the component guards for it — but pointer events themselves fire,
 * which is enough to walk a drag through threshold, preview, and commit.
 */

const NOTES: ScoreNote[] = [
  { id: 'a', midi: 60, startMs: 0, durationMs: 500, centsDeviation: 0, confidence: 0.9 },
  { id: 'b', midi: 64, startMs: 1000, durationMs: 500, centsDeviation: 0, confidence: 0.9 },
];
const DURATION_MS = 4000;

function renderRoll(notes: ScoreNote[] = NOTES) {
  const editor: RollEditor = {
    onMove: vi.fn(),
    onResize: vi.fn(),
    onCreate: vi.fn(),
    onDelete: vi.fn(),
  };
  const utils = render(
    <PianoRoll
      notes={notes}
      durationMs={DURATION_MS}
      transport="idle"
      editor={editor}
    />,
  );
  return { editor, ...utils };
}

function noteRect(name: RegExp): SVGRectElement {
  return screen.getByRole('button', { name }) as unknown as SVGRectElement;
}

describe('keyboard editing', () => {
  it('exposes each note as a labelled, focusable control', () => {
    renderRoll();
    expect(noteRect(/Note C4/)).toBeInTheDocument();
    expect(noteRect(/Note E4/)).toBeInTheDocument();
  });

  it('moves a semitone with the vertical arrows', async () => {
    const user = userEvent.setup();
    const { editor } = renderRoll();

    noteRect(/Note C4/).focus();
    await user.keyboard('{ArrowUp}');
    expect(editor.onMove).toHaveBeenCalledWith('a', 61, 0);

    await user.keyboard('{ArrowDown}');
    // Handlers read the note from props, which have not changed in this
    // render, so the second nudge is relative to the original values.
    expect(editor.onMove).toHaveBeenCalledWith('a', 59, 0);
  });

  it('nudges in time with the horizontal arrows, finer with Shift', async () => {
    const user = userEvent.setup();
    const { editor } = renderRoll();

    noteRect(/Note E4/).focus();
    await user.keyboard('{ArrowRight}');
    expect(editor.onMove).toHaveBeenCalledWith('b', 64, 1050);

    await user.keyboard('{Shift>}{ArrowLeft}{/Shift}');
    expect(editor.onMove).toHaveBeenCalledWith('b', 64, 990);
  });

  it('never nudges a note to before the recording starts', async () => {
    const user = userEvent.setup();
    const { editor } = renderRoll();

    noteRect(/Note C4/).focus();
    await user.keyboard('{ArrowLeft}');
    expect(editor.onMove).toHaveBeenCalledWith('a', 60, 0);
  });

  it('deletes with the Delete key', async () => {
    const user = userEvent.setup();
    const { editor } = renderRoll();

    noteRect(/Note C4/).focus();
    await user.keyboard('{Delete}');
    expect(editor.onDelete).toHaveBeenCalledWith('a');
  });
});

describe('pointer editing', () => {
  it('commits a drag as one move, through the same geometry the renderer uses', () => {
    const { editor } = renderRoll();
    const geometry = createRollGeometry(NOTES, DURATION_MS);
    const rect = noteRect(/Note C4/);

    // Two rows up, and right by the width of 500ms.
    const dx = geometry.widthForMs(500);
    const dy = -2 * geometry.rowHeight;

    fireEvent.pointerDown(rect, { button: 0, pointerId: 1, clientX: 10, clientY: 50 });
    fireEvent.pointerMove(rect, { pointerId: 1, clientX: 10 + dx, clientY: 50 + dy });
    fireEvent.pointerUp(rect, { pointerId: 1, clientX: 10 + dx, clientY: 50 + dy });

    expect(editor.onMove).toHaveBeenCalledTimes(1);
    const [id, midi, startMs] = vi.mocked(editor.onMove).mock.calls[0]!;
    expect(id).toBe('a');
    expect(midi).toBe(62);
    expect(startMs).toBeCloseTo(500, 0);
  });

  it('treats a press without movement as selection, not an edit', () => {
    const { editor } = renderRoll();
    const rect = noteRect(/Note C4/);

    fireEvent.pointerDown(rect, { button: 0, pointerId: 1, clientX: 10, clientY: 50 });
    // Under the threshold: a finger can wobble a pixel without meaning "move".
    fireEvent.pointerMove(rect, { pointerId: 1, clientX: 12, clientY: 51 });
    fireEvent.pointerUp(rect, { pointerId: 1, clientX: 12, clientY: 51 });

    expect(editor.onMove).not.toHaveBeenCalled();
    // Selection surfaces the touch delete affordance.
    expect(screen.getByRole('button', { name: 'Delete note' })).toBeInTheDocument();
  });

  it('deletes the selected note from the toolbar button', async () => {
    const user = userEvent.setup();
    const { editor } = renderRoll();
    const rect = noteRect(/Note E4/);

    fireEvent.pointerDown(rect, { button: 0, pointerId: 1, clientX: 10, clientY: 50 });
    fireEvent.pointerUp(rect, { pointerId: 1, clientX: 10, clientY: 50 });

    await user.click(screen.getByRole('button', { name: 'Delete note' }));
    expect(editor.onDelete).toHaveBeenCalledWith('b');
  });

  it('still drags when pointer capture is refused', () => {
    /*
     * setPointerCapture throws NotFoundError whenever the browser does not
     * consider the id an active pointer. It used to be called unguarded, so
     * the throw aborted the handler before the drag was registered and
     * dragging died silently. Capture only keeps events flowing when the
     * pointer leaves the note — losing it must not lose the drag.
     */
    const { editor } = renderRoll();
    const geometry = createRollGeometry(NOTES, DURATION_MS);
    const rect = noteRect(/Note C4/);
    Object.defineProperty(rect, 'setPointerCapture', {
      value: () => {
        throw new DOMException('No active pointer', 'NotFoundError');
      },
      configurable: true,
    });

    const dx = geometry.widthForMs(500);
    fireEvent.pointerDown(rect, { button: 0, pointerId: 1, clientX: 10, clientY: 50 });
    fireEvent.pointerMove(rect, { pointerId: 1, clientX: 10 + dx, clientY: 50 });
    fireEvent.pointerUp(rect, { pointerId: 1, clientX: 10 + dx, clientY: 50 });

    expect(editor.onMove).toHaveBeenCalledTimes(1);
  });

  it('creates a note where empty space is double-clicked', () => {
    const { editor, container } = renderRoll();
    // Not querySelector('svg'): the pitch-label gutter is an svg too, and it
    // comes first in the DOM.
    const svg = container.querySelector('.piano-roll__svg')!;
    const geometry = createRollGeometry(NOTES, DURATION_MS);

    // jsdom reports a zero rect, so client coords are svg coords directly.
    const x = geometry.xForMs(2000);
    const y = geometry.yForMidi(62) + geometry.rowHeight / 2;
    fireEvent.dblClick(svg, { clientX: x, clientY: y });

    expect(editor.onCreate).toHaveBeenCalledTimes(1);
    const [midi, startMs] = vi.mocked(editor.onCreate).mock.calls[0]!;
    expect(midi).toBe(62);
    expect(startMs).toBeCloseTo(2000, 0);
  });

  describe('resizing', () => {
    function selectNote(name: RegExp) {
      const rect = noteRect(name);
      fireEvent.pointerDown(rect, { button: 0, pointerId: 1, clientX: 10, clientY: 50 });
      fireEvent.pointerUp(rect, { pointerId: 1, clientX: 10, clientY: 50 });
      return rect;
    }

    it('offers no resize grip until a note is selected', () => {
      const { container } = renderRoll();
      // A grip on every note would blanket short notes in targets and make
      // ordinary dragging unreliable.
      expect(container.querySelector('.piano-roll__handle')).toBeNull();

      selectNote(/Note C4/);
      expect(container.querySelector('.piano-roll__handle')).not.toBeNull();
    });

    it('lengthens the note when its end is dragged right', () => {
      const { editor, container } = renderRoll();
      const geometry = createRollGeometry(NOTES, DURATION_MS);
      selectNote(/Note C4/);

      const handle = container.querySelector('.piano-roll__handle')!;
      const dx = geometry.widthForMs(300);
      fireEvent.pointerDown(handle, { button: 0, pointerId: 2, clientX: 100, clientY: 50 });
      fireEvent.pointerMove(handle, { pointerId: 2, clientX: 100 + dx, clientY: 50 });
      fireEvent.pointerUp(handle, { pointerId: 2, clientX: 100 + dx, clientY: 50 });

      expect(editor.onResize).toHaveBeenCalledTimes(1);
      const [id, durationMs] = vi.mocked(editor.onResize).mock.calls[0]!;
      expect(id).toBe('a');
      expect(durationMs).toBeCloseTo(800, 0); // 500 + 300
      // Resizing must never be mistaken for a move.
      expect(editor.onMove).not.toHaveBeenCalled();
    });

    it('shortens when dragged left, and never past the floor', () => {
      const { editor, container } = renderRoll();
      const geometry = createRollGeometry(NOTES, DURATION_MS);
      selectNote(/Note C4/);

      const handle = container.querySelector('.piano-roll__handle')!;
      // Far further left than the note is long.
      const dx = -geometry.widthForMs(5000);
      fireEvent.pointerDown(handle, { button: 0, pointerId: 2, clientX: 100, clientY: 50 });
      fireEvent.pointerMove(handle, { pointerId: 2, clientX: 100 + dx, clientY: 50 });
      fireEvent.pointerUp(handle, { pointerId: 2, clientX: 100 + dx, clientY: 50 });

      const [, durationMs] = vi.mocked(editor.onResize).mock.calls[0]!;
      expect(durationMs).toBe(40);
    });

    it('resizes from the keyboard with the bracket keys', async () => {
      const user = userEvent.setup();
      const { editor } = renderRoll();

      noteRect(/Note C4/).focus();
      // Brackets rather than Alt+Arrow, which is browser back/forward.
      // "[[" is user-event's escape for a literal "[", which otherwise opens
      // a key descriptor.
      await user.keyboard(']');
      expect(editor.onResize).toHaveBeenCalledWith('a', 550);

      await user.keyboard('[[');
      expect(editor.onResize).toHaveBeenCalledWith('a', 450);

      await user.keyboard('{Shift>}]{/Shift}');
      expect(editor.onResize).toHaveBeenCalledWith('a', 510);
    });

    it('advertises the length keys on the note itself', () => {
      renderRoll();
      // The grip is invisible to a screen reader user, so the keys have to be
      // announced with the note.
      expect(
        noteRect(/Note C4/).getAttribute('aria-label'),
      ).toContain('brackets change length');
    });
  });

  /**
   * Regression cover for a bug found on an Android device: notes could not be
   * dragged at all. `touch-action` is only hit-tested against the top-level
   * <svg>, so the `touch-action: none` that had been set on each note rect was
   * inert, and Chrome claimed every drag — vertical ones as pull-to-refresh,
   * horizontal ones as a pan.
   */
  describe('touch gestures', () => {
    function dispatchTouch(target: Element, type: string): boolean {
      const event = new Event(type, { bubbles: true, cancelable: true });
      target.dispatchEvent(event);
      return event.defaultPrevented;
    }

    it('cancels the browser gesture when a touch starts on a note', () => {
      renderRoll();
      const rect = noteRect(/Note C4/);
      // Cancelling at touchstart is the only moment that works; by touchmove
      // the browser has already committed to scrolling.
      expect(dispatchTouch(rect, 'touchstart')).toBe(true);
    });

    it('cancels the browser gesture on the resize grip too', () => {
      const { container } = renderRoll();
      const rect = noteRect(/Note C4/);
      fireEvent.pointerDown(rect, { button: 0, pointerId: 1, clientX: 10, clientY: 50 });
      fireEvent.pointerUp(rect, { pointerId: 1, clientX: 10, clientY: 50 });

      // Without the grip in the selector, resize drags would be claimed as
      // scrolls on Android exactly as note drags used to be.
      const handle = container.querySelector('.piano-roll__handle')!;
      expect(dispatchTouch(handle, 'touchstart')).toBe(true);
    });

    it('leaves touches on empty space alone so the roll still scrolls', () => {
      const { container } = renderRoll();
      const background = container.querySelector('.piano-roll__row')!;
      expect(dispatchTouch(background, 'touchstart')).toBe(false);
    });

    it('does not interfere when the roll is read-only', () => {
      const { container } = render(
        <PianoRoll notes={NOTES} durationMs={DURATION_MS} transport="idle" />,
      );
      const rect = container.querySelector('.piano-roll__note')!;
      // Nothing is draggable, so trapping the touch would only make the chart
      // harder to scroll.
      expect(dispatchTouch(rect, 'touchstart')).toBe(false);
    });
  });

  it('still renders an editable surface when the score is empty', () => {
    const { container } = renderRoll([]);
    // A failed transcription must leave somewhere to build a melody by hand.
    expect(container.querySelector('svg')).toBeInTheDocument();
  });
});
