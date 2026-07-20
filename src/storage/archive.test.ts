import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoFromCapture } from '../core/memoFactory.ts';
import type { CaptureInfo, CapturedAudio } from '../core/types.ts';
import { exportArchive, importArchive } from './archive.ts';
import { InMemoryMemoRepository } from './memoRepository.ts';

function makeCaptured(seed: number, bytes = 512): CapturedAudio {
  const data = new ArrayBuffer(bytes);
  new Uint8Array(data).fill(seed);
  const capture: CaptureInfo = {
    mimeType: 'audio/webm;codecs=opus',
    requestedMimeType: 'audio/webm;codecs=opus',
    durationMs: 3000 + seed,
    byteLength: bytes,
    sampleRate: 48000,
    channelCount: 1,
    dsp: { echoCancellation: false, noiseSuppression: false, autoGainControl: null },
    deviceLabel: null,
    capturedAt: 1_700_000_000_000 + seed * 1000,
    platform: 'desktop',
    terminatedBy: 'user',
  };
  return { data, capture };
}

/**
 * Downloads are captured rather than performed: the archive's job is to
 * produce a file whose contents can be restored, and that is what gets
 * asserted.
 */
function captureDownload(): { file: () => File } {
  let captured: Blob | null = null;
  let name = '';

  vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
    captured = blob as Blob;
    return 'blob:mock';
  });
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    name = this.download;
  });

  return {
    file: () => new File([captured!], name, { type: 'application/json' }),
  };
}

describe('archive', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('round-trips memos through an export and back into an empty store', async () => {
    // This is the escape hatch from browser eviction and from iOS keeping
    // Safari and the installed app on separate storage, so the round trip has
    // to preserve enough to actually play the audio afterwards.
    const source = new InMemoryMemoRepository();
    const first = await createMemoFromCapture(makeCaptured(1));
    const second = await createMemoFromCapture(makeCaptured(2));
    await source.saveMemo(first.memo, first.audio);
    await source.saveMemo(second.memo, second.audio);

    const download = captureDownload();
    const exported = await exportArchive(source);
    expect(exported.ok && exported.value).toBe(2);

    const target = new InMemoryMemoRepository();
    const imported = await importArchive(target, download.file());
    expect(imported.ok).toBe(true);
    if (imported.ok) expect(imported.value.imported).toBe(2);

    const listed = await target.listMemos();
    expect(listed.ok && listed.value).toHaveLength(2);

    // The bytes themselves must survive base64, not just the metadata.
    const audio = await target.getAudio(first.memo.id);
    expect(audio.ok).toBe(true);
    if (audio.ok) {
      expect(audio.value.byteLength).toBe(512);
      expect(new Uint8Array(audio.value.data)[0]).toBe(1);
      expect(audio.value.mimeType).toBe('audio/webm;codecs=opus');
    }
  });

  it('preserves capture provenance across the round trip', async () => {
    const source = new InMemoryMemoRepository();
    const { memo, audio } = await createMemoFromCapture(makeCaptured(3));
    await source.saveMemo(memo, audio);

    const download = captureDownload();
    await exportArchive(source);

    const target = new InMemoryMemoRepository();
    await importArchive(target, download.file());

    const restored = await target.getMemo(memo.id);
    expect(restored.ok).toBe(true);
    if (restored.ok) {
      // Duration is measured at capture time and cannot be recovered from the
      // audio, so losing it here would be permanent.
      expect(restored.value.capture.durationMs).toBe(memo.capture.durationMs);
      expect(restored.value.audioHash).toBe(memo.audioHash);
      expect(restored.value.title).toBe(memo.title);
    }
  });

  it('skips memos that are already present instead of overwriting them', async () => {
    const repository = new InMemoryMemoRepository();
    const { memo, audio } = await createMemoFromCapture(makeCaptured(4));
    await repository.saveMemo(memo, audio);

    const download = captureDownload();
    await exportArchive(repository);

    // Importing a backup on top of itself must be a no-op, so a user restoring
    // twice never ends up with duplicates or loses newer edits.
    const result = await importArchive(repository, download.file());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.imported).toBe(0);
      expect(result.value.skipped).toBe(1);
    }
  });

  it('carries hand-edited notes through a round trip', async () => {
    // Edits cannot be recreated from the audio, unlike the analysis — losing
    // them to a backup would be the worst outcome the score layer allows.
    const source = new InMemoryMemoRepository();
    const { memo, audio } = await createMemoFromCapture(makeCaptured(7));
    await source.saveMemo(memo, audio);
    await source.saveScore({
      id: 'score-1',
      memoId: memo.id,
      createdAt: 1,
      updatedAt: 2,
      seededFromAnalysisId: 'analysis-1',
      userEdited: true,
      ppq: 480,
      tempoBpm: 120,
      notes: [
        { id: 'n1', midi: 67, startMs: 0, durationMs: 400, centsDeviation: 0, confidence: 1 },
      ],
    });

    const download = captureDownload();
    await exportArchive(source);

    const target = new InMemoryMemoRepository();
    await importArchive(target, download.file());

    const restored = await target.getScore(memo.id);
    expect(restored.ok).toBe(true);
    if (restored.ok) {
      expect(restored.value.notes[0]!.midi).toBe(67);
      expect(restored.value.userEdited).toBe(true);
    }
    const restoredMemo = await target.getMemo(memo.id);
    expect(restoredMemo.ok && restoredMemo.value.currentScoreId).toBe('score-1');
  });

  it('clears the analysis pointer on import so the memo can be transcribed', async () => {
    // Analyses are not exported. A memo still claiming one would read as
    // transcribed, show nothing, and offer no way to fix itself.
    const source = new InMemoryMemoRepository();
    const { memo, audio } = await createMemoFromCapture(makeCaptured(8));
    await source.saveMemo(
      {
        ...memo,
        analysisState: {
          currentAnalysisId: 'analysis-gone',
          algorithmId: 'mpm',
          algorithmVersion: '1.0.0',
          status: 'ok',
          updatedAt: 1,
        },
      },
      audio,
    );

    const download = captureDownload();
    await exportArchive(source);

    const target = new InMemoryMemoRepository();
    await importArchive(target, download.file());

    const restored = await target.getMemo(memo.id);
    expect(restored.ok && restored.value.analysisState).toBeNull();
    expect(restored.ok && restored.value.currentScoreId).toBeNull();
  });

  it('rejects a file that is not a Melomemo backup', async () => {
    const repository = new InMemoryMemoRepository();
    const file = new File(['{"hello":"world"}'], 'notes.json', {
      type: 'application/json',
    });

    const result = await importArchive(repository, file);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid-archive');
  });

  it('rejects malformed JSON without throwing', async () => {
    const repository = new InMemoryMemoRepository();
    const file = new File(['not json at all'], 'broken.json');

    const result = await importArchive(repository, file);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid-archive');
  });

  it('refuses an archive from a newer version of the app', async () => {
    const repository = new InMemoryMemoRepository();
    const file = new File(
      [JSON.stringify({ format: 'melomemo-archive', version: 99, entries: [] })],
      'future.json',
    );

    const result = await importArchive(repository, file);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid-archive');
  });

  it('reports having nothing to export rather than writing an empty file', async () => {
    const result = await exportArchive(new InMemoryMemoRepository());
    expect(result.ok).toBe(false);
  });
});
