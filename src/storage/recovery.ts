import { createMemoFromCapture } from '../core/memoFactory.ts';
import { detectPlatform } from '../core/platform.ts';
import { formatTimestamp } from '../core/format.ts';
import type { CaptureInfo, Memo } from '../core/types.ts';
import type { MemoRepository } from './memoRepository.ts';

/**
 * Rescues a recording whose browser process was killed mid-take.
 *
 * Run once at startup. Anything left in the scratch store means the app went
 * away without finalizing, so the partial take is saved as a normal memo
 * rather than being offered through a dialog — a prompt asking whether to keep
 * audio the user already performed only invites them to answer wrong.
 *
 * The recovered memo is titled distinctly so it is obvious where it came from.
 */
export async function recoverOrphanedRecording(
  repository: MemoRepository,
): Promise<Memo | null> {
  const session = await repository.takeScratch();
  if (!session || session.chunks.length === 0) return null;

  try {
    const blob = new Blob(session.chunks, { type: session.mimeType });
    const data = await blob.arrayBuffer();
    if (data.byteLength === 0) return null;

    const capture: CaptureInfo = {
      mimeType: session.mimeType,
      requestedMimeType: session.mimeType,
      // Snapshotted at the last flush, so this under-reports by up to one
      // chunk interval. Better slightly short than Infinity.
      durationMs: session.durationMs,
      byteLength: data.byteLength,
      // The stream was gone before these could be read.
      sampleRate: null,
      channelCount: 1,
      dsp: {
        echoCancellation: null,
        noiseSuppression: null,
        autoGainControl: null,
      },
      deviceLabel: null,
      capturedAt: session.startedAt,
      platform: detectPlatform(),
      terminatedBy: 'error',
    };

    const { memo, audio } = await createMemoFromCapture(
      { data, capture },
      `Recovered — ${formatTimestamp(session.startedAt)}`,
    );

    const saved = await repository.saveMemo(memo, audio);
    return saved.ok ? memo : null;
  } catch {
    // A corrupt snapshot is not worth failing startup over; it has already
    // been cleared from the scratch store by takeScratch.
    return null;
  }
}
