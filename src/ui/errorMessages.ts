import type { AppError } from '../core/result.ts';
import { isIos } from '../core/platform.ts';

/**
 * User-facing copy for each failure.
 *
 * Kept apart from the error definitions so the storage and capture layers stay
 * free of presentation, and written so every message says what the user can
 * actually do next — "microphone blocked" without a route to unblocking it is
 * a dead end, especially for anyone who cannot see where the browser put its
 * permission controls.
 */
export function describeError(error: AppError): {
  title: string;
  detail: string;
} {
  switch (error.code) {
    case 'permission-denied':
      return {
        title: 'Microphone access is blocked',
        detail: isIos()
          ? 'Allow the microphone in Settings › Safari › Microphone, then reload this page.'
          : 'Allow the microphone using the icon in your browser’s address bar, then try again.',
      };
    case 'no-mic':
      return {
        title: 'No microphone found',
        detail: 'Connect a microphone and try again.',
      };
    case 'interrupted':
      return {
        title: 'Recording was interrupted',
        detail: 'Anything captured before the interruption has been saved.',
      };
    case 'quota-exceeded':
      return {
        title: 'Device storage is full',
        detail: 'Delete a few memos, or export them first to free up space.',
      };
    case 'storage-unavailable':
      return {
        title: 'Recordings can’t be saved',
        detail:
          'Storage is unavailable — this usually means Private Browsing. Open Melomemo in a normal window to keep recordings.',
      };
    case 'unsupported-format':
      return {
        title: 'Recording isn’t supported here',
        detail: 'This browser offered no usable audio format. Try Safari, Chrome, or Firefox.',
      };
    case 'recording-unsupported':
      return {
        title: 'Recording isn’t supported here',
        detail: 'This browser can’t record audio. Try Safari, Chrome, or Firefox.',
      };
    case 'invalid-archive':
      return {
        title: 'That file couldn’t be imported',
        detail: 'It doesn’t look like a Melomemo export.',
      };
    case 'not-found':
      return {
        title: 'Memo not found',
        detail: 'It may have already been deleted.',
      };
    case 'unknown':
      return {
        title: 'Something went wrong',
        detail: error.message,
      };
  }
}
