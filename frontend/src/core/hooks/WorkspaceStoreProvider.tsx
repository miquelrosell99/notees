import type { ReactNode } from 'react';
import { WorkspaceStoreContext, type WorkspaceStoreContextValue } from './WorkspaceStoreContext';

export interface WorkspaceStoreProviderProps {
  actorId: string;
  transport: WorkspaceStoreContextValue['transport'];
  children: ReactNode;
}

export function WorkspaceStoreProvider({
  actorId,
  transport,
  children,
}: WorkspaceStoreProviderProps): React.ReactElement {
  return (
    <WorkspaceStoreContext.Provider value={{ actorId, transport }}>
      {children}
    </WorkspaceStoreContext.Provider>
  );
}
