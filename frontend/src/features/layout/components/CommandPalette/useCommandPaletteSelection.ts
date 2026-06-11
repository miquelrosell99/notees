import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Node } from '@/types';
import type { QueryAST, StyleCondition } from '@/types/queryAST';
import { createEmptyQueryAST } from '@/types/queryAST';
import { SYSTEM_CLASS_UUIDS } from '@/constants/systemProperties';
import {
  buildTasksQueryAST,
  buildTodayQueryAST,
} from '@/utils/taskQueries';
import {
  listNodes,
  getOrCreateDaily,
  getOrCreateMonthly,
  getOrCreateYearly,
  getRandomPages,
} from '@/api/nodes';
import { resetNodeViews } from '@/api/nodeViews';
import { useNavigationStore, useModalStore, useSettingsStore, usePresentationStore } from '@/stores';
import { useCommandRegistry } from '@/stores/commandRegistry';
import { useNotifications } from '@/stores/notificationStore';
import { useCreateNode, useUpdateNode } from '@/hooks';
import { nodeKeys } from '@/hooks/queryKeys';
import { nodeViewKeys } from '@/hooks/useNodeViews';
import { parseHierarchicalPath, resolveHierarchicalParent } from '@/utils/hierarchicalPath';
import type { ItemEntry, DuplicateModalState } from './CommandPalette.types';

