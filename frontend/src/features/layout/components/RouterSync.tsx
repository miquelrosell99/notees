import { useRef } from 'react';
import { useRouterSync } from '@/features/layout/hooks/useRouterSync';
import { useUrlSync } from '@/features/layout/hooks/useUrlSync';

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
