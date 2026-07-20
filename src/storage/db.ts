import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type {
  AnalysisRecord,
  AudioAsset,
  Memo,
  ScoreDocument,
} from '../core/types.ts';

/**
 * IndexedDB schema.
 *
 * All five stores are defined at version 1 even though `analyses` and `scores`
 * stay empty until v2/v3. An empty object store costs nothing, and declaring
 * them now means adding analysis and MIDI editing later requires no schema
 * migration at all — purely additive code.
 *
 * Two version axes, deliberately not conflated:
 *   - This DB_VERSION covers structural change (stores, indices) and only ever
 *     moves forward through the ladder in `upgrade`.
 *   - Memo.schemaVersion covers record shape and is migrated lazily on read.
 */

export const DB_NAME = 'melomemo';
export const DB_VERSION = 1;

/**
 * A recording in progress, rewritten roughly once a second.
 *
 * The interruption watchers already cover backgrounding, calls, and losing the
 * mic, because those fire while the page is still alive and able to finalize.
 * This covers the case they cannot: the browser process being killed outright,
 * which iOS does under memory pressure. Chunks are held as Blobs rather than
 * ArrayBuffers to keep the flush synchronous-ish and cheap; the store is
 * best-effort by design, and a failure to write it never blocks recording.
 */
export interface ScratchSession {
  sessionId: string;
  startedAt: number;
  mimeType: string;
  /** Elapsed wall-clock at the moment of the flush. */
  durationMs: number;
  chunks: Blob[];
}

export interface MelomemoDB extends DBSchema {
  memos: {
    key: string;
    value: Memo;
    indexes: {
      'by-createdAt': number;
      /** Drives "which memos are stale?" for the v2 re-analysis scheduler. */
      'by-analysisVersion': [string, string];
      'by-deletedAt': number;
    };
  };
  audio: {
    key: string;
    value: AudioAsset;
  };
  analyses: {
    key: string;
    value: AnalysisRecord;
    indexes: {
      'by-memoId': string;
      'by-memo-created': [string, number];
      'by-status': string;
    };
  };
  scores: {
    key: string;
    value: ScoreDocument;
    indexes: {
      'by-memoId': string;
    };
  };
  scratch: {
    key: string;
    value: ScratchSession;
  };
}

export type MelomemoDatabase = IDBPDatabase<MelomemoDB>;

export interface OpenOptions {
  /**
   * Called when another tab is waiting to upgrade this database. The holder
   * must close its connection or the upgrade blocks indefinitely — two tabs
   * open across a deploy is enough to wedge the newer one forever.
   */
  onBlocking?: () => void;
}

export function openMelomemoDB(
  options: OpenOptions = {},
): Promise<MelomemoDatabase> {
  return openDB<MelomemoDB>(DB_NAME, DB_VERSION, {
    upgrade(db, oldVersion) {
      // Forward-only ladder: each block runs for databases below that version,
      // so upgrades from any older version replay the missing steps in order.
      if (oldVersion < 1) {
        const memos = db.createObjectStore('memos', { keyPath: 'id' });
        memos.createIndex('by-createdAt', 'createdAt');
        memos.createIndex('by-analysisVersion', [
          'analysisState.algorithmId',
          'analysisState.algorithmVersion',
        ]);
        // Sparse by nature: only soft-deleted records carry deletedAt, so the
        // index holds just those rather than every memo.
        memos.createIndex('by-deletedAt', 'deletedAt');

        // Audio lives apart from metadata so listing memos never deserializes
        // megabytes of it.
        db.createObjectStore('audio', { keyPath: 'memoId' });

        const analyses = db.createObjectStore('analyses', { keyPath: 'id' });
        analyses.createIndex('by-memoId', 'memoId');
        analyses.createIndex('by-memo-created', ['memoId', 'createdAt']);
        analyses.createIndex('by-status', 'status');

        const scores = db.createObjectStore('scores', { keyPath: 'id' });
        scores.createIndex('by-memoId', 'memoId');

        db.createObjectStore('scratch', { keyPath: 'sessionId' });
      }
    },
    blocked() {
      console.warn('[melomemo] Database upgrade blocked by another open tab.');
    },
    blocking() {
      options.onBlocking?.();
    },
  });
}
