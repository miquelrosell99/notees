/**
 * Persistent storage helpers for the local-first workspace database.
 *
 * Browsers may evict IndexedDB data when storage is under pressure unless the
 * user has granted the "persistent storage" permission. These helpers request
 * that permission and report whether it was granted.
 */

export async function requestPersistentStorage(): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.storage?.persist) {
    return false;
  }

  try {
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

export async function isPersisted(): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.storage?.persisted) {
    return false;
  }

  try {
    return await navigator.storage.persisted();
  } catch {
    return false;
  }
}
