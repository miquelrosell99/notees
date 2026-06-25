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
import { useNavigationStore } from '@/stores';
import { getNodeByUuid } from '@/api/nodes';
import { parseNoteesUri } from '@/lib/noteesUri';
import { getLogger } from '@/utils/logger';

const log = getLogger('NoteesUri');

/**
 * Hook that provides navigation via notees: URIs.
 */
export function useNoteesUri() {
  const openNode = useNavigationStore(state => state.openNode);

  /** Navigate to a node by its UUID */
  const navigateToUuid = useCallback(async (nodeUuid: string): Promise<boolean> => {
    try {
      const node = await getNodeByUuid(nodeUuid);
      if (node?.id) {
        openNode(node.uuid);
        return true;
      }
      log.warn('Node not found for UUID', { nodeUuid });
      return false;
    } catch (err) {
      log.error('Failed to navigate to node', { nodeUuid, err });
      return false;
    }
  }, [openNode]);

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
