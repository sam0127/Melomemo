import { useEffect, useRef, useState } from 'react';
import { registerSW } from 'virtual:pwa-register';

/**
 * Surfaces a waiting service worker as an explicit user choice.
 *
 * Applying an update means reloading the page, so it must never happen on its
 * own: doing it mid-recording would destroy a take, and swapping in newer code
 * against an older open database is a corruption path. The caller decides when
 * it is safe to offer this.
 */
export function useServiceWorkerUpdate(): {
  needRefresh: boolean;
  applyUpdate: () => void;
  dismiss: () => void;
} {
  const [needRefresh, setNeedRefresh] = useState(false);
  const updateRef = useRef<((reload?: boolean) => Promise<void>) | null>(null);

  useEffect(() => {
    updateRef.current = registerSW({
      onNeedRefresh: () => setNeedRefresh(true),
    });
  }, []);

  return {
    needRefresh,
    applyUpdate: () => {
      setNeedRefresh(false);
      void updateRef.current?.(true);
    },
    dismiss: () => setNeedRefresh(false),
  };
}
