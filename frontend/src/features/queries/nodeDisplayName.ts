/**
 * Class-aware node display-name helpers.
 *
 * These build on top of `nodeNameToText` and add date-formatting only for
 * nodes that carry one of the system date classes (day/month/year).
 */
import type { Node } from '@/types';
import { SYSTEM_CLASS_UUIDS } from '@/constants/systemProperties';
import { formatDatePageContent } from '@/utils/datePageDisplay';
import { nodeNameToText } from './hooks/useStringifyAST';
import { useSettingsStore, type DateFormat } from '@/stores';

const DATE_CLASS_UUIDS: Set<string> = new Set([
  SYSTEM_CLASS_UUIDS.day,
  SYSTEM_CLASS_UUIDS.month,
  SYSTEM_CLASS_UUIDS.year,
]);

export interface NodeDisplayNameOptions {
  maxLength?: number;
  dateFormat?: DateFormat;
}

/**
 * Convert a node's name into the text that should be displayed to the user.
 *
 * - Returns `''` for missing/empty nodes so callers can apply their own fallback.
 * - For date-class nodes, formats compact date content using the user's
 *   `dateFormat` preference.
 * - For all other nodes, returns the raw text extracted by `nodeNameToText`.
 */
export function nodeNameToDisplayText(
  node: Node | null | undefined,
  options?: NodeDisplayNameOptions,
): string {
  if (!node) return '';
  const raw = nodeNameToText(node.name, options?.maxLength);
  if (!raw) return '';

  const isDatePage = node.classes_uuid?.some((id) => DATE_CLASS_UUIDS.has(id));
  if (!isDatePage) return raw;

  const dateFormat = options?.dateFormat ?? useSettingsStore.getState().dateFormat;
  return formatDatePageContent(raw, dateFormat) ?? raw;
}

/**
 * React hook that returns a node's display name and reacts to date-format
 * preference changes.
 */
export function useNodeDisplayName(
  node: Node | null | undefined,
  fallback = 'Untitled',
): string {
  const dateFormat = useSettingsStore((s) => s.dateFormat);
  return nodeNameToDisplayText(node, { dateFormat }) || fallback;
}
