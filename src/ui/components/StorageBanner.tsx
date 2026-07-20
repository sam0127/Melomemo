import { isIos, isStandalone } from '../../core/platform.ts';

/**
 * Shown when IndexedDB writes fail the startup probe.
 *
 * Almost always Private Browsing. Saying so up front is the whole point —
 * discovering that recordings do not persist *after* performing one is the
 * failure this exists to prevent.
 */
export function StorageBanner() {
  return (
    <div className="notice notice--warning" role="alert">
      <div className="notice__body">
        <strong className="notice__title">Recordings can’t be saved</strong>
        <p className="notice__detail">
          Browser storage is unavailable, which usually means Private Browsing.
          You can still record and play back, but nothing will survive a
          reload. Open Melomemo in a normal window to keep your memos.
        </p>
      </div>
    </div>
  );
}

/**
 * Explains why an installed iOS app opens empty.
 *
 * Safari and a home-screen web app get separate storage on iOS, so memos
 * recorded in the browser are genuinely not present here — they are not lost,
 * just in the other container. Without this the app looks broken.
 */
export function IosStorageSplitNotice() {
  if (!isIos() || !isStandalone()) return null;
  return (
    <div className="notice" role="status">
      <div className="notice__body">
        <strong className="notice__title">Recorded some in Safari?</strong>
        <p className="notice__detail">
          The installed app keeps its recordings separately from Safari. To move
          them across, open Melomemo in Safari, choose <em>Back up all</em>, then
          come back here and choose <em>Restore</em>.
        </p>
      </div>
    </div>
  );
}
