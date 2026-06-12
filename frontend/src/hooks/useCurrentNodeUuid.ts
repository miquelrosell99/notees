/**
 * useCurrentNodeUuid — return the UUID of the node currently in the URL, if any.
 */
import { useParams } from 'react-router-dom';
import { isUuid } from './useRouter';

export function useCurrentNodeUuid(): string | null {
  const { entityUuid } = useParams<{ entityUuid?: string }>();
  return entityUuid && isUuid(entityUuid) ? entityUuid : null;
}
