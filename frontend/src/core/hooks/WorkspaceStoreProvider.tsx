import { useMemo, type ReactNode } from 'react';
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
  const value = useMemo(
    () => ({ actorId, transport }),
    [actorId, transport]
  );
  return (
    <WorkspaceStoreContext.Provider value={value}>
      {children}
    </WorkspaceStoreContext.Provider>
  );
}
