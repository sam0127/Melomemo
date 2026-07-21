import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { Memo } from '../../core/types.ts';
import { InMemoryMemoRepository } from '../../storage/memoRepository.ts';
import { MemoRow } from './MemoRow.tsx';

function makeMemo(overrides: Partial<Memo> = {}): Memo {
  return {
    id: 'memo-1',
    schemaVersion: 1,
    title: 'Chorus idea',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    audioHash: 'abc',
    capture: {
      mimeType: 'audio/webm;codecs=opus',
      requestedMimeType: 'audio/webm;codecs=opus',
      durationMs: 42_000,
      byteLength: 16,
      sampleRate: 48000,
      channelCount: 1,
      dsp: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      deviceLabel: null,
      capturedAt: 1_700_000_000_000,
      platform: 'desktop',
      terminatedBy: 'user',
    },
    analysisState: null,
    currentScoreId: null,
    ...overrides,
  };
}

/**
 * Which memo is open is owned by the list, so the row is a controlled
 * component. This wrapper supplies that state the way the list does.
 */
function OpenableRow(props: Partial<Parameters<typeof MemoRow>[0]>) {
  const [open, setOpen] = useState(false);
  return (
    <ul>
      <MemoRow
        {...(props as Parameters<typeof MemoRow>[0])}
        isOpen={open}
        onToggleOpen={setOpen}
      />
    </ul>
  );
}

function renderRow(props: Partial<Parameters<typeof MemoRow>[0]> = {}) {
  const onRename = vi.fn();
  const memo = makeMemo();
  const utils = render(
    <OpenableRow
      memo={memo}
      isCurrent={false}
      isPlaying={false}
      isTranscribing={false}
      repository={new InMemoryMemoRepository()}
      notePlayback={{
        statusFor: () => 'idle',
        toggle: () => {},
        stop: () => {},
        beginScrub: () => {},
        endScrub: () => {},
        positionMs: () => 0,
        previewPitch: () => {},
        syncNotes: () => {},
      }}
      onTogglePlay={() => {}}
      onTranscribe={() => {}}
      onRename={onRename}
      onExport={() => {}}
      onDelete={() => {}}
      {...props}
    />,
  );
  return { onRename, memo, ...utils };
}

/** Renders with the open state supplied from outside, as the list does. */
function renderRowControlled(
  props: Pick<Parameters<typeof MemoRow>[0], 'isOpen' | 'onToggleOpen'>,
) {
  return render(
    <ul>
      <MemoRow
        memo={makeMemo()}
        isCurrent={false}
        isPlaying={false}
        isTranscribing={false}
        repository={new InMemoryMemoRepository()}
        notePlayback={{
          statusFor: () => 'idle',
          toggle: () => {},
          stop: () => {},
          beginScrub: () => {},
          endScrub: () => {},
          positionMs: () => 0,
          previewPitch: () => {},
          syncNotes: () => {},
        }}
        onTogglePlay={() => {}}
        onTranscribe={() => {}}
        onRename={() => {}}
        onExport={() => {}}
        onDelete={() => {}}
        {...props}
      />
    </ul>,
  );
}

