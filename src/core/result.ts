/**
 * Explicit results instead of exceptions across module boundaries.
 *
 * Every failure a user can actually hit — denied mic, full disk, private
 * browsing — needs a specific, actionable message rather than a generic
 * "something went wrong". Making the error type a closed union forces each new
 * failure mode to be handled at the UI layer instead of silently falling into
 * a catch-all.
 */

export type AppErrorCode =
  /** User denied the mic permission prompt. */
  | 'permission-denied'
  /** No input device present. */
  | 'no-mic'
  /** Recording ended involuntarily (backgrounded, phone call, track died). */
  | 'interrupted'
  /** Storage is full. */
  | 'quota-exceeded'
  /** IndexedDB unavailable — most often iOS Private Browsing. */
  | 'storage-unavailable'
  /** Browser produced no usable recording format. */
  | 'unsupported-format'
  /** Browser lacks MediaRecorder/getUserMedia entirely. */
  | 'recording-unsupported'
  /** An import file was malformed. */
  | 'invalid-archive'
  /** Asked for something that isn't there. */
  | 'not-found'
  /** Genuinely unexpected — always carries the original cause. */
  | 'unknown';

export interface AppError {
  code: AppErrorCode;
  /** Developer-facing. User-facing copy is chosen in the UI from `code`. */
  message: string;
  cause?: unknown;
}

export type Result<T, E = AppError> =
  | { ok: true; value: T }
  | { ok: false; error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

export function appError(
  code: AppErrorCode,
  message: string,
  cause?: unknown,
): AppError {
  return cause === undefined ? { code, message } : { code, message, cause };
}

export function failure(
  code: AppErrorCode,
  message: string,
  cause?: unknown,
): Result<never, AppError> {
  return err(appError(code, message, cause));
}

/**
 * Maps a thrown DOM exception onto our error union.
 *
 * The DOMException names here are the ones getUserMedia and IndexedDB actually
 * throw; anything else stays 'unknown' with the cause attached rather than
 * being guessed at.
 */
export function fromDomException(e: unknown, fallbackMessage: string): AppError {
  if (e instanceof DOMException || (e instanceof Error && 'name' in e)) {
    switch (e.name) {
      case 'NotAllowedError':
      case 'SecurityError':
        return appError(
          'permission-denied',
          'Microphone permission was denied.',
          e,
        );
      case 'NotFoundError':
      case 'OverconstrainedError':
        return appError('no-mic', 'No microphone was found.', e);
      case 'NotReadableError':
      case 'AbortError':
        return appError(
          'interrupted',
          'The microphone became unavailable.',
          e,
        );
      case 'QuotaExceededError':
        return appError('quota-exceeded', 'Device storage is full.', e);
      case 'InvalidStateError':
        return appError('storage-unavailable', 'Storage is unavailable.', e);
    }
  }
  return appError('unknown', fallbackMessage, e);
}
