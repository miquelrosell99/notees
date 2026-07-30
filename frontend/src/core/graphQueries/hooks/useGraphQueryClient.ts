import { useParams } from 'react-router-dom';
import { useWorkspaceStoreClient } from '../../hooks/useWorkspaceStoreClient';
import type { IWorkspaceStoreClient } from '../../worker/workerProtocol';

export interface UseGraphQueryClientResult {
  client: IWorkspaceStoreClient | undefined;
  isLoading: boolean;
  error: Error | null;
}

export function useGraphQueryClient(): UseGraphQueryClientResult {
  const { workspaceId } = useParams<{ workspaceId?: string }>();
  return useWorkspaceStoreClient(workspaceId ?? '');
}
