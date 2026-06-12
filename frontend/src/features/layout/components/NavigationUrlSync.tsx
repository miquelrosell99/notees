/**
 * NavigationUrlSync — bridge from navigationStore back to the browser URL.
 *
 * Rendered inside Layout. It has no visual output.
 */

import { useNavigationUrlSync } from '@/features/layout/hooks/useNavigationUrlSync';

interface NavigationUrlSyncProps {
  hasInitialized: React.MutableRefObject<boolean>;
  isProcessingUrl: React.MutableRefObject<boolean>;
}

export function NavigationUrlSync({ hasInitialized, isProcessingUrl }: NavigationUrlSyncProps) {
  useNavigationUrlSync({ hasInitialized, isProcessingUrl });
  return null;
}
