import type { UseQueryResult } from '@tanstack/react-query';
import type { ClassProperty } from '@/types/api';
import {
  useClassPropertiesLegacy,
  useNodeClassPropertyEdgesLegacy,
} from '@/features/properties/hooks/useClassProperties';
import { ENABLE_SQLITE_STORE } from '../utils/featureFlags';

/**
 * Adapter for fetching properties linked to a class.
 *
 * TODO(D3): full class-property edge derivation is out of scope for the
 * prototype slice. Returns an empty list in SQLite mode.
 */
export function useClassPropertiesAdapter(
  classId: string | null,
  includeInherited: boolean = false
): UseQueryResult<ClassProperty[], Error> {
  const legacyResult = useClassPropertiesLegacy(classId, includeInherited);

  if (!ENABLE_SQLITE_STORE) {
    return legacyResult as UseQueryResult<ClassProperty[], Error>;
  }

  // TODO(D3): derive class-property edges from the SQLite schema once implemented.
  void classId;
  void includeInherited;
  return {
    data: [],
    isLoading: false,
    isError: false,
    error: null,
    isPending: false,
    isSuccess: true,
    status: 'success',
    fetchStatus: 'idle',
  } as unknown as UseQueryResult<ClassProperty[], Error>;
}

/**
 * Adapter for fetching class-property edges for all classes of a node.
 *
 * TODO(D3): full class-property edge derivation is out of scope for the
 * prototype slice. Returns an empty list in SQLite mode.
 */
export function useNodeClassPropertyEdgesAdapter(classUuids: string[]): ClassProperty[] {
  const legacyResult = useNodeClassPropertyEdgesLegacy(classUuids);

  if (!ENABLE_SQLITE_STORE) {
    return legacyResult;
  }

  // TODO(D3): derive class-property edges from the SQLite schema once implemented.
  void classUuids;
  return [];
}
