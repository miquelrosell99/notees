import { useMemo } from 'react';
import type { Node } from '@/types';
import type { RecentPage } from '@/api/nodes';
import type { Command } from '@/stores/commandRegistry';
import type { ItemEntry, AppliedFilter, FilterPrefixConfig } from './CommandPalette.types';
import type { Property } from '@/types';

import { nodeNameToText } from '@/features/queries';
import type { ParsedDate } from '@/utils/dateParser';

interface UseCommandPaletteItemsParams {
  rawPages: Array<{ node: Node; breadcrumb?: string }>;
  rawBlocks: Array<{ node: Node; breadcrumb?: string }>;
  rawProperties: Property[];
  searchTerm: string;
  pageNameForCreation: string;
  selectedClasses: Node[];
  parsedDate: ParsedDate | null;
  existingDateNode: Node | null;
  commands: Command[];
  pageMap: Map<number, Node>;
  recentAccessedPages: RecentPage[];
  recentCreatedPages: RecentPage[];
  randomPages: RecentPage[];
  maxPages: number;
  maxBlocks: number;
  maxProperties: number;
  uuidSearch: string | null;
  appliedFilters: AppliedFilter[];
  isTypingBoolean: boolean;
  booleanOptions: string[];
  suggestedPrefixes: FilterPrefixConfig[];
  activeFilter: { prefix: string; value: string; config: FilterPrefixConfig } | null;
  formatParsedDateLabel: (pd: ParsedDate) => string;
  currentNodeUuid: string | null;
  showDevOptions: boolean;
  isTypingColon: boolean;
}

