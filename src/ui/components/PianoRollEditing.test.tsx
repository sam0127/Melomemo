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
    onCreate: vi.fn(),
    onDelete: vi.fn(),
  };
  const utils = render(
    <PianoRoll
      notes={notes}
      durationMs={DURATION_MS}
      isPlaying={false}
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

  it('creates a note where empty space is double-clicked', () => {
    const { editor, container } = renderRoll();
    const svg = container.querySelector('svg')!;
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

  it('still renders an editable surface when the score is empty', () => {
    const { container } = renderRoll([]);
    // A failed transcription must leave somewhere to build a melody by hand.
    expect(container.querySelector('svg')).toBeInTheDocument();
  });
});
