import { useParams } from 'react-router-dom';

/**
 * Return the workspace UUID from the current route params.
 * Returns null when not inside a /:workspaceId/* route.
 */
export function useCurrentWorkspaceUuid(): string | null {
  const params = useParams<{ workspaceId?: string }>();
  return params.workspaceId ?? null;
}
