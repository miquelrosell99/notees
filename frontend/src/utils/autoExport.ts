/**
 * Auto-export utility
 *
 * Debounced per-page auto-export triggered after successful block/page saves.
 */
import { autoExportPage } from '@/api/autoExport';
import { useAutoExportStore } from '@/stores/autoExportStore';

const EXPORT_DEBOUNCE_MS = 2000;
const exportTimers = new Map<string, ReturnType<typeof setTimeout>>();

export function scheduleAutoExport(nodeUuid: string): void {
  const store = useAutoExportStore.getState();

  // Clear existing timer for this page
  const existing = exportTimers.get(nodeUuid);
  if (existing) {
    clearTimeout(existing);
  }

  store.setExporting(nodeUuid);

  const timer = setTimeout(() => {
    exportTimers.delete(nodeUuid);
    autoExportPage(nodeUuid)
      .then(() => {
        store.setDone();
      })
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        store.setError(message);
      });
  }, EXPORT_DEBOUNCE_MS);

  exportTimers.set(nodeUuid, timer);
}

export function cancelAutoExport(nodeUuid: string): void {
  const existing = exportTimers.get(nodeUuid);
  if (existing) {
    clearTimeout(existing);
    exportTimers.delete(nodeUuid);
  }
}
