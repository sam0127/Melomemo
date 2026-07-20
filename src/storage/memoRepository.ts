import type {
  AnalysisRecord,
  AnalysisState,
  AudioAsset,
  Memo,
  MemoId,
  ScoreDocument,
} from '../core/types.ts';
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
   * Stores an analysis and points its memo at it, in one transaction. A memo
   * claiming an analysis id that does not exist would render as transcribed
   * but show nothing.
   */
  saveAnalysis(record: AnalysisRecord): Promise<Result<void>>;
  /** The analysis a memo currently points at, if any. */
  getAnalysis(memoId: MemoId): Promise<Result<AnalysisRecord>>;
  /** Records progress or failure without writing a result. */
  setAnalysisState(memoId: MemoId, state: AnalysisState): Promise<Result<void>>;
  /**
   * Stores the user's score and points its memo at it, in one transaction.
   * Called on every edit gesture, so it must be idempotent for the same id.
   */
  saveScore(score: ScoreDocument): Promise<Result<void>>;
  /** The score a memo currently points at, if the user has edited one. */
  getScore(memoId: MemoId): Promise<Result<ScoreDocument>>;
  /**
   * Discards the user's edits entirely, so the display falls back to the
   * machine transcription. This is the explicit re-seed path — it must never
   * happen implicitly.
   */
  deleteScore(memoId: MemoId): Promise<Result<void>>;
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

  async saveAnalysis(record: AnalysisRecord): Promise<Result<void>> {
    try {
      const db = await this.#db();
      const tx = db.transaction(['analyses', 'memos'], 'readwrite');
      const memo = await tx.objectStore('memos').get(record.memoId);
      if (!memo) {
        await tx.done;
        return failure('not-found', `No memo with id ${record.memoId}.`);
      }

      // Rejecting a result computed from different bytes than the memo now
      // holds. Should not happen — audio is immutable — but a mismatch would
      // silently attach someone else's transcription.
      if (memo.audioHash !== record.audioHash) {
        await tx.done;
        return failure(
          'unknown',
          'Analysis does not match the memo it claims to describe.',
        );
      }

      const updated: Memo = {
        ...memo,
        analysisState: {
          currentAnalysisId: record.id,
          algorithmId: record.algorithmId,
          algorithmVersion: record.algorithmVersion,
          status: record.status === 'ok' ? 'ok' : 'failed',
          updatedAt: Date.now(),
        },
      };

      await Promise.all([
        tx.objectStore('analyses').put(record),
        tx.objectStore('memos').put(updated),
        tx.done,
      ]);
      return ok(undefined);
    } catch (e) {
      return err(toStorageError(e, 'Could not save the transcription.'));
    }
  }

  async getAnalysis(memoId: MemoId): Promise<Result<AnalysisRecord>> {
    try {
      const db = await this.#db();
      const memo = await db.get('memos', memoId);
      const analysisId = memo?.analysisState?.currentAnalysisId;
      if (!analysisId) {
        return failure('not-found', `Memo ${memoId} has no transcription.`);
      }
      const record = await db.get('analyses', analysisId);
      if (!record) {
        return failure('not-found', `Analysis ${analysisId} is missing.`);
      }
      return ok(record);
    } catch (e) {
      return err(toStorageError(e, 'Could not load the transcription.'));
    }
  }

  async setAnalysisState(
    memoId: MemoId,
    state: AnalysisState,
  ): Promise<Result<void>> {
    try {
      const db = await this.#db();
      const tx = db.transaction('memos', 'readwrite');
      const memo = await tx.store.get(memoId);
      if (!memo) {
        await tx.done;
        return failure('not-found', `No memo with id ${memoId}.`);
      }
      await tx.store.put({ ...memo, analysisState: state });
      await tx.done;
      return ok(undefined);
    } catch (e) {
      return err(toStorageError(e, 'Could not update transcription status.'));
    }
  }

  async saveScore(score: ScoreDocument): Promise<Result<void>> {
    try {
      const db = await this.#db();
      const tx = db.transaction(['scores', 'memos'], 'readwrite');
      const memo = await tx.objectStore('memos').get(score.memoId);
      if (!memo) {
        await tx.done;
        return failure('not-found', `No memo with id ${score.memoId}.`);
      }

      const updated: Memo = {
        ...memo,
        currentScoreId: score.id,
        updatedAt: Date.now(),
      };

      await Promise.all([
        tx.objectStore('scores').put(score),
        tx.objectStore('memos').put(updated),
        tx.done,
      ]);
      return ok(undefined);
    } catch (e) {
      return err(toStorageError(e, 'Could not save your edits.'));
    }
  }

  async getScore(memoId: MemoId): Promise<Result<ScoreDocument>> {
    try {
      const db = await this.#db();
      const memo = await db.get('memos', memoId);
      const scoreId = memo?.currentScoreId;
      if (!scoreId) {
        return failure('not-found', `Memo ${memoId} has no edited score.`);
      }
      const score = await db.get('scores', scoreId);
      if (!score) {
        return failure('not-found', `Score ${scoreId} is missing.`);
      }
      return ok(score);
    } catch (e) {
      return err(toStorageError(e, 'Could not load your edits.'));
    }
  }

  async deleteScore(memoId: MemoId): Promise<Result<void>> {
    try {
      const db = await this.#db();
      const tx = db.transaction(['scores', 'memos'], 'readwrite');
      const memo = await tx.objectStore('memos').get(memoId);
      if (!memo) {
        await tx.done;
        return failure('not-found', `No memo with id ${memoId}.`);
      }

      // Every score row for the memo goes, not just the current pointer —
      // orphans would be invisible dead weight.
      const scoreKeys = await tx
        .objectStore('scores')
        .index('by-memoId')
        .getAllKeys(memoId);

      await Promise.all([
        ...scoreKeys.map((key) => tx.objectStore('scores').delete(key)),
        tx.objectStore('memos').put({
          ...memo,
          currentScoreId: null,
          updatedAt: Date.now(),
        }),
        tx.done,
      ]);
      return ok(undefined);
    } catch (e) {
      return err(toStorageError(e, 'Could not discard your edits.'));
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
  #analyses = new Map<string, AnalysisRecord>();
  #scores = new Map<MemoId, ScoreDocument>();
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

  async saveAnalysis(record: AnalysisRecord): Promise<Result<void>> {
    const memo = this.#memos.get(record.memoId);
    if (!memo) return failure('not-found', `No memo with id ${record.memoId}.`);
    this.#analyses.set(record.id, record);
    this.#memos.set(memo.id, {
      ...memo,
      analysisState: {
        currentAnalysisId: record.id,
        algorithmId: record.algorithmId,
        algorithmVersion: record.algorithmVersion,
        status: record.status === 'ok' ? 'ok' : 'failed',
        updatedAt: Date.now(),
      },
    });
    return ok(undefined);
  }

  async getAnalysis(memoId: MemoId): Promise<Result<AnalysisRecord>> {
    const analysisId = this.#memos.get(memoId)?.analysisState?.currentAnalysisId;
    const record = analysisId ? this.#analyses.get(analysisId) : undefined;
    return record
      ? ok(record)
      : failure('not-found', `Memo ${memoId} has no transcription.`);
  }

  async setAnalysisState(
    memoId: MemoId,
    state: AnalysisState,
  ): Promise<Result<void>> {
    const memo = this.#memos.get(memoId);
    if (!memo) return failure('not-found', `No memo with id ${memoId}.`);
    this.#memos.set(memoId, { ...memo, analysisState: state });
    return ok(undefined);
  }

  async saveScore(score: ScoreDocument): Promise<Result<void>> {
    const memo = this.#memos.get(score.memoId);
    if (!memo) return failure('not-found', `No memo with id ${score.memoId}.`);
    this.#scores.set(score.memoId, score);
    this.#memos.set(memo.id, {
      ...memo,
      currentScoreId: score.id,
      updatedAt: Date.now(),
    });
    return ok(undefined);
  }

  async getScore(memoId: MemoId): Promise<Result<ScoreDocument>> {
    const score = this.#scores.get(memoId);
    return score
      ? ok(score)
      : failure('not-found', `Memo ${memoId} has no edited score.`);
  }

  async deleteScore(memoId: MemoId): Promise<Result<void>> {
    const memo = this.#memos.get(memoId);
    if (!memo) return failure('not-found', `No memo with id ${memoId}.`);
    this.#scores.delete(memoId);
    this.#memos.set(memoId, { ...memo, currentScoreId: null, updatedAt: Date.now() });
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
