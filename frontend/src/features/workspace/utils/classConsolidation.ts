/**
 * Validation for the opt-in class consolidation tool (Decision 26).
 *
 * The mapping is always an explicit old→new class-UUID pair chosen by the
 * user — equivalence is never guessed from names.
 */
import { SYSTEM_CLASS_UUIDS } from '@/constants/systemProperties';

export interface WorkspaceClassInfo {
  id: string;
  name: string;
  is_system: boolean;
}

const SYSTEM_CLASS_UUID_SET = new Set<string>(Object.values(SYSTEM_CLASS_UUIDS));

/**
 * Validate a consolidation mapping. Returns an error message or null.
 */
export function validateConsolidationMapping(
  oldClassUuid: string | null,
  newClassUuid: string | null,
): string | null {
  if (!oldClassUuid || !newClassUuid) {
    return 'Select both the class to consolidate and the target class';
  }
  if (oldClassUuid === newClassUuid) {
    return 'The class to consolidate and the target class must differ';
  }
  if (SYSTEM_CLASS_UUID_SET.has(oldClassUuid)) {
    return 'System classes cannot be consolidated away';
  }
  return null;
}
