/**
 * Watches for everything that can end a recording without the user pressing
 * Stop.
 *
 * On iOS a phone call, Siri, screen lock, or simply backgrounding the app will
 * tear down the capture session, and the failure is silent — the track object
 * still looks alive while producing nothing. Losing a take the user has
 * already performed is the worst outcome this app has, so every one of these
 * signals means "stop now and keep what we have", never "discard".
 */

export type InterruptionReason =
  | 'page-hidden'
  | 'page-unloading'
  | 'track-ended'
  | 'track-muted'
  | 'audio-interrupted'
  | 'recorder-error';

/**
 * WebKit adds an 'interrupted' AudioContext state that is absent from the
 * standard typings; it must be explicitly resumed afterwards.
 * https://github.com/WebAudio/web-audio-api/issues/2585
 */
type ExtendedAudioContextState = AudioContextState | 'interrupted';

export interface InterruptionWatchOptions {
  stream: MediaStream;
  recorder: MediaRecorder;
  audioContext?: AudioContext | null;
  onInterrupt: (reason: InterruptionReason) => void;
}

/** Registers all watchers and returns a disposer that removes every one. */
export function watchInterruptions(
  options: InterruptionWatchOptions,
): () => void {
  const { stream, recorder, audioContext, onInterrupt } = options;
  const disposers: Array<() => void> = [];

  // Only the first signal matters — the rest tend to cascade from it.
  let fired = false;
  const fire = (reason: InterruptionReason) => {
    if (fired) return;
    fired = true;
    onInterrupt(reason);
  };

  const onVisibility = () => {
    if (document.visibilityState === 'hidden') fire('page-hidden');
  };
  document.addEventListener('visibilitychange', onVisibility);
  disposers.push(() =>
    document.removeEventListener('visibilitychange', onVisibility),
  );

  // pagehide is the reliable teardown signal on iOS, where unload often
  // does not fire at all.
  const onPageHide = () => fire('page-unloading');
  window.addEventListener('pagehide', onPageHide);
  disposers.push(() => window.removeEventListener('pagehide', onPageHide));

  for (const track of stream.getAudioTracks()) {
    const onEnded = () => fire('track-ended');
    // A muted track is the OS taking the mic away, not the user muting input.
    const onMute = () => fire('track-muted');
    track.addEventListener('ended', onEnded);
    track.addEventListener('mute', onMute);
    disposers.push(() => {
      track.removeEventListener('ended', onEnded);
      track.removeEventListener('mute', onMute);
    });
  }

  const onRecorderError = () => fire('recorder-error');
  recorder.addEventListener('error', onRecorderError);
  disposers.push(() =>
    recorder.removeEventListener('error', onRecorderError),
  );

  if (audioContext) {
    const onStateChange = () => {
      const state = audioContext.state as ExtendedAudioContextState;
      if (state === 'interrupted' || state === 'suspended') {
        fire('audio-interrupted');
      }
    };
    audioContext.addEventListener('statechange', onStateChange);
    disposers.push(() =>
      audioContext.removeEventListener('statechange', onStateChange),
    );
  }

  return () => {
    for (const dispose of disposers) {
      try {
        dispose();
      } catch {
        // Removing a listener must never throw out of cleanup.
      }
    }
  };
}

export function describeInterruption(reason: InterruptionReason): string {
  switch (reason) {
    case 'page-hidden':
    case 'page-unloading':
      return 'Recording stopped because the app was sent to the background. What was captured has been saved.';
    case 'track-ended':
    case 'track-muted':
      return 'Recording stopped because the microphone became unavailable. What was captured has been saved.';
    case 'audio-interrupted':
      return 'Recording was interrupted by another app or a call. What was captured has been saved.';
    case 'recorder-error':
      return 'Recording stopped unexpectedly. What was captured has been saved.';
  }
}
