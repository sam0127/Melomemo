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

function renderRow(props: Partial<Parameters<typeof MemoRow>[0]> = {}) {
  const onRename = vi.fn();
  const memo = makeMemo();
  render(
    <ul>
      <MemoRow
        memo={memo}
        isCurrent={false}
        isPlaying={false}
        isTranscribing={false}
        repository={new InMemoryMemoRepository()}
        onTogglePlay={() => {}}
        onTranscribe={() => {}}
        onRename={onRename}
        onExport={() => {}}
        onDelete={() => {}}
        {...props}
      />
    </ul>,
  );
  return { onRename, memo };
}

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
