import type { AudioAsset, Memo, MemoId } from '../core/types.ts';
import { MEMO_SCHEMA_VERSION } from '../core/types.ts';
import {
  appError,
  err,
  failure,
  ok,
  type AppError,
  type Result,
} from '../core/result.ts';
import {
  openMelomemoDB,
  type MelomemoDatabase,
  type ScratchSession,
} from './db.ts';

/**
 * The only module that talks to IndexedDB.
 *
 * Exposed as an interface with an IDB implementation and an in-memory fake so
 * UI and hook tests never need a real database. Nothing outside this directory
 * imports `idb`.
 */
export interface MemoRepository {
  /** Metadata only — never touches the audio store. Newest first. */
  listMemos(): Promise<Result<Memo[]>>;
  getMemo(id: MemoId): Promise<Result<Memo>>;
  /** Loads audio bytes lazily, at playback or export time. */
  getAudio(id: MemoId): Promise<Result<AudioAsset>>;
  /** Writes metadata and audio atomically. */
  saveMemo(memo: Memo, audio: AudioAsset): Promise<Result<void>>;
  updateMemo(
    id: MemoId,
    patch: Partial<Pick<Memo, 'title' | 'tags'>>,
  ): Promise<Result<Memo>>;
  deleteMemo(id: MemoId): Promise<Result<void>>;
  /**
   * Records progress on the take currently being captured. Best effort — a
   * failure here is swallowed, because losing the snapshot is survivable but
   * interrupting a live recording to report it is not.
   */
  saveScratch(session: ScratchSession): Promise<void>;
  /** Reads any orphaned session and clears it in the same pass. */
  takeScratch(): Promise<ScratchSession | null>;
  /** Discards partial recordings left behind by a crash or forced close. */
  clearScratch(): Promise<void>;
}

/**
 * Maps storage failures onto the app error union.
 *
 * Quota exhaustion and an unavailable database are the two the user can
 * actually do something about, so they get distinguished; everything else
 * keeps its cause for debugging.
 */
function toStorageError(e: unknown, message: string): AppError {
  const name = e instanceof Error ? e.name : '';
  if (name === 'QuotaExceededError') {
    return appError('quota-exceeded', 'Device storage is full.', e);
  }
  if (
    name === 'InvalidStateError' ||
    name === 'UnknownError' ||
    name === 'SecurityError'
  ) {
    return appError('storage-unavailable', 'Storage is unavailable.', e);
  }
  return appError('unknown', message, e);
}

/**
 * Records written by an older build are normalized on read rather than in a
 * schema migration, so a version bump never has to rewrite every row.
 */
function migrateMemo(memo: Memo): Memo {
  if (memo.schemaVersion === MEMO_SCHEMA_VERSION) return memo;
  // Only version 1 exists so far; future shape changes get their step here.
  return { ...memo, schemaVersion: MEMO_SCHEMA_VERSION };
}

export class IdbMemoRepository implements MemoRepository {
  #dbPromise: Promise<MelomemoDatabase> | null = null;

