/**
 * React hook for collaborative page editing.
 *
 * Phase 1: Skeleton. Returns a Yjs document and a provider,
 * but does not yet integrate with the Lexical editor.
 */

import { useEffect, useMemo, useState } from 'react';
import * as Y from 'yjs';
import { FastAPIProvider } from './FastAPIProvider';
import { getAuthToken } from '@/utils/auth';

export interface CollaborativePageState {
  ydoc: Y.Doc;
  provider: FastAPIProvider | null;
  isConnected: boolean;
}

export function useCollaborativePage(pageUuid: string): CollaborativePageState {
  const token = getAuthToken();
  const ydoc = useMemo(() => new Y.Doc(), []);
  const [provider, setProvider] = useState<FastAPIProvider | null>(null);
  const [isConnected, setIsConnected] = useState(false);

  useEffect(() => {
    if (!token || !pageUuid) return;

    const p = new FastAPIProvider(pageUuid, token, ydoc);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Initialize external system and expose it to consumers
    setProvider(p);

    // Poll connection status briefly for state sync
    const interval = setInterval(() => {
      setIsConnected(p.isConnected);
    }, 500);

    p.connect();

    return () => {
      clearInterval(interval);
      p.disconnect();
      setProvider(null);
      setIsConnected(false);
    };
  }, [pageUuid, token, ydoc]);

  return {
    ydoc,
    provider,
    isConnected,
  };
}
