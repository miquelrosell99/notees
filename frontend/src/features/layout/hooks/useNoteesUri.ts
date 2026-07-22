/**
 * useNoteesUri Hook
 * 
 * Provides navigation via notees: URIs.
 * Resolves UUIDs to node IDs and navigates to them.
 * 
 * Usage:
 *   const { navigateToUri } = useNoteesUri();
 *   navigateToUri('notees:550e8400-e29b-41d4-a716-446655440000');
 */
import { useCallback } from 'react';
import type { Node } from '@/types/api';
import { useNavigationStore } from '@/stores';
import { useCurrentWorkspaceUuid } from '@/hooks/useCurrentWorkspaceUuid';
import { useWorkspaceStoreClient } from '@/core/hooks/useWorkspaceStoreClient';
import { parseNoteesUri } from '@/lib/noteesUri';
import { getLogger } from '@/utils/logger';

const log = getLogger('NoteesUri');

/**
 * Hook that provides navigation via notees: URIs.
 */
export function useNoteesUri() {
  const openNode = useNavigationStore(state => state.openNode);
  const workspaceUuid = useCurrentWorkspaceUuid();
  const { client } = useWorkspaceStoreClient(workspaceUuid ?? '');

  /** Navigate to a node by its UUID */
  const navigateToUuid = useCallback(async (nodeUuid: string): Promise<boolean> => {
    if (!client) {
      log.warn('Workspace store client not available for URI navigation', { nodeUuid });
      return false;
    }
    const node = await client.query<Node | undefined>('getNodeByUuid', [nodeUuid]);
    if (node?.uuid) {
      openNode(node.uuid);
      return true;
    }
    log.warn('Node not found for UUID', { nodeUuid });
    return false;
  }, [openNode, client]);

  /** Navigate to a node by its notees: URI */
  const navigateToUri = useCallback(async (uri: string): Promise<boolean> => {
    const nodeUuid = parseNoteesUri(uri);
    if (!nodeUuid) {
      log.warn('Invalid notees URI', { uri });
      return false;
    }
    return navigateToUuid(nodeUuid);
  }, [navigateToUuid]);

  return { navigateToUri, navigateToUuid };
}
