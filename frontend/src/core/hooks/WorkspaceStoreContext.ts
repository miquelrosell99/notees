import { createContext } from 'react';
import type { Transport } from '../transport';

export interface WorkspaceStoreContextValue {
  actorId: string;
  cryptoKey: CryptoKey;
  transport: Transport;
}

export const WorkspaceStoreContext = createContext<WorkspaceStoreContextValue | undefined>(undefined);
