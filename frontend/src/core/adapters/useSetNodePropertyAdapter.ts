import { useMutation, type UseMutationResult } from '@tanstack/react-query';
import { useSetNodePropertyLegacy } from '@/features/properties/hooks/useSetNodeProperty';
import { useSetProperty, useUnsetProperty } from '../hooks';
import { ENABLE_SQLITE_STORE } from '../utils/featureFlags';

/**
 * Adapter for setting or removing a property value on a node. Delegates to the
 * legacy hook when ENABLE_SQLITE_STORE is off; otherwise writes through the
 * SQLite store.
 */
export function useSetNodePropertyAdapter(): UseMutationResult<
  void,
  Error,
  { nodeUuid: string; propertyId: string; value: unknown }
> {
  const legacyResult = useSetNodePropertyLegacy();
  const setProperty = useSetProperty();
  const unsetProperty = useUnsetProperty();

  const sqliteResult = useMutation<void, Error, { nodeUuid: string; propertyId: string; value: unknown }>({
    mutationFn: async ({ nodeUuid, propertyId, value }) => {
      if (value === null) {
        await unsetProperty.mutateAsync({ nodeId: nodeUuid, schemaId: propertyId });
      } else {
        await setProperty.mutateAsync({ nodeId: nodeUuid, schemaId: propertyId, value });
      }
    },
  });

  if (!ENABLE_SQLITE_STORE) {
    return legacyResult as unknown as UseMutationResult<
      void,
      Error,
      { nodeUuid: string; propertyId: string; value: unknown }
    >;
  }
  return sqliteResult;
}
