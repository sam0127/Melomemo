import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useRecorder } from './useRecorder.ts';

/**
 * Regression cover for a bug found by running the app: the caller announced
 * "Recording started" unconditionally, so a screen-reader user was told
 * recording had begun even when the microphone was blocked. start() has to
 * report whether it actually succeeded.
 */
describe('useRecorder', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubMic(getUserMedia: () => Promise<MediaStream>) {
    class FakeRecorder extends EventTarget {
      static isTypeSupported = () => true;
      mimeType = 'audio/webm';
      start() {}
      stop() {}
    }
    vi.stubGlobal('MediaRecorder', FakeRecorder);
    vi.stubGlobal('navigator', { ...navigator, mediaDevices: { getUserMedia } });
  }

  it('reports failure when the microphone is blocked', async () => {
    stubMic(async () => {
      throw new DOMException('Denied', 'NotAllowedError');
    });

    const { result } = renderHook(() =>
      useRecorder({ onCaptured: () => {} }),
    );

    await expect(result.current.start()).resolves.toBe(false);
    await waitFor(() => {
      expect(result.current.error?.code).toBe('permission-denied');
    });
  });

  it('reports success when recording begins', async () => {
    const track = {
      readyState: 'live' as const,
      label: 'Fake mic',
      getSettings: () => ({ sampleRate: 48000, channelCount: 1 }),
      stop: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
    };
    stubMic(
      async () =>
        ({
          getAudioTracks: () => [track],
          getTracks: () => [track],
        }) as unknown as MediaStream,
    );

    const { result } = renderHook(() =>
      useRecorder({ onCaptured: () => {} }),
    );

    await expect(result.current.start()).resolves.toBe(true);
    expect(result.current.error).toBeNull();
  });
});