  #db(): Promise<MelomemoDatabase> {
    // Opened lazily and cached: constructing the repository must not fail in
    // environments where IndexedDB is blocked (iOS Private Browsing), so the
    // failure surfaces on first use as a handled Result instead.
    this.#dbPromise ??= openMelomemoDB({
      // Yield to a newer tab that wants to upgrade. The next call reopens
      // against the new version, so this is invisible to callers.
      onBlocking: () => this.close(),
    });
    return this.#dbPromise;
  }

  /**
   * Drops the cached connection. Safe to call at any time — the next
   * operation transparently reopens.
   */
  close(): void {
    const pending = this.#dbPromise;
    this.#dbPromise = null;
    void pending
      ?.then((db) => db.close())
      .catch(() => {
        // Already closed or never opened; nothing to release.
      });
  }

  async listMemos(): Promise<Result<Memo[]>> {
    try {
      const db = await this.#db();
      const memos = await db.getAllFromIndex('memos', 'by-createdAt');
      const live = memos
        .filter((m) => m.deletedAt == null)
        .map(migrateMemo)
        .reverse(); // index is ascending; the list shows newest first
      return ok(live);
    } catch (e) {
      return err(toStorageError(e, 'Could not load memos.'));
    }
  }

  async getMemo(id: MemoId): Promise<Result<Memo>> {
    try {
      const db = await this.#db();
      const memo = await db.get('memos', id);
      if (!memo) return failure('not-found', `No memo with id ${id}.`);
      return ok(migrateMemo(memo));
    } catch (e) {
      return err(toStorageError(e, 'Could not load the memo.'));
    }
  }

  async getAudio(id: MemoId): Promise<Result<AudioAsset>> {
    try {
      const db = await this.#db();
      const asset = await db.get('audio', id);
      if (!asset) return failure('not-found', `No audio for memo ${id}.`);
      return ok(asset);
    } catch (e) {
      return err(toStorageError(e, 'Could not load the recording.'));
    }
  }

  async saveMemo(memo: Memo, audio: AudioAsset): Promise<Result<void>> {
    try {
      const db = await this.#db();
      // One transaction over both stores: a memo row without its audio would
      // render as a playable item that cannot play.
      const tx = db.transaction(['memos', 'audio'], 'readwrite');
      await Promise.all([
        tx.objectStore('memos').put(memo),
        tx.objectStore('audio').put(audio),
        tx.done,
      ]);
      return ok(undefined);
    } catch (e) {
      return err(toStorageError(e, 'Could not save the recording.'));
    }
  }

  async updateMemo(
    id: MemoId,
    patch: Partial<Pick<Memo, 'title' | 'tags'>>,
  ): Promise<Result<Memo>> {
    try {
      const db = await this.#db();
      const tx = db.transaction('memos', 'readwrite');
      const existing = await tx.store.get(id);
      if (!existing) {
        await tx.done;
        return failure('not-found', `No memo with id ${id}.`);
      }
      const updated: Memo = { ...existing, ...patch, updatedAt: Date.now() };
      await tx.store.put(updated);
      await tx.done;
      return ok(updated);
    } catch (e) {
      return err(toStorageError(e, 'Could not update the memo.'));
    }
  }

  async deleteMemo(id: MemoId): Promise<Result<void>> {
    try {
      const db = await this.#db();
      // Analyses and scores are removed too so a future re-record of the same
      // id can never inherit a previous take's derived data.
      const tx = db.transaction(
        ['memos', 'audio', 'analyses', 'scores'],
        'readwrite',
      );
      const analyses = await tx
        .objectStore('analyses')
        .index('by-memoId')
        .getAllKeys(id);
      const scores = await tx
        .objectStore('scores')
        .index('by-memoId')
        .getAllKeys(id);

      await Promise.all([
        tx.objectStore('memos').delete(id),
        tx.objectStore('audio').delete(id),
        ...analyses.map((key) => tx.objectStore('analyses').delete(key)),
        ...scores.map((key) => tx.objectStore('scores').delete(key)),
        tx.done,
      ]);
      return ok(undefined);
    } catch (e) {
      return err(toStorageError(e, 'Could not delete the memo.'));
    }
  }

  async saveScratch(session: ScratchSession): Promise<void> {
    try {
      const db = await this.#db();
      await db.put('scratch', session);
    } catch {
      // Swallowed deliberately. This runs once a second during a live
      // recording; surfacing an error would interrupt the take it exists to
      // protect. Private Browsing rejects Blob writes outright, and losing
      // only the crash-recovery snapshot there is the correct tradeoff.
    }
  }

  async takeScratch(): Promise<ScratchSession | null> {
    try {
      const db = await this.#db();
      const sessions = await db.getAll('scratch');
      await db.clear('scratch');
      // Only ever one recording at a time; if several somehow survived, the
      // newest is the only one worth recovering.
      return (
        sessions.sort((a, b) => b.startedAt - a.startedAt)[0] ?? null
      );
    } catch {
      return null;
    }
  }

  async clearScratch(): Promise<void> {
    try {
      const db = await this.#db();
      await db.clear('scratch');
    } catch {
      // Best effort: leftover scratch rows are harmless, and failing to clear
      // them must never block app startup.
    }
  }
}

/** In-memory implementation for tests. Same contract, no IndexedDB. */
export class InMemoryMemoRepository implements MemoRepository {
  #memos = new Map<MemoId, Memo>();
  #audio = new Map<MemoId, AudioAsset>();
  #scratch: ScratchSession | null = null;

  async listMemos(): Promise<Result<Memo[]>> {
    const live = [...this.#memos.values()]
      .filter((m) => m.deletedAt == null)
      .sort((a, b) => b.createdAt - a.createdAt);
    return ok(live);
  }

  async getMemo(id: MemoId): Promise<Result<Memo>> {
    const memo = this.#memos.get(id);
    return memo ? ok(memo) : failure('not-found', `No memo with id ${id}.`);
  }

  async getAudio(id: MemoId): Promise<Result<AudioAsset>> {
    const asset = this.#audio.get(id);
    return asset ? ok(asset) : failure('not-found', `No audio for memo ${id}.`);
  }

  async saveMemo(memo: Memo, audio: AudioAsset): Promise<Result<void>> {
    this.#memos.set(memo.id, memo);
    this.#audio.set(audio.memoId, audio);
    return ok(undefined);
  }

  async updateMemo(
    id: MemoId,
    patch: Partial<Pick<Memo, 'title' | 'tags'>>,
  ): Promise<Result<Memo>> {
    const existing = this.#memos.get(id);
    if (!existing) return failure('not-found', `No memo with id ${id}.`);
    const updated: Memo = { ...existing, ...patch, updatedAt: Date.now() };
    this.#memos.set(id, updated);
    return ok(updated);
  }

  async deleteMemo(id: MemoId): Promise<Result<void>> {
    this.#memos.delete(id);
    this.#audio.delete(id);
    return ok(undefined);
  }

  async saveScratch(session: ScratchSession): Promise<void> {
    this.#scratch = session;
  }

  async takeScratch(): Promise<ScratchSession | null> {
    const session = this.#scratch;
    this.#scratch = null;
    return session;
  }

  async clearScratch(): Promise<void> {
    this.#scratch = null;
  }
}
