/**
 * NodeContent Component
 * 
 * Displays the children blocks of a node using NodeCollection.
 * Provides all block-specific callbacks via NodeCollection's provideBlockCallbacks.
 * 
 * Features:
 * - Block selection support (box select)
 * - Drag and drop reordering (future)
 * - Add block functionality
 * - Support for different display modes (list, document, card)
 * 
 * Used by both page view and block view.
 */
import { useRef, useCallback, useState, useMemo } from 'react';
import { useSetNodeProperty, useProperties } from '@/features/properties';
import { useNodeNavigation, useAddClass, useRemoveClass, useClasses, useUpdateNode } from '@/features/content';
import { useContentSave } from '@/features/editor';
import { useCreateFlashcard } from '@/plugins/builtin/flashcards';
import { stringifyAST, StringifyMode } from '@/lib';
import { useLazyChildren } from '@/features/content/hooks/useLazyChildren';
import { getEffectiveIcon } from '@/utils/nodeIcon';

import type { Node } from '@/types';
// GraphNode type no longer needed here — projection moved to useBlockTree
import type { NodeCollectionViewMode } from '@/types/nodeCollection';
import { NodeCollection } from './NodeCollection';
import { AssetUploadModal } from '@/features/assets';
import { Modal } from '@/components/ui/Modal';
import { NodeSelector } from './NodeSelector';
import { type Asset, type AssetCategory, uploadAsset } from '@/features/assets';
import { createNode } from '@/api/nodes';
import { SYSTEM_CLASS_UUIDS, SYSTEM_PROPERTY_UUIDS } from '@/constants/systemProperties';
import { TableCreationModal, type TableGridSize } from '@/components/ui/TableCreationModal';
import { TemplateVariableDialog } from '../TemplateVariableDialog';
import { useTemplateVariables } from '../../hooks/useTemplates';
import { useAuthStore } from '@/features/auth/stores/authStore';

import './NodeContent.css';
import { getOperationRuntime } from '@/runtime';
import { getAllNodes } from '@/runtime/graphHelpers';
import { upsertNodes } from '@/runtime/eventBus';
import { useQueryClient } from '@tanstack/react-query';
import { getNodeUuidByServerId } from '@/features/content/hooks/useNodeMutations.utils';


interface NodeContentProps {
  /** The parent node whose children to display */
  node: Node;
  /** Children blocks to display (filtered if needed) */
  children: Node[];
  /** Display mode for content */
  displayMode?: 'bullet' | 'document' | 'kanban';
  /** Total children count (before filtering) */
  totalChildrenCount?: number;
  /** Whether content is editable (defaults to true) */
  editable?: boolean;
  /** Whether new blocks can be created (defaults to true) */
  canCreate?: boolean;
}

// Map display mode to NodeCollection view mode
function toViewMode(displayMode: 'bullet' | 'document' | 'kanban'): NodeCollectionViewMode {
  switch (displayMode) {
    case 'bullet': return 'list';
    case 'document': return 'document';
    case 'kanban': return 'kanban';
  }
}

