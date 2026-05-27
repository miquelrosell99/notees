import type { Node } from '@/types';

/**
 * Filter prefix configuration for search filter syntax.
 * Supports: class dropdown, text input (uuid), and boolean dropdowns.
 */
export interface FilterPrefixConfig {
  prefix: string;
  label: string;
  description: string;
  type: 'class' | 'text' | 'boolean';
  options?: string[]; // For boolean type
}

export const FILTER_PREFIXES: FilterPrefixConfig[] = [
  { prefix: 'uuid', label: 'UUID', description: 'Find node by UUID', type: 'text' },
  { prefix: 'class', label: 'Class', description: 'Filter by class', type: 'class' },
  { prefix: 'is_page', label: 'Is Page', description: 'Filter pages or blocks', type: 'boolean', options: ['true', 'false'] },
  { prefix: 'is_class', label: 'Is Class', description: 'Filter class definitions', type: 'boolean', options: ['true', 'false'] },
  { prefix: 'is_daily', label: 'Is Daily', description: 'Filter daily notes', type: 'boolean', options: ['true', 'false'] },
];

/** An applied filter (shown as a pill below the input) */
export type AppliedFilter =
  | { type: 'class'; classNode: Node }
  | { type: 'boolean'; prefix: string; label: string; value: boolean };

export interface ParsedFilters {
  /** Remaining search text after removing filter syntax */
  searchTerm: string;
  /** Active filter being typed (prefix:value in progress) */
  activeFilter: { prefix: string; value: string; config: FilterPrefixConfig } | null;
  /** Whether user is actively typing a filter value */
  isTypingFilter: boolean;
  /** Matching prefix suggestions (when user types partial prefix without colon) */
  suggestedPrefixes: FilterPrefixConfig[];
  /** UUID being searched for (when query is uuid:value) */
  uuidSearch: string | null;
}

/**
 * Parse query for filter prefix syntax (prefix:value).
 * Replaces the old @classname system with a general property:value approach.
 *
 * Examples:
 *   "Pokemon class:crea" -> typing class filter, classQuery="crea"
 *   "uuid:abc-123" -> UUID search
 *   "is_page:true" -> boolean filter applied
 *   "hello cla" -> suggests "class:" prefix
 */
export function parseQueryWithFilters(query: string, appliedFilters: AppliedFilter[]): ParsedFilters {
  // Check for active filter being typed: "text prefix:value" at end of query
  const filterMatch = query.match(/^(.*?)(\S+):(\S*)$/);
  if (filterMatch) {
    const beforeFilter = filterMatch[1].trim();
    const prefix = filterMatch[2].toLowerCase();
    const value = filterMatch[3];
    const config = FILTER_PREFIXES.find(f => f.prefix === prefix);

    if (config) {
      // UUID is a direct search, not a filter pill
      if (config.type === 'text') {
        return {
          searchTerm: beforeFilter,
          activeFilter: { prefix, value, config },
          isTypingFilter: true,
          suggestedPrefixes: [],
          uuidSearch: prefix === 'uuid' && value ? value : null,
        };
      }

      // Boolean filter: check if value is complete
      if (config.type === 'boolean') {
        return {
          searchTerm: beforeFilter,
          activeFilter: { prefix, value, config },
          isTypingFilter: true,
          suggestedPrefixes: [],
          uuidSearch: null,
        };
      }

      // Class filter: show dropdown
      return {
        searchTerm: beforeFilter,
        activeFilter: { prefix, value, config },
        isTypingFilter: true,
        suggestedPrefixes: [],
        uuidSearch: null,
      };
    }
  }

  // Also support the "prefix:" with no value yet (user just typed the colon)
  const colonMatch = query.match(/^(.*?)(\S+):$/);
  if (colonMatch) {
    const prefix = colonMatch[2].toLowerCase();
    const config = FILTER_PREFIXES.find(f => f.prefix === prefix);
    if (config) {
      return {
        searchTerm: colonMatch[1].trim(),
        activeFilter: { prefix, value: '', config },
        isTypingFilter: true,
        suggestedPrefixes: [],
        uuidSearch: null,
      };
    }
  }

  // Check for partial prefix match (user might be starting to type a filter)
  const lastWord = query.match(/(\S+)$/);
  if (lastWord && !lastWord[1].includes(':')) {
    const partial = lastWord[1].toLowerCase();
    // Only suggest if at least 2 chars to avoid noise
    if (partial.length >= 2) {
      // Don't suggest prefixes that are already applied as filters
      const appliedPrefixes = new Set(appliedFilters.filter(f => f.type === 'boolean').map(f => (f as { prefix: string }).prefix));
      const matching = FILTER_PREFIXES.filter(f =>
        f.prefix.startsWith(partial) && !appliedPrefixes.has(f.prefix)
      );
      if (matching.length > 0) {
        return {
          searchTerm: query,
          activeFilter: null,
          isTypingFilter: false,
          suggestedPrefixes: matching,
          uuidSearch: null,
        };
      }
    }
  }

  return { searchTerm: query, activeFilter: null, isTypingFilter: false, suggestedPrefixes: [], uuidSearch: null };
}
