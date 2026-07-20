import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deleteDB } from 'idb';
import { createMemoFromCapture } from '../core/memoFactory.ts';
import type { CaptureInfo, CapturedAudio } from '../core/types.ts';
import { DB_NAME } from './db.ts';
import { IdbMemoRepository } from './memoRepository.ts';

function makeCapture(overrides: Partial<CaptureInfo> = {}): CaptureInfo {
  return {
    mimeType: 'audio/webm;codecs=opus',
    requestedMimeType: 'audio/webm;codecs=opus',
    durationMs: 4200,
    byteLength: 1024,
    sampleRate: 48000,
    channelCount: 1,
    dsp: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
    deviceLabel: 'Test mic',
    capturedAt: Date.now(),
    platform: 'desktop',
    terminatedBy: 'user',
    ...overrides,
  };
}

function makeCaptured(sizeBytes = 1024, overrides: Partial<CaptureInfo> = {}): CapturedAudio {
  const data = new ArrayBuffer(sizeBytes);
  // Non-zero content so the hash is meaningful rather than a constant.
  new Uint8Array(data).fill(7);
  return { data, capture: makeCapture({ byteLength: sizeBytes, ...overrides }) };
}

/** Deep scan for binary payloads, used to prove the list query stays light. */
function containsBinary(value: unknown, seen = new Set<unknown>()): boolean {
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return true;
  if (value === null || typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  return Object.values(value).some((child) => containsBinary(child, seen));
}

describe('IdbMemoRepository', () => {
  let repository: IdbMemoRepository;

  beforeEach(async () => {
    await deleteDB(DB_NAME);
    repository = new IdbMemoRepository();
  });

  afterEach(() => {
    // An open connection blocks the next deleteDB indefinitely.
    repository.close();
  });

  it('round-trips a memo and its audio', async () => {
    const { memo, audio } = await createMemoFromCapture(makeCaptured());

    const saved = await repository.saveMemo(memo, audio);
    expect(saved.ok).toBe(true);

    const listed = await repository.listMemos();
    expect(listed.ok && listed.value).toHaveLength(1);

    const fetched = await repository.getAudio(memo.id);
    expect(fetched.ok).toBe(true);
    if (fetched.ok) {
      expect(fetched.value.byteLength).toBe(1024);
      expect(fetched.value.mimeType).toBe('audio/webm;codecs=opus');
    }
  });

  it('keeps audio out of the list query', async () => {
    // The load-bearing reason metadata and audio live in separate stores: a
    // list of 200 memos must not pull their audio into memory to render.
    const { memo, audio } = await createMemoFromCapture(makeCaptured(64 * 1024));
    await repository.saveMemo(memo, audio);

    const listed = await repository.listMemos();
    expect(listed.ok).toBe(true);
    if (listed.ok) {
      expect(containsBinary(listed.value)).toBe(false);
    }
  });

  it('lists newest first', async () => {
    const older = await createMemoFromCapture(
      makeCaptured(128, { capturedAt: 1_000 }),
    );
    const newer = await createMemoFromCapture(
      makeCaptured(128, { capturedAt: 9_000 }),
    );
    await repository.saveMemo(older.memo, older.audio);
    await repository.saveMemo(newer.memo, newer.audio);

    const listed = await repository.listMemos();
    expect(listed.ok).toBe(true);
    if (listed.ok) {
      expect(listed.value.map((m) => m.id)).toEqual([
        newer.memo.id,
        older.memo.id,
      ]);
    }
  });

  it('records the DSP settings the browser actually applied', async () => {
    // Requesting the processors off does not mean they are off; what gets
    // persisted has to be the reported reality so later analysis can trust it.
    const captured = makeCaptured(256, {
      dsp: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: null,
      },
    });
    const { memo, audio } = await createMemoFromCapture(captured);
    await repository.saveMemo(memo, audio);

    const fetched = await repository.getMemo(memo.id);
    expect(fetched.ok).toBe(true);
    if (fetched.ok) {
      expect(fetched.value.capture.dsp).toEqual({
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: null,
      });
    }
  });

  it('deletes the memo and its audio together', async () => {
    const { memo, audio } = await createMemoFromCapture(makeCaptured());
    await repository.saveMemo(memo, audio);

    const deleted = await repository.deleteMemo(memo.id);
    expect(deleted.ok).toBe(true);

    const listed = await repository.listMemos();
    expect(listed.ok && listed.value).toHaveLength(0);

    // An orphaned audio row would be invisible dead weight in storage.
    const audioAfter = await repository.getAudio(memo.id);
    expect(audioAfter.ok).toBe(false);
  });

  it('reports a missing memo as not-found rather than throwing', async () => {
    const result = await repository.getMemo('does-not-exist');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('not-found');
  });

  it('renames without disturbing the recording', async () => {
    const { memo, audio } = await createMemoFromCapture(makeCaptured());
    await repository.saveMemo(memo, audio);

    const renamed = await repository.updateMemo(memo.id, { title: 'Chorus idea' });
    expect(renamed.ok).toBe(true);
    if (renamed.ok) expect(renamed.value.title).toBe('Chorus idea');

    const fetched = await repository.getAudio(memo.id);
    expect(fetched.ok).toBe(true);
  });

  it('hands back an orphaned scratch session once, then forgets it', async () => {
    await repository.saveScratch({
      sessionId: 's1',
      startedAt: 123,
      mimeType: 'audio/webm',
      durationMs: 2500,
      chunks: [new Blob([new Uint8Array([1, 2, 3])])],
    });

    const first = await repository.takeScratch();
    expect(first?.sessionId).toBe('s1');

    // Taken sessions are cleared, so a recovered take cannot be duplicated on
    // the next launch.
    const second = await repository.takeScratch();
    expect(second).toBeNull();
  });
});
