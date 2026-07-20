/**
 * Container/codec negotiation for MediaRecorder.
 *
 * Each engine is given its own native format rather than forcing a common one.
 * Safari can record WebM/Opus as of 18.4, but preferring it there would strand
 * every earlier iOS version and buy nothing: this is a local-only app, so a
 * device only ever plays back what it recorded itself. Export is where format
 * portability matters, and that is handled separately.
 */

export const MIME_CANDIDATES = [
  'audio/mp4;codecs=mp4a.40.2', // Safari — explicit codec avoids ambiguity
  'audio/mp4',
  'audio/webm;codecs=opus', // Chrome, Android, Firefox, Safari 18.4+
  'audio/webm',
  'audio/ogg;codecs=opus', // Firefox
] as const;

/**
 * Empty string is a legitimate value: it tells MediaRecorder to pick its own
 * default, which is the correct last resort when nothing probes as supported.
 */
export const UA_DEFAULT_MIME = '';

export type IsTypeSupported = (type: string) => boolean;

function defaultIsTypeSupported(): IsTypeSupported | null {
  if (typeof MediaRecorder === 'undefined') return null;
  // isTypeSupported is missing on some older WebKit builds even though
  // MediaRecorder itself exists.
  if (typeof MediaRecorder.isTypeSupported !== 'function') return null;
  return (type) => MediaRecorder.isTypeSupported(type);
}

/**
 * Returns the first supported candidate, or the UA default.
 *
 * The chosen value is only ever a *request*. The authoritative container is
 * `MediaRecorder.mimeType` read after `start()`, which is what gets persisted.
 */
export function negotiateMimeType(
  isTypeSupported: IsTypeSupported | null = defaultIsTypeSupported(),
): string {
  if (!isTypeSupported) return UA_DEFAULT_MIME;
  for (const candidate of MIME_CANDIDATES) {
    try {
      if (isTypeSupported(candidate)) return candidate;
    } catch {
      // A throwing probe means "no"; keep walking the chain.
    }
  }
  return UA_DEFAULT_MIME;
}

export function isRecordingSupported(): boolean {
  return (
    typeof MediaRecorder !== 'undefined' &&
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices?.getUserMedia
  );
}

/**
 * File extension for a recorded container, used when exporting.
 * Falls back to .webm, the most widely accepted of the two common cases.
 */
export function extensionForMimeType(mimeType: string): string {
  const base = mimeType.split(';')[0]?.trim().toLowerCase() ?? '';
  switch (base) {
    case 'audio/mp4':
      return 'm4a';
    case 'audio/ogg':
      return 'ogg';
    case 'audio/wav':
    case 'audio/wave':
      return 'wav';
    case 'audio/mpeg':
      return 'mp3';
    case 'audio/webm':
      return 'webm';
    default:
      return 'webm';
  }
}
