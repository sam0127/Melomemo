/**
 * Storage durability.
 *
 * By default browser storage is "best effort" and evictable — WebKit's ITP
 * clears it after roughly seven days without a Safari visit, and any browser
 * may evict under disk pressure. Since every recording lives only on the
 * device, that is a real data-loss path, so the app asks for persistent
 * storage and tells the user plainly when it doesn't have it.
 *
 * https://webkit.org/blog/14403/updates-to-storage-policy/
 */

export interface StorageStatus {
  persisted: boolean;
  usageBytes: number | null;
  quotaBytes: number | null;
}

/**
 * Requests durable storage.
 *
 * Called once after the first successful save, never at startup: browsers
 * grant this heuristically based on engagement, so asking before the user has
 * anything worth protecting is both likelier to be refused and a worse
 * experience.
 */
export async function requestPersistence(): Promise<boolean> {
  if (!navigator.storage?.persist) return false;
  try {
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

export async function getStorageStatus(): Promise<StorageStatus> {
  const status: StorageStatus = {
    persisted: false,
    usageBytes: null,
    quotaBytes: null,
  };
  if (!navigator.storage) return status;
  try {
    status.persisted = (await navigator.storage.persisted?.()) ?? false;
    const estimate = await navigator.storage.estimate?.();
    status.usageBytes = estimate?.usage ?? null;
    status.quotaBytes = estimate?.quota ?? null;
  } catch {
    // Reporting APIs are advisory; their failure must not break the app.
  }
  return status;
}

/**
 * Verifies IndexedDB can actually be written to.
 *
 * iOS Private Browsing exposes the IndexedDB API but rejects writes, so
 * feature detection alone reports a false positive. Probing at startup lets
 * the app say "recordings can't be saved in Private Browsing" up front rather
 * than losing a take the user has already performed.
 */
export async function probeStorageWritable(): Promise<boolean> {
  const probeName = '__melomemo_probe__';
  try {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(probeName, 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore('probe');
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('blocked'));
    });

    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('probe', 'readwrite');
      tx.objectStore('probe').put(new ArrayBuffer(8), 'k');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });

    db.close();
    indexedDB.deleteDatabase(probeName);
    return true;
  } catch {
    return false;
  }
}
