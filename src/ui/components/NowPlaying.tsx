import { forwardRef } from 'react';
import type { Memo } from '../../core/types.ts';

interface NowPlayingProps {
  memo: Memo | null;
}

/**
 * The app's single audio element, rendered with the platform's native
 * controls.
 *
 * Native controls are already keyboard operable and already labelled for
 * screen readers, and they behave the way each platform's users expect.
 * Rebuilding a transport by hand is a well-worn source of accessibility bugs,
 * and nothing here justifies it.
 *
 * The element stays mounted whether or not anything is loaded so that the
 * PlaybackService can hold a stable reference to it.
 */
export const NowPlaying = forwardRef<HTMLAudioElement, NowPlayingProps>(
  function NowPlaying({ memo }, ref) {
    return (
      <div className="now-playing" data-empty={!memo || undefined}>
        <p className="now-playing__label">
          {memo ? (
            <>
              <span className="visually-hidden">Now playing: </span>
              {memo.title}
            </>
          ) : (
            'Nothing selected'
          )}
        </p>
        <audio
          ref={ref}
          className="now-playing__audio"
          controls
          aria-label={memo ? `Playback controls for ${memo.title}` : 'Playback controls'}
        />
      </div>
    );
  },
);
