import { useEffect, useState } from 'react';

export interface StorageQuota {
  usage: number;
  quota: number;
  percentUsed: number;
}

const DEFAULT_WARNING_THRESHOLD = 0.8;
const DEFAULT_CRITICAL_THRESHOLD = 0.95;

export function useStorageQuota(
  warningThreshold = DEFAULT_WARNING_THRESHOLD,
  criticalThreshold = DEFAULT_CRITICAL_THRESHOLD
) {
  const [quota, setQuota] = useState<StorageQuota | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function estimate() {
      if (typeof navigator === 'undefined' || !navigator.storage?.estimate) {
        return;
      }
      try {
        const estimate = await navigator.storage.estimate();
        if (cancelled) return;
        const usage = estimate.usage ?? 0;
        const quota = estimate.quota ?? 0;
        setQuota({
          usage,
          quota,
          percentUsed: quota > 0 ? usage / quota : 0,
        });
      } catch {
        // Ignore errors from unsupported environments.
      }
    }

    void estimate();
    return () => {
      cancelled = true;
    };
  }, []);

  return {
    quota,
    isWarning: quota ? quota.percentUsed >= warningThreshold && quota.percentUsed < criticalThreshold : false,
    isCritical: quota ? quota.percentUsed >= criticalThreshold : false,
  };
}