export function useCommandPaletteItems(params: UseCommandPaletteItemsParams): ItemEntry[] {
  const {
    rawPages,
    rawBlocks,
    rawProperties,
    searchTerm,
    pageNameForCreation,
    selectedClasses,
    parsedDate,
    existingDateNode,
    commands,
    pageMap,
    recentAccessedPages,
    recentCreatedPages,
    randomPages,
    maxPages,
    maxBlocks,
    maxProperties,
    uuidSearch,
    appliedFilters,
    isTypingBoolean,
    booleanOptions,
    suggestedPrefixes,
    activeFilter,
    formatParsedDateLabel,
    currentNodeUuid,
    showDevOptions,
    isTypingColon,
  } = params;

  return useMemo<ItemEntry[]>(() => {
    const items: ItemEntry[] = [];

    // While the standalone-colon filter popup is open, don't show any results
    if (isTypingColon) {
      return items;
    }

    // When no query and no filters, show browse sections
    if (!searchTerm.trim() && !uuidSearch && appliedFilters.length === 0) {
      for (const page of recentAccessedPages) {
        items.push({ type: 'browse-page', result: { node: page as unknown as Node, type: 'page' }, browseSection: 'recent-accessed' });
      }
      for (const page of recentCreatedPages) {
        items.push({ type: 'browse-page', result: { node: page as unknown as Node, type: 'page' }, browseSection: 'recent-created' });
      }
      for (const page of randomPages) {
        items.push({ type: 'browse-page', result: { node: page as unknown as Node, type: 'page' }, browseSection: 'random' });
      }
      return items;
    }

    // Boolean option dropdown — when typing a boolean filter like is_page:
    if (isTypingBoolean && booleanOptions.length > 0) {
      for (const opt of booleanOptions) {
        items.push({ type: 'boolean-option', label: `${activeFilter!.prefix}:${opt}`, booleanValue: opt === 'true' });
      }
      return items;
    }

    // Filter prefix suggestions — when typing partial prefix
    if (suggestedPrefixes.length > 0) {
      for (const fp of suggestedPrefixes) {
        items.push({ type: 'filter-prefix', label: `${fp.prefix}: — ${fp.description}`, filterPrefix: fp });
      }
    }

    // Commands section — show first when user is searching
    if (searchTerm.trim() && !uuidSearch) {
      const lowerSearch = searchTerm.toLowerCase();
      for (const cmd of commands) {
        if (cmd.requiresPage && !currentNodeUuid) continue;
        if (cmd.devOnly && !showDevOptions) continue;
        if (cmd.label.toLowerCase().includes(lowerSearch)) {
          items.push({ type: 'command', label: cmd.label, commandId: cmd.id });
        }
      }
    }

    // Date suggestion (shown at top if query matches a date format)
    if (parsedDate) {
      const formattedDate = formatParsedDateLabel(parsedDate);
      const dateTypeLabel = parsedDate.type === 'day' ? 'daily' : parsedDate.type === 'month' ? 'monthly' : 'yearly';
      if (existingDateNode) {
        items.push({ type: 'date', label: `Go to ${dateTypeLabel} page: ${formattedDate}`, parsedDate, existingNode: existingDateNode });
      } else {
        items.push({ type: 'date', label: `Create ${dateTypeLabel} page: ${formattedDate}`, parsedDate });
      }
    }

    // Pages section — capped to maxPages (expandable)
    const displayedPages = rawPages.slice(0, maxPages);
    displayedPages.forEach(({ node }) => {
      // Build ancestor breadcrumb using allPages map (worker only has search results)
      let breadcrumb: string | undefined;
      if (node.parent_id != null) {
        const parts: string[] = [];
        let current = pageMap.get(node.parent_id);
        while (current) {
          parts.unshift(nodeNameToText(current.name) || 'Untitled');
          current = current.parent_id != null ? pageMap.get(current.parent_id) : undefined;
        }
        if (parts.length > 0) breadcrumb = parts.join(' / ');
      }
      items.push({ type: 'page', result: { node, type: 'page', breadcrumb } });
    });
    if (rawPages.length > maxPages) {
      items.push({ type: 'show-more', showMoreSection: 'pages', showMoreCount: rawPages.length - maxPages });
    }

    // Add page option — always show when there's a name to create
    const classLabels = selectedClasses.length > 0
      ? ` with ${selectedClasses.length === 1 ? `class "${nodeNameToText(selectedClasses[0].name)}"` : `${selectedClasses.length} classes`}`
      : '';
    const hasExactMatch = displayedPages.some(({ node }) => nodeNameToText(node.name)?.toLowerCase() === pageNameForCreation.toLowerCase());
    if (pageNameForCreation) {
      const label = hasExactMatch
        ? `Create another "${pageNameForCreation}"${classLabels || ' (pick a class to differentiate)'}`
        : `Create page "${pageNameForCreation}"${classLabels}`;
      items.push({ type: 'add-page', label });
    }

    // Blocks section — capped to maxBlocks (expandable)
    const displayedBlocks = rawBlocks.slice(0, maxBlocks);
    displayedBlocks.forEach(({ node, breadcrumb }) =>
      items.push({ type: 'block', result: { node, type: 'block', breadcrumb } }),
    );
    if (rawBlocks.length > maxBlocks) {
      items.push({ type: 'show-more', showMoreSection: 'blocks', showMoreCount: rawBlocks.length - maxBlocks });
    }

    // Properties section — capped to maxProperties (expandable)
    const displayedProperties = rawProperties.slice(0, maxProperties);
    displayedProperties.forEach(prop =>
      items.push({ type: 'property', result: { property: prop, type: 'property' } }),
    );
    if (rawProperties.length > maxProperties) {
      items.push({ type: 'show-more', showMoreSection: 'properties', showMoreCount: rawProperties.length - maxProperties });
    }

    // Quick add option
    if (searchTerm.trim()) {
      items.push({ type: 'quick-add', label: `Quick add: "${searchTerm}"` });
    }

    return items;
  }, [
    rawPages, rawBlocks, rawProperties, searchTerm, pageNameForCreation, selectedClasses,
    parsedDate, existingDateNode, commands, pageMap, recentAccessedPages, recentCreatedPages,
    randomPages, maxPages, maxBlocks, maxProperties, uuidSearch, appliedFilters, isTypingBoolean,
    booleanOptions, suggestedPrefixes, activeFilter, formatParsedDateLabel, currentNodeUuid,
    showDevOptions, isTypingColon,
  ]);
}
