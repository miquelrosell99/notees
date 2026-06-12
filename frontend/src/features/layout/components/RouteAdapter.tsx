/**
 * RouteAdapter — bridge from react-router route params to navigationStore.
 *
 * Rendered inside Layout. It has no visual output.
 */

import { useRouteAdapter } from '@/features/layout/hooks/useRouteAdapter';

interface RouteAdapterProps {
  hasInitialized: React.MutableRefObject<boolean>;
  isProcessingUrl: React.MutableRefObject<boolean>;
}

export function RouteAdapter({ hasInitialized, isProcessingUrl }: RouteAdapterProps) {
  useRouteAdapter({ hasInitialized, isProcessingUrl });
  return null;
}
