import { extensionForMimeType } from '../capture/mimeNegotiation.ts';
import { failure, ok, type Result } from '../core/result.ts';
import { MEMO_SCHEMA_VERSION, type AudioAsset, type Memo } from '../core/types.ts';
import type { MemoRepository } from './memoRepository.ts';

/**
 * Getting recordings on and off the device.
 *
 * This is not a convenience feature. Everything lives in browser storage,
 * which is evictable, and on iOS a home-screen install gets a *separate* store
 * from Safari — so a user who records in the browser and then installs the app
 * finds an empty list. Export is the only route out of that, and out of
 * eviction and device changes generally.
 *
 * Two distinct operations, because they serve different needs:
 *   - exportAudio  — one plain audio file, for use in other apps.
 *   - exportArchive — everything including metadata, for restoring later.
 */

export const ARCHIVE_FORMAT = 'melomemo-archive';
export const ARCHIVE_VERSION = 1;

interface ArchiveEntry {
  memo: Memo;
  mimeType: string;
  /** Base64. Inflates size ~33%, but keeps the archive a single self-contained file. */
  audioBase64: string;
}

interface ArchiveFile {
  format: typeof ARCHIVE_FORMAT;
  version: number;
  exportedAt: number;
  entries: ArchiveEntry[];
}

/**
 * Chunked because String.fromCharCode(...bytes) overflows the call stack on
 * anything larger than a few hundred kilobytes.
 */
function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function fromBase64(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

/** Strips characters that filesystems reject, so the download actually saves. */
function safeFileName(title: string): string {
  const cleaned = title.replace(/[\\/:*?"<>|]/g, '').trim();
  return cleaned.length > 0 ? cleaned.slice(0, 80) : 'melomemo';
}

function triggerDownload(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Deferred: revoking synchronously can cancel the download in some browsers
  // before it has read the blob.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * Downloads a single memo as a plain audio file.
 *
 * Note: recordings produced by MediaRecorder carry no duration in their
 * container, so some external players show the length as unknown or count up
 * past the end. The audio itself is complete and correct. Rewriting the
 * container metadata to fix the display is deferred.
 */
export async function exportAudio(
  repository: MemoRepository,
  memo: Memo,
): Promise<Result<void>> {
  const audio = await repository.getAudio(memo.id);
  if (!audio.ok) return audio;

  const extension = extensionForMimeType(audio.value.mimeType);
  const blob = new Blob([audio.value.data], { type: audio.value.mimeType });
  triggerDownload(blob, `${safeFileName(memo.title)}.${extension}`);
  return ok(undefined);
}

/** Downloads every memo, with metadata, as one restorable file. */
export async function exportArchive(
  repository: MemoRepository,
): Promise<Result<number>> {
  const listed = await repository.listMemos();
  if (!listed.ok) return listed;

  const entries: ArchiveEntry[] = [];
  for (const memo of listed.value) {
    const audio = await repository.getAudio(memo.id);
    // A memo whose audio is missing is skipped rather than failing the whole
    // export — a partial backup beats no backup.
    if (!audio.ok) continue;
    entries.push({
      memo,
      mimeType: audio.value.mimeType,
      audioBase64: toBase64(audio.value.data),
    });
  }

  if (entries.length === 0) {
    return failure('not-found', 'There are no memos to export.');
  }

  const archive: ArchiveFile = {
    format: ARCHIVE_FORMAT,
    version: ARCHIVE_VERSION,
    exportedAt: Date.now(),
    entries,
  };

  const blob = new Blob([JSON.stringify(archive)], { type: 'application/json' });
  const stamp = new Date().toISOString().slice(0, 10);
  triggerDownload(blob, `melomemo-backup-${stamp}.json`);
  return ok(entries.length);
}

function isArchiveFile(value: unknown): value is ArchiveFile {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<ArchiveFile>;
  return (
    candidate.format === ARCHIVE_FORMAT &&
    typeof candidate.version === 'number' &&
    Array.isArray(candidate.entries)
  );
}

/**
 * Restores memos from an archive.
 *
 * Existing memos are left alone: an id already present is skipped rather than
 * overwritten, so importing the same backup twice is harmless and importing an
 * older one never rolls back newer work.
 */
export async function importArchive(
  repository: MemoRepository,
  file: File,
): Promise<Result<{ imported: number; skipped: number }>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    return failure('invalid-archive', 'That file is not valid JSON.');
  }

  if (!isArchiveFile(parsed)) {
    return failure('invalid-archive', 'That file is not a Melomemo backup.');
  }
  if (parsed.version > ARCHIVE_VERSION) {
    return failure(
      'invalid-archive',
      'That backup was made by a newer version of Melomemo.',
    );
  }

  let imported = 0;
  let skipped = 0;

  for (const entry of parsed.entries) {
    if (!entry?.memo?.id || typeof entry.audioBase64 !== 'string') {
      skipped++;
      continue;
    }

    const existing = await repository.getMemo(entry.memo.id);
    if (existing.ok) {
      skipped++;
      continue;
    }

    try {
      const data = fromBase64(entry.audioBase64);
      const memo: Memo = { ...entry.memo, schemaVersion: MEMO_SCHEMA_VERSION };
      const audio: AudioAsset = {
        memoId: memo.id,
        data,
        mimeType: entry.mimeType,
        byteLength: data.byteLength,
      };
      const saved = await repository.saveMemo(memo, audio);
      if (saved.ok) imported++;
      else return saved;
    } catch {
      skipped++;
    }
  }

  return ok({ imported, skipped });
}
