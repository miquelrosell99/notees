import { useRef } from 'react';
import { useRouterSync } from '../hooks/useRouterSync';
import { useUrlSync } from '../hooks/useUrlSync';

interface RouterSyncProps {
  children: React.ReactNode;
}

export function RouterSync({ children }: RouterSyncProps) {
  const hasInitialized = useRef(false);
  const isProcessingUrl = useRef(false);

  useRouterSync(hasInitialized, isProcessingUrl);
  useUrlSync(hasInitialized, isProcessingUrl);

  return <>{children}</>;
}
