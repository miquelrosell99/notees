import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Node } from '@/types';
import {
  listNodes,
  getOrCreateDaily,
  getOrCreateMonthly,
  getOrCreateYearly,
} from '@/api/nodes';
import { useNavigationStore } from '@/stores';
import { useCommandRegistry } from '@/stores/commandRegistry';
import { useNotifications } from '@/stores/notificationStore';
import { useCreateNode } from '@/hooks';
import { nodeKeys } from '@/hooks/queryKeys';
import { parseHierarchicalPath, resolveHierarchicalParent } from '@/utils/hierarchicalPath';
import type { ItemEntry, DuplicateModalState } from './CommandPalette.types';

interface UseCommandPaletteSelectionParams {
  allItems: ItemEntry[];
  searchTerm: string;
  pageNameForCreation: string;
  selectedClasses: Node[];
  pageClassId: number | null | undefined;
  destinationPage: Node | undefined;
  onSelect?: (node: Node) => void;
  onClose: () => void;
  handlePrefixSelect: (prefix: string) => void;
  handleBooleanSelect: (value: boolean) => void;
  setDuplicateModal: (state: DuplicateModalState) => void;
  setMaxPages: (updater: React.SetStateAction<number>) => void;
  setMaxBlocks: (updater: React.SetStateAction<number>) => void;
  setMaxProperties: (updater: React.SetStateAction<number>) => void;
}

export function useCommandPaletteSelection(params: UseCommandPaletteSelectionParams) {
  const {
    allItems,
    searchTerm,
    pageNameForCreation,
    selectedClasses,
    pageClassId,
    destinationPage,
    onSelect,
    onClose,
    handlePrefixSelect,
    handleBooleanSelect,
    setDuplicateModal,
    setMaxPages,
    setMaxBlocks,
    setMaxProperties,
  } = params;

  const queryClient = useQueryClient();
  const { openNode, openPropertyView } = useNavigationStore();
  const { error: notifyError, warning: notifyWarning } = useNotifications();
  const createNodeMutation = useCreateNode();

  const handleSelect = useCallback(async (index: number) => {
    const item = allItems[index];
    if (!item) return;

    switch (item.type) {
      case 'date': {
        const pd = item.parsedDate;
        if (!pd) break;
        try {
          let dateNode: Node;
          if (item.existingNode) {
            dateNode = item.existingNode;
          } else {
            if (pd.type === 'day' && pd.month && pd.day) {
              const dateStr = `${pd.year}-${String(pd.month).padStart(2, '0')}-${String(pd.day).padStart(2, '0')}`;
              dateNode = await getOrCreateDaily(dateStr);
            } else if (pd.type === 'month' && pd.month) {
              dateNode = await getOrCreateMonthly(pd.year, pd.month);
            } else {
              dateNode = await getOrCreateYearly(pd.year);
            }
            queryClient.invalidateQueries({ queryKey: nodeKeys.allPages() });
            queryClient.invalidateQueries({ queryKey: nodeKeys.lists() });
            queryClient.invalidateQueries({ queryKey: nodeKeys.dailyList() });
          }
          if (onSelect) {
            onSelect(dateNode);
          } else {
            openNode(dateNode.id);
          }
        } catch {
          notifyError('Failed to navigate to date', 'Could not open or create the date page.');
        }
        onClose();
        break;
      }

      case 'page':
      case 'block':
      case 'browse-page':
        if (item.result?.node) {
          if (onSelect) {
            onSelect(item.result.node);
          } else {
            openNode(item.result.node.id);
          }
        }
        onClose();
        break;

      case 'property':
        if (item.result?.property) {
          openPropertyView(item.result.property.id);
        }
        onClose();
        break;

      case 'add-page':
        try {
          if (!pageClassId) {
            notifyWarning('Setup incomplete', 'Page class not found. Please reload the app.');
            break;
          }

          const parsed = parseHierarchicalPath(pageNameForCreation);
          let parentId: number | null = null;
          const classes = [pageClassId, ...selectedClasses.map(c => c.id)];

          if (parsed.isHierarchical) {
            const freshPages = await listNodes({ pages_only: true, include_children: true });
            parentId = await resolveHierarchicalParent(
              parsed.parentSegments,
              freshPages,
              async (name, parent) => {
                return await createNodeMutation.mutateAsync({
                  name,
                  parent_id: parent,
                  classes: [pageClassId],
                });
              }
            );
          }

          try {
            const newNode = await createNodeMutation.mutateAsync({
              name: parsed.leaf || pageNameForCreation,
              parent_id: parentId,
              classes,
            });
            onClose();
            openNode(newNode.id);
          } catch (createErr: unknown) {
            const axiosErr = createErr as { response?: { status?: number; data?: { detail?: { message?: string; conflicting_classes?: string[] } | string } } };
            if (axiosErr.response?.status === 409) {
              const detail = axiosErr.response.data?.detail;
              const conflicting = typeof detail === 'object' && detail !== null ? (detail.conflicting_classes || []) : [];
              setDuplicateModal({
                isOpen: true,
                pageName: parsed.leaf || pageNameForCreation,
                conflictingClasses: conflicting,
                originalClasses: classes,
                parentId: parentId,
              });
            } else {
              notifyError('Failed to create page', 'Please try again.');
            }
          }
        } catch {
          notifyError('Failed to create page', 'Please try again.');
        }
        break;

      case 'quick-add':
        if (!destinationPage) {
          notifyWarning('No destination', 'Set a Quick Add destination in settings.');
          break;
        }
        try {
          await createNodeMutation.mutateAsync({
            name: searchTerm.trim(),
            parent_id: destinationPage.id,
            classes: selectedClasses.map(c => c.id),
          });
        } catch {
          notifyError('Failed to add item', 'Please try again.');
        }
        onClose();
        break;

      case 'command': {
        if (item.commandId) {
          useCommandRegistry.getState().executeCommand(item.commandId);
        }
        onClose();
        break;
      }

      case 'show-more':
        if (item.showMoreSection === 'pages') setMaxPages(prev => prev + 10);
        else if (item.showMoreSection === 'blocks') setMaxBlocks(prev => prev + 10);
        else if (item.showMoreSection === 'properties') setMaxProperties(prev => prev + 10);
        return;

      case 'filter-prefix':
        if (item.filterPrefix) handlePrefixSelect(item.filterPrefix.prefix);
        return;

      case 'boolean-option':
        if (item.booleanValue !== undefined) handleBooleanSelect(item.booleanValue);
        return;
    }
  }, [
    allItems, searchTerm, pageNameForCreation, selectedClasses, pageClassId,
    destinationPage, onSelect, openNode, openPropertyView, createNodeMutation,
    onClose, queryClient, handlePrefixSelect, handleBooleanSelect,
    setDuplicateModal, setMaxPages, setMaxBlocks, setMaxProperties,
    notifyError, notifyWarning,
  ]);

  return { handleSelect };
}