export function NodeContent({ 
  node, 
  children,
  displayMode = 'bullet',
  editable = true,
  canCreate: _canCreate = true,
}: NodeContentProps) {
  const contentRef = useRef<HTMLDivElement>(null);

  const { handleNodeClick, handleNodeShiftClick } = useNodeNavigation();

  // Lazy-load children of collapsed blocks when they are expanded
  useLazyChildren();

  // Debounced content save - batches rapid edits to reduce API calls
  // saveImmediate bypasses debounce for operations like asset uploads
  const { handleContentChange: handleBlockChange, saveImmediate } = useContentSave();

  // Runtime event subscription is no longer needed here.
  // BlockList's useBlockTree hook handles projection and re-rendering.

  // NodeContent no longer merges prop children with runtime pending intents.
  // BlockList's useBlockTree hook handles the projection, so we pass the raw
  // prop children to NodeCollection and let the renderer layer handle overlays.

  // Add/remove class mutations
  const addClass = useAddClass();
  const removeClass = useRemoveClass();
  const setNodeProperty = useSetNodeProperty();
  const createFlashcard = useCreateFlashcard();

  // Resolve properties for slash command side-effects (e.g. task status)
  const { data: allProperties } = useProperties();

  // Resolve system class IDs for slash commands
  const { data: allClasses } = useClasses();
  const systemClassMap = useMemo(() => {
    if (!allClasses) return null;
    const map: Record<string, string | undefined> = {};
    for (const [key, classUuid] of Object.entries(SYSTEM_CLASS_UUIDS)) {
      const found = allClasses.find(c => c.uuid === classUuid);
      if (found) map[key] = found.uuid;
    }
    return map;
  }, [allClasses]);

  // State for manual asset class addition
  const [manualAssetBlockId, setManualAssetBlockId] = useState<string | null>(null);

  const handleAddClass = useCallback((blockId: string, classId: string) => {
    // Optimistically update the runtime so the block's class pills and bullet
    // icon change immediately, without waiting for the API round-trip + cache
    // sync. Color is deliberately NOT touched: the runtime color is the node's
    // own color, and the block background tint must not adopt class colors.
    const runtime = getOperationRuntime();
    const graphNode = getAllNodes(runtime).find(n => n.blockId === blockId);
    if (graphNode && allClasses) {
      const classStrId = String(classId);
      if (!graphNode.classIds.includes(classStrId)) {
        const classNode = allClasses.find(c => c.uuid === classId);
        const effectiveIcon = classNode ? getEffectiveIcon(classNode, allClasses) : undefined;
        upsertNodes([{
          ...graphNode,
          classIds: [...graphNode.classIds, classStrId],
          icon: effectiveIcon ?? graphNode.icon,
        }]);
      }
    }

    // Check if this is adding the asset class manually
    if (systemClassMap?.asset != null && classId === systemClassMap.asset) {
      // Add the class first
      addClass.mutate({ nodeUuid: blockId, classId });
      // Store state for the upload modal
      setManualAssetBlockId(blockId);
      // Open asset upload modal
      setTargetBlockId(blockId);
      setConvertToAsset(true);
      setAssetTypeFilter(undefined);
      setIsAssetUploadOpen(true);
      return;
    }
    addClass.mutate({ nodeUuid: blockId, classId });
  }, [addClass, systemClassMap, allClasses]);

  // Asset upload state
  const [isAssetUploadOpen, setIsAssetUploadOpen] = useState(false);
  const [targetBlockId, setTargetBlockId] = useState<string | null>(null);
  const [convertToAsset, setConvertToAsset] = useState(false); // Whether to convert block to asset
  const [assetTypeFilter, setAssetTypeFilter] = useState<AssetCategory[] | undefined>(undefined);
  const [pendingFile, setPendingFile] = useState<File | null>(null);

  // Table creation modal state
  const [isTableModalOpen, setIsTableModalOpen] = useState(false);
  const [tableTargetBlockId, setTableTargetBlockId] = useState<string | null>(null);

  // Move-to-page modal state (/move slash command)
  const [moveTargetBlockId, setMoveTargetBlockId] = useState<string | null>(null);
  const updateNode = useUpdateNode();
  const queryClient = useQueryClient();

  // Template instantiation state
  const [pendingTemplate, setPendingTemplate] = useState<{
    templateNodeId: string;
    templateName: string;
    blockServerId: string | undefined;
  } | null>(null);
  const { data: templateVariablesData } = useTemplateVariables(pendingTemplate?.templateNodeId ?? null);
  const currentUser = useAuthStore(state => state.user);

  // Handle template instantiation from the inline /template picker
  const handleTemplateInstantiate = useCallback((templateNodeId: string, blockServerId: string | undefined) => {
    const runtime = getOperationRuntime();
    const allRuntimeNodes = getAllNodes(runtime);
    const templateNode = allRuntimeNodes.find(n => n.blockId === templateNodeId);
    setPendingTemplate({
      templateNodeId,
      templateName: templateNode?.name ?? 'Template',
      blockServerId,
    });
  }, []);

  const executeTemplateInstantiation = useCallback(async (
    templateNodeId: string,
    blockServerId: string | undefined,
    variables: Record<string, string>,
    dynamicContext: Record<string, string>,
  ) => {
    try {
      const { instantiateTemplate } = await import('@/api/nodes');

      const runtime = getOperationRuntime();

      // Insert template children as children of the block where /template was typed
      const parentId = blockServerId ?? node.uuid;
      let parentUuid = node.uuid;
      if (blockServerId != null) {
        const allRuntimeNodes = getAllNodes(runtime);
        const blockNode = allRuntimeNodes.find(n => n.blockId === blockServerId);
        if (blockNode) {
          parentUuid = blockNode.blockId;
        }
      }
      const result = await instantiateTemplate(templateNodeId, {
        parent_uuid: parentUuid,
        as_blocks: true,
        variables,
        dynamic_context: dynamicContext,
      });
      if (result.blocks.length > 0) {
        const { apiNodesToGraphNodes } = await import('@/features/content/hooks/useRuntimeSync');
        const { graphNodes } = apiNodesToGraphNodes(result.blocks, parentUuid);
        upsertNodes(graphNodes);

        // Optimistically update the TanStack query cache so that BlockEditor's
        // stale-cleanup sees the new blocks in the `nodes` prop immediately,
        // rather than waiting for an async refetch.
        // The API returns blocks as a flat list; build a nested tree first.
        const blockMap = new Map<string, Node>();
        for (const b of result.blocks) blockMap.set(b.uuid, { ...b, children: [] });
        const topLevel: Node[] = [];
        for (const b of result.blocks) {
          const mapped = blockMap.get(b.uuid)!;
          if (b.parent_uuid === parentId) {
            topLevel.push(mapped);
          } else {
            const parent = blockMap.get(b.parent_uuid!);
            if (parent) {
              parent.children = parent.children || [];
              parent.children.push(mapped);
            }
          }
        }

        // Use explicit cache iteration (setQueriesData is unreliable for
        // nested structures — see useNodeMutations.ts for rationale).
        const { nodeKeys } = await import('@/hooks/queryKeys');
        const { queryClient } = await import('@/lib/queryClient');
        const addBlocksToParent = (n: Node): Node => {
          if (n.uuid === parentId) {
            return {
              ...n,
              children: [...(n.children || []), ...topLevel],
              has_children: true,
            };
          }
          if (n.children) {
            const mapped = n.children.map(addBlocksToParent);
            if (mapped.some((c, i) => c !== n.children![i])) {
              return { ...n, children: mapped };
            }
          }
          return n;
        };
        const queryCache = queryClient.getQueryCache();
        const detailQueries = queryCache.findAll({ queryKey: nodeKeys.details() });
        let cacheUpdated = false;
        for (const query of detailQueries) {
          const oldData = query.state.data as Node | undefined;
          if (oldData) {
            const newData = addBlocksToParent(oldData);
            if (newData !== oldData) {
              queryClient.setQueryData(query.queryKey, newData);
              cacheUpdated = true;
            }
          }
        }
        if (!cacheUpdated) {
          console.warn('[TEMPLATE] No cache entries were updated! parentId:', parentId);
        }

        // Invalidate detail queries for the current node so a background
        // refetch brings in the full server tree.  The manual cache update
        // above provides instant visual feedback; this refetch ensures the
        // data is authoritative and fixes edge-cases the optimistic update
        // might miss (e.g. deeply nested structures or collapsed state).
        queryClient.invalidateQueries({ queryKey: nodeKeys.detailBase(node.uuid) });
      }
    } catch (e) {
      console.error('[NodeContent] template instantiation failed', e);
    }
  }, [node.uuid, node.uuid, queryClient]);

  // Handle slash commands from the editor
  const handleSlashCommand = useCallback((commandId: string, blockServerId: string | undefined) => {
    switch (commandId) {
      case 'query': {
        const classId = systemClassMap?.query;
        if (classId != null && blockServerId != null) {
          addClass.mutate({ nodeUuid: blockServerId, classId });
        }
        break;
      }
      case 'table': {
        if (blockServerId != null) {
          setTableTargetBlockId(blockServerId);
          setIsTableModalOpen(true);
        }
        break;
      }
      case 'code': {
        const classId = systemClassMap?.code;
        if (classId != null && blockServerId != null) {
          addClass.mutate({ nodeUuid: blockServerId, classId });
        }
        break;
      }
      case 'task': {
        const classId = systemClassMap?.task;
        if (classId != null && blockServerId != null) {
          addClass.mutate({ nodeUuid: blockServerId, classId });
          // Also set task_status to 'Pending' so the checkbox appears immediately
          const statusProp = allProperties?.find(p => p.uuid === SYSTEM_PROPERTY_UUIDS.task_status);
          const pendingOption = statusProp?.options?.find(o => o.name === 'Pending');
          if (statusProp && pendingOption) {
            setNodeProperty.mutate({
              nodeUuid: blockServerId,
              propertyId: statusProp.uuid,
              value: pendingOption.uuid,
            });
          }
        }
        break;
      }
      case 'warning':
      case 'note':
      case 'tip':
      case 'info':
      case 'danger':
      case 'success': {
        const classId = systemClassMap?.[commandId];
        if (classId != null && blockServerId != null) {
          addClass.mutate({ nodeUuid: blockServerId, classId });
        }
        break;
      }
      case 'image':
        setTargetBlockId(blockServerId ?? node.uuid);
        setConvertToAsset(true);
        setAssetTypeFilter(['image']);
        setIsAssetUploadOpen(true);
        break;
      case 'audio':
        setTargetBlockId(blockServerId ?? node.uuid);
        setConvertToAsset(true);
        setAssetTypeFilter(['audio']);
        setIsAssetUploadOpen(true);
        break;
      case 'file':
        setTargetBlockId(blockServerId ?? node.uuid);
        setConvertToAsset(true);
        setAssetTypeFilter(undefined);
        setIsAssetUploadOpen(true);
        break;
      case 'move':
        if (blockServerId != null) {
          setMoveTargetBlockId(blockServerId);
        }
        break;
      case 'flashcard': {
        const classId = systemClassMap?.card;
        if (classId == null || blockServerId == null) break;
        addClass.mutate(
          { nodeUuid: blockServerId, classId },
          {
            onSuccess: () => {
              const runtime = getOperationRuntime();
              const graphNode = getAllNodes(runtime).find(n => n.blockId === blockServerId);
              const frontText = graphNode
                ? stringifyAST(graphNode.contentAST, { mode: StringifyMode.TEXT_ONLY }).trim()
                : '';
              createFlashcard.mutate({ nodeUuid: blockServerId, frontText, backText: '' });
            },
          },
        );
        break;
      }
      case 'cloze': {
        const clozeClassId = systemClassMap?.cloze;
        if (clozeClassId == null || blockServerId == null) break;
        addClass.mutate({ nodeUuid: blockServerId, classId: clozeClassId });
        break;
      }
    }
  }, [systemClassMap, addClass, node.uuid, allProperties, setNodeProperty, createFlashcard]);

  // Handle table creation from modal — new table with selected dimensions
  const handleTableConfirm = useCallback(async (size: TableGridSize) => {
    if (tableTargetBlockId == null) return;
    const classId = systemClassMap?.table;
    if (classId == null) return;

    addClass.mutate({ nodeUuid: tableTargetBlockId, classId });

    try {
      const parentUuid = children.find(c => c.uuid === tableTargetBlockId)?.uuid;
      if (!parentUuid) return;
      // Create header row
      const headerRow = await createNode({ name: '', parent_uuid: parentUuid, sequence: 0 });
      await Promise.all(
        Array.from({ length: size.columns }, (_, i) =>
          createNode({ name: `Column ${i + 1}`, parent_uuid: headerRow.uuid, sequence: i })
        )
      );
      // Create data rows
      for (let r = 1; r < size.rows; r++) {
        const row = await createNode({ name: '', parent_uuid: parentUuid, sequence: r });
        await Promise.all(
          Array.from({ length: size.columns }, (_, c) =>
            createNode({ name: '', parent_uuid: row.uuid, sequence: c })
          )
        );
      }
    } catch (err) {
      console.error('[NodeContent] Failed to create table structure:', err);
    }
    setIsTableModalOpen(false);
    setTableTargetBlockId(null);
  }, [tableTargetBlockId, systemClassMap, addClass, children]);

  // Handle table creation — adapt existing children as columns
  const handleTableAdaptExisting = useCallback(() => {
    if (tableTargetBlockId == null) return;
    const classId = systemClassMap?.table;
    if (classId != null) {
      addClass.mutate({ nodeUuid: tableTargetBlockId, classId });
    }
    setIsTableModalOpen(false);
    setTableTargetBlockId(null);
  }, [tableTargetBlockId, systemClassMap, addClass]);

  // Handle table creation cancel
  const handleTableCancel = useCallback(() => {
    setIsTableModalOpen(false);
    setTableTargetBlockId(null);
  }, []);

  // Handle successful asset upload
  // Strategy:
  // - If block was NOT converted to asset: insert [[assetNodeId]] link at end
  // - If block WAS converted to asset: restore original text content (backend
  //   overwrites name with filename when existing_node_id is passed)
  const handleAssetUploaded = useCallback(async (asset: Asset) => {
    if (targetBlockId && !convertToAsset) {
      const block = children.find(c => c.uuid === targetBlockId);
      if (block) {
        // Insert asset link
        const assetLink = `[[${asset.node_id}]]`;
        const newContent = block.name ? `${block.name}\n${assetLink}` : assetLink;
        saveImmediate(targetBlockId, newContent);
      }
    }
    // When converting to asset (slash command or manual class add), the
    // backend already preserves the block's text content via the optional
    // `content` parameter, so no restore is needed here.
    setIsAssetUploadOpen(false);
    setTargetBlockId(null);
    setConvertToAsset(false);
    setAssetTypeFilter(undefined);
    setPendingFile(null);
    setManualAssetBlockId(null);

    // Invalidate so the asset preview renders
    const { queryClient } = await import('@/lib/queryClient');
    const { nodeKeys } = await import('@/hooks/queryKeys');
    queryClient.invalidateQueries({ queryKey: nodeKeys.detailBase(node.uuid) });
  }, [targetBlockId, convertToAsset, children, saveImmediate, node.uuid]);

  // Handle image paste in a block
  // - Convert the block to an asset via existing_node_uuid
  // - Pass the original content so the backend preserves it
  const handlePasteImage = useCallback(async (blockServerId: string, file: File, _hasContent: boolean) => {
    try {
      const block = children.find(c => c.uuid === blockServerId);
      const savedContent = block?.name || '';
      const blockUuid = block?.uuid;
      if (!blockUuid) return;
      // Convert block to asset, passing original content so the backend
      // preserves the node's text instead of overwriting it with the filename.
      await uploadAsset(file, node.uuid, blockUuid, savedContent || undefined);
      // Invalidate so the asset preview renders
      const { queryClient } = await import('@/lib/queryClient');
      const { nodeKeys } = await import('@/hooks/queryKeys');
      queryClient.invalidateQueries({ queryKey: nodeKeys.detailBase(node.uuid) });
    } catch (err) {
      console.error('[NodeContent] Failed to handle pasted image:', err);
    }
  }, [node.uuid, children]);

  const viewMode = toViewMode(displayMode);

  return (
    <div className={`node-content ${displayMode}`} ref={contentRef}>
      {/* Always render NodeCollection so BlockList is mounted and can pick up
          runtime-created blocks immediately. showEmpty=false hides the "No items" msg. */}
      <section className="node-content-children blocks-container">
        <NodeCollection
          nodes={children}
          viewMode={viewMode}
          availableViewModes={[viewMode]}
          editable={editable}
          onNodeClick={handleNodeClick}
          onNodeShiftClick={handleNodeShiftClick}
          onContentChange={handleBlockChange}
          showEmpty={false}
          showClasses={true}
          pageId={node.uuid}
          nodeUuid={node.uuid}
          onAddClass={handleAddClass}
          onSlashCommand={handleSlashCommand}
          onTemplateInstantiate={handleTemplateInstantiate}
          templateClassFilters={systemClassMap?.template != null ? [systemClassMap.template] : undefined}
          onPasteImage={handlePasteImage}
        />
      </section>

      {/* Asset Upload Modal */}
      <AssetUploadModal
        isOpen={isAssetUploadOpen}
        onClose={() => { 
          // If this was a manual asset class addition, remove the class on cancel
          if (manualAssetBlockId && systemClassMap?.asset != null) {
            removeClass.mutate({ nodeUuid: manualAssetBlockId, classId: systemClassMap.asset });
          }
          setIsAssetUploadOpen(false);
          setTargetBlockId(null);
          setConvertToAsset(false);
          setAssetTypeFilter(undefined); 
          setPendingFile(null);
          setManualAssetBlockId(null);
        }}
        onUpload={handleAssetUploaded}
        parentId={(targetBlockId ? children.find(c => c.uuid === targetBlockId)?.uuid : undefined) || node.uuid}
        existingNodeId={convertToAsset ? (targetBlockId ? children.find(c => c.uuid === targetBlockId)?.uuid : undefined) : undefined}
        acceptedTypes={assetTypeFilter}
        initialFile={pendingFile}
      />
      
      {/* Table Creation Modal */}
      <TableCreationModal
        isOpen={isTableModalOpen}
        onConfirm={handleTableConfirm}
        onAdaptExisting={handleTableAdaptExisting}
        onCancel={handleTableCancel}
      />

      {/* Move-to-page Modal (/move slash command) */}
      <Modal
        isOpen={moveTargetBlockId != null}
        onClose={() => setMoveTargetBlockId(null)}
        title="Move to page"
        size="sm"
      >
        <NodeSelector
          trigger="inline"
          value={null}
          searchMode="pages"
          excludeNodeId={moveTargetBlockId ?? undefined}
          placeholder="Search pages..."
          onChange={(val) => {
            if (typeof val === 'number' && moveTargetBlockId != null) {
              const parentUuid = getNodeUuidByServerId(queryClient, val);
              if (parentUuid) {
                updateNode.mutate({ nodeUuid: moveTargetBlockId, data: { parent_uuid: parentUuid } });
              }
              setMoveTargetBlockId(null);
            }
          }}
          allowCreate={false}
        />
      </Modal>

      {/* Template variable dialog */}
      {pendingTemplate && (
        <TemplateVariableDialog
          isOpen
          templateName={pendingTemplate.templateName}
          variables={templateVariablesData?.variables ?? []}
          dynamicVariables={templateVariablesData?.dynamic_variables ?? []}
          context={{
            currentPageName: node.name,
            currentPageUuid: node.uuid,
            currentUserName: currentUser?.name ?? null,
          }}
          onCancel={() => setPendingTemplate(null)}
          onConfirm={(variables, dynamicContext) => {
            executeTemplateInstantiation(
              pendingTemplate.templateNodeId,
              pendingTemplate.blockServerId,
              variables,
              dynamicContext,
            );
            setPendingTemplate(null);
          }}
        />
      )}

    </div>
  );
}

