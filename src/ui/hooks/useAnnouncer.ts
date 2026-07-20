import { useCallback, useState } from 'react';

/**
 * A single polite live region for state changes.
 *
 * Deliberately narrow: only discrete events — recording started, memo saved,
 * memo deleted — go through here. The elapsed timer does not, because a region
 * that updates every second gives a screen-reader user a continuous stream of
 * numbers and no way to hear anything else.
 */
export function useAnnouncer(): {
  message: string;
  announce: (message: string) => void;
} {
  const [message, setMessage] = useState('');

  const announce = useCallback((next: string) => {
    // Re-announcing identical text requires a change for the region to fire;
    // a trailing space is the least intrusive way to force one.
    setMessage((current) => (current === next ? `${next} ` : next));
  }, []);

  return { message, announce };
}