describe('opening a memo', () => {
  it('exposes the title as a control carrying the expanded state', () => {
    renderRow();
    // Tapping the row is a pointer convenience; this is the control keyboard
    // and screen-reader users actually operate.
    const title = screen.getByRole('button', { name: 'Chorus idea' });
    expect(title).toHaveAttribute('aria-expanded', 'false');
  });

  it('toggles when the row itself is clicked', async () => {
    const user = userEvent.setup();
    const { container } = renderRow();
    const row = container.querySelector('.memo-row')!;

    await user.click(row);
    expect(screen.getByRole('button', { name: 'Chorus idea' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });

  it('reports opening and closing to its owner rather than deciding alone', async () => {
    // The list owns which memo is open, so that opening one closes the rest.
    const user = userEvent.setup();
    const onToggleOpen = vi.fn();
    renderRowControlled({ isOpen: false, onToggleOpen });

    await user.click(screen.getByRole('button', { name: 'Chorus idea' }));
    expect(onToggleOpen).toHaveBeenCalledWith(true);
  });

  it('shows its transcription only when the owner says it is open', () => {
    renderRowControlled({ isOpen: true, onToggleOpen: () => {} });
    expect(screen.getByRole('button', { name: 'Chorus idea' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });

  it('does not toggle when a control inside the row is used', async () => {
    const user = userEvent.setup();
    renderRow();

    // Playing a memo, or renaming it, must not also open it — otherwise every
    // action in the row has a second, unasked-for effect.
    await user.click(screen.getByRole('button', { name: 'Play Chorus idea' }));
    expect(screen.getByRole('button', { name: 'Chorus idea' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );

    await user.click(screen.getByRole('button', { name: 'Export Chorus idea' }));
    expect(screen.getByRole('button', { name: 'Chorus idea' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });
});

describe('MemoRow renaming', () => {
  it('names every control after its memo', async () => {
    renderRow();
    // Rows are otherwise indistinguishable to a screen reader — each would
    // just announce as "Rename".
    expect(
      screen.getByRole('button', { name: 'Rename Chorus idea' }),
    ).toBeInTheDocument();
  });

  it('opens an editor focused on the current name', async () => {
    const user = userEvent.setup();
    renderRow();

    await user.click(screen.getByRole('button', { name: 'Rename Chorus idea' }));

    const input = screen.getByRole('textbox', { name: 'Memo name' });
    expect(input).toHaveValue('Chorus idea');
    // Focus has to move into the editor, or a keyboard user has to hunt for it.
    expect(input).toHaveFocus();
  });

  it('commits on Enter', async () => {
    // Implicit form submission — the browser automation harness cannot produce
    // a well-formed Enter, so this is the only place it is genuinely covered.
    const user = userEvent.setup();
    const { onRename, memo } = renderRow();

    await user.click(screen.getByRole('button', { name: 'Rename Chorus idea' }));
    await user.clear(screen.getByRole('textbox', { name: 'Memo name' }));
    await user.type(screen.getByRole('textbox', { name: 'Memo name' }), 'Bridge{Enter}');

    expect(onRename).toHaveBeenCalledWith(memo, 'Bridge');
  });

  it('commits when Save is pressed', async () => {
    const user = userEvent.setup();
    const { onRename, memo } = renderRow();

    await user.click(screen.getByRole('button', { name: 'Rename Chorus idea' }));
    await user.clear(screen.getByRole('textbox', { name: 'Memo name' }));
    await user.type(screen.getByRole('textbox', { name: 'Memo name' }), 'Bridge');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(onRename).toHaveBeenCalledWith(memo, 'Bridge');
  });

  it('discards the edit on Escape and restores focus', async () => {
    const user = userEvent.setup();
    const { onRename } = renderRow();

    await user.click(screen.getByRole('button', { name: 'Rename Chorus idea' }));
    await user.type(screen.getByRole('textbox', { name: 'Memo name' }), 'nonsense');
    await user.keyboard('{Escape}');

    expect(onRename).not.toHaveBeenCalled();
    // Focus must return to the trigger rather than falling to the document.
    expect(
      screen.getByRole('button', { name: 'Rename Chorus idea' }),
    ).toHaveFocus();
  });

  it('refuses to save a blank name', async () => {
    const user = userEvent.setup();
    const { onRename } = renderRow();

    await user.click(screen.getByRole('button', { name: 'Rename Chorus idea' }));
    await user.clear(screen.getByRole('textbox', { name: 'Memo name' }));
    await user.type(screen.getByRole('textbox', { name: 'Memo name' }), '   ');

    // A blank title would leave the row with nothing to identify or announce.
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();

    await user.keyboard('{Enter}');
    expect(onRename).not.toHaveBeenCalled();
  });

  it('trims surrounding whitespace', async () => {
    const user = userEvent.setup();
    const { onRename, memo } = renderRow();

    await user.click(screen.getByRole('button', { name: 'Rename Chorus idea' }));
    await user.clear(screen.getByRole('textbox', { name: 'Memo name' }));
    await user.type(screen.getByRole('textbox', { name: 'Memo name' }), '  Bridge  {Enter}');

    expect(onRename).toHaveBeenCalledWith(memo, 'Bridge');
  });

  it('does not write when the name is unchanged', async () => {
    const user = userEvent.setup();
    const { onRename } = renderRow();

    await user.click(screen.getByRole('button', { name: 'Rename Chorus idea' }));
    await user.keyboard('{Enter}');

    // Avoids a pointless write and a misleading "renamed" announcement.
    expect(onRename).not.toHaveBeenCalled();
  });
});
