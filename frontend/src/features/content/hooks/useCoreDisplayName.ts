/**
 * useCoreDisplayName — Live display name from the local-first core store.
 *
 * Replaces the legacy runtime overlay hook for observers (inline links, pills,
 * breadcrumbs, recents/favorites) that must reflect a referenced block's content
 * the moment it is edited elsewhere.
 */
import { useParams } from 'react-router-dom';
import { useNode } from '@/core/hooks';
import { nodeNameToText } from '@/features/queries';

export function useCoreDisplayName(nodeUuid: string | null | undefined, fallback = ''): string {
  const { workspaceId } = useParams<{ workspaceId?: string }>();
  const { node } = useNode(workspaceId ?? '', nodeUuid ?? undefined);
  if (!node?.content) return fallback;
  return nodeNameToText(node.content) || fallback;
}