interface UseCommandPaletteSelectionParams {
  allItems: ItemEntry[];
  searchTerm: string;
  pageNameForCreation: string;
  selectedClasses: Node[];
  pageClassId: number | null | undefined;
  allClasses: Node[] | undefined;
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
    allClasses,
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
  const updateNode = useUpdateNode();
  const { openNode, openPropertyView, openNodeCollection } = useNavigationStore();
  const { error: notifyError, warning: notifyWarning, success: notifySuccess } = useNotifications();
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
            queryClient.invalidateQueries({ queryKey: [...nodeKeys.all, 'pages'] });
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
        const handleCommand = async () => {
          if (item.commandId === 'import-logseq') {
            useModalStore.getState().setImportLogseqModalOpen(true);
          } else if (item.commandId === 'import-logseq-folder') {
            useModalStore.getState().setImportLogseqFolderModalOpen(true);
          } else if (item.commandId === 'import-markdown') {
            useModalStore.getState().setImportMarkdownModalOpen(true);
          } else if (item.commandId === 'export-page') {
            const currentId = useNavigationStore.getState().currentNodeId;
            if (currentId) useModalStore.getState().setExportPageModalOpen(true);
          } else if (item.commandId === 'rebuild-links') {
            useModalStore.getState().setRebuildLinksModalOpen(true);
          } else if (item.commandId === 'fix-raw-links') {
            useModalStore.getState().setFixRawLinksModalOpen(true);
          } else if (item.commandId === 'merge-pages') {
            useModalStore.getState().setMergePagesModalOpen(true);
            onClose();
            return;
          } else if (item.commandId === 'toggle-focus-mode') {
            useCommandRegistry.getState().executeCommand('ui.focusMode');
          } else if (item.commandId === 'create-page-with-uuid') {
            useModalStore.getState().setCreateWithUuidModalOpen(true);
            onClose();
            return;
          } else if (item.commandId === 'reset-views') {
            const currentId = useNavigationStore.getState().currentNodeId;
            if (currentId) {
              try {
                await resetNodeViews(currentId);
                queryClient.removeQueries({ queryKey: nodeViewKeys.details() });
                queryClient.removeQueries({ queryKey: nodeViewKeys.queryResults() });
                queryClient.invalidateQueries({ queryKey: nodeViewKeys.list(currentId) });
                queryClient.invalidateQueries({ queryKey: nodeViewKeys.byType(currentId) });
                notifySuccess('Views reset', 'All views for this node have been reset to defaults.');
              } catch {
                notifyError('Failed to reset views', 'Please try again.');
              }
            }
          } else if (item.commandId === 'open-random-page') {
            try {
              const pages = await getRandomPages(1);
              if (pages.length > 0) {
                openNode(pages[0].id);
              } else {
                notifyWarning('No pages', 'No pages found in workspace.');
              }
            } catch {
              notifyError('Failed to open random page', 'Please try again.');
            }
          } else if (item.commandId === 'toggle-minimap') {
            useModalStore.getState().toggleMinimap();
          } else if (item.commandId === 'toggle-wide-mode') {
            useSettingsStore.getState().toggleWideMode();
          } else if (item.commandId === 'start-presentation') {
            const currentId = useNavigationStore.getState().currentNodeId;
            if (currentId) {
              usePresentationStore.getState().openPresentation(currentId);
            }
          } else if (item.commandId === 'toggle-local-graph') {
            const currentId = useNavigationStore.getState().currentNodeId;
            if (currentId) useNavigationStore.getState().openLocalGraph(currentId);
          } else if (item.commandId === 'share-page') {
            const currentId = useNavigationStore.getState().currentNodeId;
            if (currentId) useModalStore.getState().setShareModalOpen(true);
          } else if (item.commandId === 'toggle-private') {
            const currentId = useNavigationStore.getState().currentNodeId;
            if (currentId) {
              const allDetails = queryClient.getQueriesData<Node>({ queryKey: nodeKeys.details() });
              const currentNodeEntry = allDetails.find(([key]) => Array.isArray(key) && key[2] === currentId);
              const currentNode = currentNodeEntry?.[1];
              if (currentNode) {
                updateNode.mutate({ id: currentId, data: { is_private: !currentNode.is_private } });
              } else {
                notifyWarning('Cannot toggle privacy', 'Page data is not loaded. Please try again.');
              }
            } else {
              notifyWarning('No page active', 'Open a page to toggle its privacy.');
            }
          } else if (item.commandId === 'force-reexport-markdown') {
            useModalStore.getState().setAutoExportProgressModalOpen(true);
          } else if (item.commandId === 'open-broken-links') {
            const brokenLinksQuery: QueryAST = {
              ...createEmptyQueryAST(),
              scope: { type: 'scope', scope_type: 'entire_workspace' },
              root_group: {
                type: 'group',
                logic: 'AND',
                children: [
                  {
                    type: 'condition',
                    condition_type: 'style',
                    style_type: 'broken_link',
                    operator: 'is',
                  } as StyleCondition,
                ],
              },
            };
            openNodeCollection('Broken links', brokenLinksQuery);
          } else if (item.commandId === 'open-tasks') {
            openNodeCollection('Tasks', buildTasksQueryAST());
          } else if (item.commandId === 'open-today') {
            openNodeCollection('Today', buildTodayQueryAST());
          } else if (item.commandId === 'capture-task') {
            if (!pageClassId) {
              notifyWarning('Setup incomplete', 'Page class not found. Please reload the app.');
              onClose();
              return;
            }
            const taskClassId = allClasses?.find(c => c.uuid === SYSTEM_CLASS_UUIDS.task)?.id;
            if (!taskClassId) {
              notifyWarning('Setup incomplete', 'Task class not found. Please reload the app.');
              onClose();
              return;
            }
            try {
              const newNode = await createNodeMutation.mutateAsync({
                name: 'New Task',
                classes: [pageClassId, taskClassId],
              });
              openNode(newNode.id);
            } catch {
              notifyError('Failed to create task', 'Please try again.');
            }
          }
          onClose();
        };
        handleCommand();
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
    allClasses, destinationPage, onSelect, openNode, openPropertyView, openNodeCollection, createNodeMutation,
    onClose, queryClient, handlePrefixSelect, handleBooleanSelect,
    setDuplicateModal, setMaxPages, setMaxBlocks, setMaxProperties,
    notifyError, notifyWarning, notifySuccess, updateNode,
  ]);

  return { handleSelect };
}
