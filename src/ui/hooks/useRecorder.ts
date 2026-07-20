import { useCallback, useEffect, useRef, useState } from 'react';
import {
  MAX_RECORDING_MS,
  RecordingService,
  type RecordingState,
} from '../../capture/RecordingService.ts';
import { describeInterruption } from '../../capture/interruptions.ts';
import type { AppError } from '../../core/result.ts';
import type { CapturedAudio } from '../../core/types.ts';
import type { ScratchSession } from '../../storage/db.ts';
import { uuidv7 } from '../../core/ids.ts';

export interface UseRecorderOptions {
  onCaptured: (captured: CapturedAudio) => void;
  onFlush?: (session: ScratchSession) => void;
  onNotice?: (message: string) => void;
}

export interface UseRecorderResult {
  state: RecordingState;
  elapsedMs: number;
  remainingMs: number;
  error: AppError | null;
  /** Resolves true only when recording actually began. */
  start: () => Promise<boolean>;
  stop: () => void;
  clearError: () => void;
}

export function useRecorder(options: UseRecorderOptions): UseRecorderResult {
  const [state, setState] = useState<RecordingState>('idle');
  const [elapsedMs, setElapsedMs] = useState(0);
  const [error, setError] = useState<AppError | null>(null);

  // Held in a ref so the service is constructed once and its callbacks always
  // see current props without tearing down and rebuilding mid-recording.
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const sessionIdRef = useRef<string>('');
  const serviceRef = useRef<RecordingService | null>(null);

  if (serviceRef.current === null) {
    serviceRef.current = new RecordingService({
      onStateChange: setState,
      onElapsed: setElapsedMs,
      onCaptured: (captured) => optionsRef.current.onCaptured(captured),
      onInterrupted: (reason) =>
        optionsRef.current.onNotice?.(describeInterruption(reason)),
      onError: setError,
      onFlush: (snapshot) =>
        optionsRef.current.onFlush?.({
          sessionId: sessionIdRef.current,
          startedAt: snapshot.startedAt,
          mimeType: snapshot.mimeType,
          durationMs: snapshot.durationMs,
          chunks: snapshot.chunks,
        }),
    });
  }

  useEffect(() => {
    const service = serviceRef.current;
    // Releases the microphone if the app is torn down mid-recording.
    return () => service?.dispose();
  }, []);

  const start = useCallback(async () => {
    setError(null);
    setElapsedMs(0);
    sessionIdRef.current = uuidv7();
    const result = await serviceRef.current!.start();
    if (!result.ok) {
      setError(result.error);
      return false;
    }
    return true;
  }, []);

  const stop = useCallback(() => {
    serviceRef.current!.stop('user');
  }, []);

  const clearError = useCallback(() => setError(null), []);

  return {
    state,
    elapsedMs,
    remainingMs: Math.max(0, MAX_RECORDING_MS - elapsedMs),
    error,
    start,
    stop,
    clearError,
  };
}
