/**
 * useCurrentNodeUuid — return the UUID of the node currently in the URL, if any.
 */
import { useParams } from 'react-router-dom';
import { isUuid } from '@/utils/uuid';

export function useCurrentNodeUuid(): string | null {
  const params = useParams();
  const entityUuid = params['*'];
  return entityUuid && isUuid(entityUuid) ? entityUuid : null;
}
