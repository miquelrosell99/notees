import { useCallback, useMemo } from 'react';
import type { Node } from '@/types';
import { useNavigationStore } from '@/stores';
import { useKeyboardListNav } from '@/hooks/useKeyboardListNav';
import type { CommandPaletteProps, ItemEntry, GroupedItems } from './CommandPalette.types';
import { useCommandPaletteState } from './useCommandPaletteState';
import { useCommandPaletteItems } from './useCommandPaletteItems';
import { useCommandPaletteSelection } from './useCommandPaletteSelection';

export function useCommandPalette({ isOpen, onClose, onSelect }: CommandPaletteProps) {
  const state = useCommandPaletteState({ isOpen, onClose });

  const allItems = useCommandPaletteItems({
    rawPages: state.rawPages,
    rawBlocks: state.rawBlocks,
    rawProperties: state.rawProperties,
    searchTerm: state.searchTerm,
    pageNameForCreation: state.pageNameForCreation,
    selectedClasses: state.selectedClasses,
    parsedDate: state.parsedDate,
    existingDateNode: state.existingDateNode,
    commands: state.commands,
    pageMap: state.pageMap,
    recentAccessedPages: state.recentAccessedPages,
    recentCreatedPages: state.recentCreatedPages,
    randomPages: state.randomPages,
    maxPages: state.maxPages,
    maxBlocks: state.maxBlocks,
    maxProperties: state.maxProperties,
    uuidSearch: state.uuidSearch,
    appliedFilters: state.appliedFilters,
    isTypingBoolean: state.isTypingBoolean,
    booleanOptions: state.booleanOptions,
    suggestedPrefixes: state.suggestedPrefixes,
    activeFilter: state.activeFilter,
    formatParsedDateLabel: state.formatParsedDateLabel,
  });

  const { handleSelect } = useCommandPaletteSelection({
    allItems,
    searchTerm: state.searchTerm,
    pageNameForCreation: state.pageNameForCreation,
    selectedClasses: state.selectedClasses,
    pageClassId: state.pageClassId,
    destinationPage: state.destinationPage,
    onSelect,
    onClose,
    handlePrefixSelect: state.handlePrefixSelect,
    handleBooleanSelect: state.handleBooleanSelect,
    setDuplicateModal: state.setDuplicateModal,
    setMaxPages: state.setMaxPages,
    setMaxBlocks: state.setMaxBlocks,
    setMaxProperties: state.setMaxProperties,
  });

  // Keyboard list navigation
  const { selectedIndex, handleKeyDown: listKeyDown } = useKeyboardListNav({
    totalItems: allItems.length,
    onSelect: handleSelect,
    onClose,
    isOpen,
  });

  const { openNodeCollectionFromNodes, openNode } = useNavigationStore();

  // Wrap to let SuggestionPopup handle keyboard when class popup is open
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (state.isTypingClass) {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
      return;
    }
    // Ctrl+Enter opens all search results in a temporary NodeCollection view
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      if (state.searchResults && state.searchResults.length > 0) {
        e.preventDefault();
        e.stopPropagation();
        openNodeCollectionFromNodes(
          state.searchTerm.trim() ? `Search: "${state.searchTerm}"` : 'Search results',
          state.searchResults as Node[],
        );
        onClose();
        return;
      }
      // Fall back to quick-add when no search results
      const quickAddIndex = allItems.findIndex(item => item.type === 'quick-add');
      if (quickAddIndex !== -1) {
        e.preventDefault();
        e.stopPropagation();
        handleSelect(quickAddIndex);
        return;
      }
    }
    listKeyDown(e);
  }, [state.isTypingClass, state.searchResults, state.searchTerm, allItems, handleSelect, listKeyDown, onClose, openNodeCollectionFromNodes]);

  // Group items for rendering — pre-compute index maps to avoid O(n²) indexOf in JSX
  const groupedItems = useMemo<GroupedItems>(() => {
    const dateItems: ItemEntry[] = [];
    const pageItems: ItemEntry[] = [];
    const blockItems: ItemEntry[] = [];
    const propertyItems: ItemEntry[] = [];
    const quickAddItems: ItemEntry[] = [];
    const commandItems: ItemEntry[] = [];
    const filterPrefixItems: ItemEntry[] = [];
    const booleanOptionItems: ItemEntry[] = [];
    const browseRecentAccessed: ItemEntry[] = [];
    const browseRecentCreated: ItemEntry[] = [];
    const browseRandom: ItemEntry[] = [];
    const indexMap = new Map<ItemEntry, number>();

    for (let i = 0; i < allItems.length; i++) {
      const item = allItems[i];
      indexMap.set(item, i);
      switch (item.type) {
        case 'date': dateItems.push(item); break;
        case 'page': case 'add-page': pageItems.push(item); break;
        case 'block': blockItems.push(item); break;
        case 'property': propertyItems.push(item); break;
        case 'quick-add': quickAddItems.push(item); break;
        case 'command': commandItems.push(item); break;
        case 'filter-prefix': filterPrefixItems.push(item); break;
        case 'boolean-option': booleanOptionItems.push(item); break;
        case 'show-more':
          if (item.showMoreSection === 'pages') pageItems.push(item);
          else if (item.showMoreSection === 'blocks') blockItems.push(item);
          else if (item.showMoreSection === 'properties') propertyItems.push(item);
          break;
        case 'browse-page':
          if (item.browseSection === 'recent-accessed') browseRecentAccessed.push(item);
          else if (item.browseSection === 'recent-created') browseRecentCreated.push(item);
          else if (item.browseSection === 'random') browseRandom.push(item);
          break;
      }
    }
    return { dateItems, pageItems, blockItems, propertyItems, quickAddItems, commandItems, filterPrefixItems, booleanOptionItems, browseRecentAccessed, browseRecentCreated, browseRandom, indexMap };
  }, [allItems]);

  return {
    query: state.query,
    setQuery: state.setQuery,
    appliedFilters: state.appliedFilters,
    classPopupPosition: state.classPopupPosition,
    duplicateModal: state.duplicateModal,
    setDuplicateModal: state.setDuplicateModal,
    inputRef: state.inputRef,
    containerRef: state.containerRef,
    isOpen,
    isTypingClass: state.isTypingClass,
    isTypingFilter: state.isTypingFilter,
    classQuery: state.classQuery,
    isTypingBoolean: state.isTypingBoolean,
    booleanOptions: state.booleanOptions,
    suggestedPrefixes: state.suggestedPrefixes,
    isLoading: state.isLoading,
    searchTerm: state.searchTerm,
    debouncedSearchTerm: state.debouncedSearchTerm,
    uuidSearch: state.uuidSearch,
    parsedDate: state.parsedDate,
    pathInfo: state.pathInfo,
    allItems,
    selectedIndex,
    handleKeyDown,
    handleSelect,
    handleClassSelect: state.handleClassSelect,
    handleRemoveFilter: state.handleRemoveFilter,
    handleBooleanSelect: state.handleBooleanSelect,
    handlePrefixSelect: state.handlePrefixSelect,
    handleClassCreate: state.handleClassCreate,
    handleBackdropClick: state.handleBackdropClick,
    refreshRandomPages: state.refreshRandomPages,
    groupedItems,
    pageClassId: state.pageClassId,
    allClasses: state.allClasses,
    allPages: state.allPages,
    searchResults: state.searchResults,
    openNode,
  };
}
