import { defaultMemoTitle } from './format.ts';
import { sha256Hex } from './hash.ts';
import { uuidv7 } from './ids.ts';
import {
  MEMO_SCHEMA_VERSION,
  type AudioAsset,
  type CapturedAudio,
  type Memo,
} from './types.ts';

/**
 * Builds the persistable pair from a finished recording.
 *
 * Kept out of both the capture and storage layers so neither depends on the
 * other: capture produces bytes, storage writes rows, and this is the seam
 * where they meet.
 */
export async function createMemoFromCapture(
  captured: CapturedAudio,
  title?: string,
): Promise<{ memo: Memo; audio: AudioAsset }> {
  const id = uuidv7(captured.capture.capturedAt);
  const audioHash = await sha256Hex(captured.data);
  const now = Date.now();

  const memo: Memo = {
    id,
    schemaVersion: MEMO_SCHEMA_VERSION,
    title: title?.trim() || defaultMemoTitle(captured.capture.capturedAt),
    createdAt: captured.capture.capturedAt,
    updatedAt: now,
    audioHash,
    capture: captured.capture,
    // Both null until the v2 analysis and v3 score layers exist.
    analysisState: null,
    currentScoreId: null,
  };

  const audio: AudioAsset = {
    memoId: id,
    data: captured.data,
    mimeType: captured.capture.mimeType,
    byteLength: captured.data.byteLength,
  };

  return { memo, audio };
}
