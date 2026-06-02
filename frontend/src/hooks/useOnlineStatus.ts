/**
 * useOnlineStatus — tracks browser and native online/offline state.
 *
 * Uses navigator.onLine and listens to 'online' / 'offline' window events,
 * plus custom 'nativeOnline' / 'nativeOffline' events fired from the Android
 * WebView wrapper when the device's network connectivity changes.
 *
 * Returns true when the browser believes it has network connectivity.
 */
import { useState, useEffect } from 'react';

export function useOnlineStatus(): boolean {
  const [isOnline, setIsOnline] = useState(() =>
    typeof navigator !== 'undefined' ? navigator.onLine : true
  );

  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);
    const handleNativeOnline = () => setIsOnline(true);
    const handleNativeOffline = () => setIsOnline(false);

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    window.addEventListener('nativeOnline', handleNativeOnline);
    window.addEventListener('nativeOffline', handleNativeOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      window.removeEventListener('nativeOnline', handleNativeOnline);
      window.removeEventListener('nativeOffline', handleNativeOffline);
    };
  }, []);

  return isOnline;
}
