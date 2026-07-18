import type { ReactNode } from 'react';
import { WorkspaceStoreContext, type WorkspaceStoreContextValue } from './WorkspaceStoreContext';

export interface WorkspaceStoreProviderProps {
  actorId: string;
  cryptoKey: CryptoKey;
  transport: WorkspaceStoreContextValue['transport'];
  children: ReactNode;
}

export function WorkspaceStoreProvider({
  actorId,
  cryptoKey,
  transport,
  children,
}: WorkspaceStoreProviderProps): React.ReactElement {
  return (
    <WorkspaceStoreContext.Provider value={{ actorId, cryptoKey, transport }}>
      {children}
    </WorkspaceStoreContext.Provider>
  );
}
