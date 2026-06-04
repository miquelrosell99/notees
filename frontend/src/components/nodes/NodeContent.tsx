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
import { useContentSave, useNodeNavigation, useAddClass, useRemoveClass, useClasses, useUpdateNode, useSetNodeProperty, useProperties } from '@/hooks';
import { generateUUID } from '@/utils/uuid';
import { useBlockPersist } from '@/hooks/useBlockPersist';
import { useLazyChildren } from '@/hooks/useLazyChildren';
import { getNodeGraphRuntime } from '@/runtime/NodeGraphRuntime';
import type { Node } from '@/types';
import type { NodeCollectionViewMode } from '@/types/nodeCollection';
import { NodeCollection } from './NodeCollection';
import { AssetUploadModal } from '@/components/assets/AssetUploadModal';
import { Button } from '@/components/core/Button';
import { Modal } from '@/components/core/Modal';
import { NodeSelector } from './NodeSelector';
import { type Asset, type AssetCategory, uploadAsset } from '@/api/assets';
import { createNode } from '@/api/nodes';
import { SYSTEM_CLASS_UUIDS, SYSTEM_PROPERTY_UUIDS } from '@/constants/systemProperties';
import { TableCreationModal, type TableGridSize } from '@/components/core/TableCreationModal';

import './NodeContent.css';

interface NodeContentProps {
  /** The parent node whose children to display */
  node: Node;
  /** Children blocks to display (filtered if needed) */
  children: Node[];
  /** Display mode for content */
  displayMode?: 'bullet' | 'document' | 'card';
  /** Total children count (before filtering) */
  totalChildrenCount?: number;
  /** Whether content is editable (defaults to true) */
  editable?: boolean;
  /** Whether new blocks can be created (defaults to true) */
  canCreate?: boolean;
}

// Map display mode to NodeCollection view mode
function toViewMode(displayMode: 'bullet' | 'document' | 'card'): NodeCollectionViewMode {
  switch (displayMode) {
    case 'bullet': return 'list';
    case 'document': return 'document';
    case 'card': return 'card';
  }
}

export function NodeContent({ 
  node, 
  children,
  displayMode = 'bullet',
  editable = true,
  canCreate = true,
}: NodeContentProps) {
  const contentRef = useRef<HTMLDivElement>(null);

  const { handleNodeClick, handleNodeShiftClick } = useNodeNavigation();

  // Lazy-load children of collapsed blocks when they are expanded
  useLazyChildren();

  // Debounced content save - batches rapid edits to reduce API calls
  // saveImmediate bypasses debounce for operations like asset uploads
  const { handleContentChange: handleBlockChange, saveImmediate } = useContentSave();

  // Add/remove class mutations
  const addClass = useAddClass();
  const removeClass = useRemoveClass();
  const setNodeProperty = useSetNodeProperty();

  // Resolve properties for slash command side-effects (e.g. task status)
  const { data: allProperties } = useProperties();

  // Resolve system class IDs for slash commands
  const { data: allClasses } = useClasses();
  const systemClassMap = useMemo(() => {
    if (!allClasses) return null;
    const map: Record<string, number | undefined> = {};
    for (const [key, uuid] of Object.entries(SYSTEM_CLASS_UUIDS)) {
      const found = allClasses.find(c => c.uuid === uuid);
      if (found) map[key] = found.id;
    }
    return map;
  }, [allClasses]);

  // State for manual asset class addition
  const [manualAssetBlockId, setManualAssetBlockId] = useState<number | null>(null);

  const handleAddClass = useCallback((blockId: number, classId: number) => {
    // Optimistically update the runtime so the block's color/icon change
    // immediately, without waiting for the API round-trip + cache sync.
    const runtime = getNodeGraphRuntime();
    const graphNode = runtime.getAllNodes().find(n => n.serverId === blockId);
    if (graphNode && allClasses) {
      const classStrId = String(classId);
      if (!graphNode.classIds.includes(classStrId)) {
        const classNode = allClasses.find(c => c.id === classId);
        runtime.upsertNodes([{
          ...graphNode,
          classIds: [...graphNode.classIds, classStrId],
          icon: classNode?.icon ?? graphNode.icon,
          color: classNode?.color ?? graphNode.color,
        }]);
      }
    }

    // Check if this is adding the asset class manually
    if (systemClassMap?.asset != null && classId === systemClassMap.asset) {
      // Add the class first
      addClass.mutate({ nodeId: blockId, classId });
      // Store state for the upload modal
      setManualAssetBlockId(blockId);
      // Open asset upload modal
      setTargetBlockId(blockId);
      setConvertToAsset(true);
      setAssetTypeFilter(undefined);
      setIsAssetUploadOpen(true);
      return;
    }
    addClass.mutate({ nodeId: blockId, classId });
  }, [addClass, systemClassMap, allClasses]);

  // Asset upload state
  const [isAssetUploadOpen, setIsAssetUploadOpen] = useState(false);
  const [targetBlockId, setTargetBlockId] = useState<number | null>(null);
  const [convertToAsset, setConvertToAsset] = useState(false); // Whether to convert block to asset
  const [assetTypeFilter, setAssetTypeFilter] = useState<AssetCategory[] | undefined>(undefined);
  const [pendingFile, setPendingFile] = useState<File | null>(null);

  // Table creation modal state
  const [isTableModalOpen, setIsTableModalOpen] = useState(false);
  const [tableTargetBlockId, setTableTargetBlockId] = useState<number | null>(null);

  // Move-to-page modal state (/move slash command)
  const [moveTargetBlockId, setMoveTargetBlockId] = useState<number | null>(null);
  const updateNode = useUpdateNode();

  // Handle template instantiation from the inline /template picker
  const handleTemplateInstantiate = useCallback(async (templateNodeId: number, blockServerId: number | undefined) => {
    try {
      const { instantiateTemplate } = await import('@/api/nodes');
      const { getNodeGraphRuntime } = await import('@/runtime/NodeGraphRuntime');
      const runtime = getNodeGraphRuntime();

      // Insert template children as children of the block where /template was typed
      const parentId = blockServerId ?? node.id;
      let parentUuid = node.uuid;
      if (blockServerId != null) {
        const allRuntimeNodes = runtime.getAllNodes();
        const blockNode = allRuntimeNodes.find(n => n.serverId === blockServerId);
        if (blockNode) {
          parentUuid = blockNode.blockId;
        }
      }
      const result = await instantiateTemplate(templateNodeId, {
        parent_id: parentId,
        as_blocks: true,
        variables: {},
      });
      if (result.blocks.length > 0) {
        const { apiNodesToGraphNodes } = await import('@/hooks/useRuntimeSync');
        const { graphNodes } = apiNodesToGraphNodes(result.blocks, parentId, parentUuid);
        runtime.upsertNodes(graphNodes);

        // Optimistically update the TanStack query cache so that BlockEditor's
        // stale-cleanup sees the new blocks in the `nodes` prop immediately,
        // rather than waiting for an async refetch.
        // The API returns blocks as a flat list; build a nested tree first.
        const blockMap = new Map<number, Node>();
        for (const b of result.blocks) blockMap.set(b.id, { ...b, children: [] });
        const topLevel: Node[] = [];
        for (const b of result.blocks) {
          const mapped = blockMap.get(b.id)!;
          if (b.parent_id === parentId) {
            topLevel.push(mapped);
          } else {
            const parent = blockMap.get(b.parent_id!);
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
          if (n.id === parentId) {
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
        queryClient.invalidateQueries({ queryKey: nodeKeys.detailBase(node.id) });
      }
    } catch (e) {
      console.error('[NodeContent] template instantiation failed', e);
    }
  }, [node.id, node.uuid]);

  // Handle slash commands from the editor
  const handleSlashCommand = useCallback((commandId: string, blockServerId: number | undefined) => {
    switch (commandId) {
      case 'query': {
        const classId = systemClassMap?.query;
        if (classId != null && blockServerId != null) {
          addClass.mutate({ nodeId: blockServerId, classId });
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
          addClass.mutate({ nodeId: blockServerId, classId });
        }
        break;
      }
      case 'task': {
        const classId = systemClassMap?.task;
        if (classId != null && blockServerId != null) {
          addClass.mutate({ nodeId: blockServerId, classId });
          // Also set task_status to 'Pending' so the checkbox appears immediately
          const statusProp = allProperties?.find(p => p.uuid === SYSTEM_PROPERTY_UUIDS.task_status);
          const pendingOption = statusProp?.options?.find(o => o.name === 'Pending');
          if (statusProp && pendingOption) {
            setNodeProperty.mutate({
              nodeId: blockServerId,
              propertyId: statusProp.id,
              value: pendingOption.id,
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
          addClass.mutate({ nodeId: blockServerId, classId });
        }
        break;
      }
      case 'image':
        setTargetBlockId(blockServerId ?? node.id);
        setConvertToAsset(true);
        setAssetTypeFilter(['image']);
        setIsAssetUploadOpen(true);
        break;
      case 'audio':
        setTargetBlockId(blockServerId ?? node.id);
        setConvertToAsset(true);
        setAssetTypeFilter(['audio']);
        setIsAssetUploadOpen(true);
        break;
      case 'file':
        setTargetBlockId(blockServerId ?? node.id);
        setConvertToAsset(true);
        setAssetTypeFilter(undefined);
        setIsAssetUploadOpen(true);
        break;
      case 'move':
        if (blockServerId != null) {
          setMoveTargetBlockId(blockServerId);
        }
        break;
    }
  }, [systemClassMap, addClass, node.id, allProperties, setNodeProperty]);

  // Ensure blocks created via the Add Block button get persisted even when
  // no BlockEditor (which normally hosts useBlockPersist) is mounted yet.
  useBlockPersist();

  // Handle table creation from modal — new table with selected dimensions
  const handleTableConfirm = useCallback(async (size: TableGridSize) => {
    if (tableTargetBlockId == null) return;
    const classId = systemClassMap?.table;
    if (classId == null) return;

    addClass.mutate({ nodeId: tableTargetBlockId, classId });

    try {
      // Create header row
      const headerRow = await createNode({ name: '', parent_id: tableTargetBlockId, sequence: 0 });
      await Promise.all(
        Array.from({ length: size.columns }, (_, i) =>
          createNode({ name: `Column ${i + 1}`, parent_id: headerRow.id, sequence: i })
        )
      );
      // Create data rows
      for (let r = 1; r < size.rows; r++) {
        const row = await createNode({ name: '', parent_id: tableTargetBlockId, sequence: r });
        await Promise.all(
          Array.from({ length: size.columns }, (_, c) =>
            createNode({ name: '', parent_id: row.id, sequence: c })
          )
        );
      }
    } catch (err) {
      console.error('[NodeContent] Failed to create table structure:', err);
    }
    setIsTableModalOpen(false);
    setTableTargetBlockId(null);
  }, [tableTargetBlockId, systemClassMap, addClass]);

  // Handle table creation — adapt existing children as columns
  const handleTableAdaptExisting = useCallback(() => {
    if (tableTargetBlockId == null) return;
    const classId = systemClassMap?.table;
    if (classId != null) {
      addClass.mutate({ nodeId: tableTargetBlockId, classId });
    }
    setIsTableModalOpen(false);
    setTableTargetBlockId(null);
  }, [tableTargetBlockId, systemClassMap, addClass]);

  // Handle table creation cancel
  const handleTableCancel = useCallback(() => {
    setIsTableModalOpen(false);
    setTableTargetBlockId(null);
  }, []);

  const handleAddBlock = useCallback(() => {
    // Create via runtime intent so the block appears immediately (no API roundtrip)
    // and useBlockPersist handles persistence automatically.
    const runtime = getNodeGraphRuntime();
    const newBlockId = generateUUID();

    // Register the parent's serverId so useBlockPersist can resolve it
    runtime.registerParentServerId(node.uuid, node.id);

    // Find the last child's blockId to insert after it
    // The API orders children by sequence, so the last array element is the rightmost block.
    const lastChild = children.length > 0 ? children[children.length - 1] : null;

    runtime.requestFocus(newBlockId);
    runtime.applyIntent({
      type: 'create_block',
      parentId: node.uuid,
      afterBlockId: lastChild?.uuid ?? null,
      blockId: newBlockId,
      contentAST: [{ type: 'paragraph', children: [{ type: 'text', text: '' }] }],
    });
    runtime.flushEvents();
  }, [node.uuid, children]);

  // Handle successful asset upload
  // Strategy:
  // - If block was NOT converted to asset: insert [[assetNodeId]] link at end
  // - If block WAS converted to asset: restore original text content (backend
  //   overwrites name with filename when existing_node_id is passed)
  const handleAssetUploaded = useCallback(async (asset: Asset) => {
    if (targetBlockId && !convertToAsset) {
      const block = children.find(c => c.id === targetBlockId);
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
    queryClient.invalidateQueries({ queryKey: nodeKeys.detailBase(node.id) });
  }, [targetBlockId, convertToAsset, children, saveImmediate, node.id]);

  // Handle image paste in a block
  // - Convert the block to an asset via existing_node_id
  // - Pass the original content so the backend preserves it
  const handlePasteImage = useCallback(async (blockServerId: number, file: File, _hasContent: boolean) => {
    try {
      const block = children.find(c => c.id === blockServerId);
      const savedContent = block?.name || '';
      // Convert block to asset, passing original content so the backend
      // preserves the node's text instead of overwriting it with the filename.
      await uploadAsset(file, node.id, blockServerId, savedContent || undefined);
      // Invalidate so the asset preview renders
      const { queryClient } = await import('@/lib/queryClient');
      const { nodeKeys } = await import('@/hooks/queryKeys');
      queryClient.invalidateQueries({ queryKey: nodeKeys.detailBase(node.id) });
    } catch (err) {
      console.error('[NodeContent] Failed to handle pasted image:', err);
    }
  }, [node.id, children]);

  const viewMode = toViewMode(displayMode);

  return (
    <div className={`node-content ${displayMode}`} ref={contentRef}>
      {/* Render children using NodeCollection with callbacks */}
      {children.length > 0 && (
        <section className={`node-content-children blocks-container ${displayMode === 'document' ? 'document-mode' : ''}`}>
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
            pageId={node.id}
            nodeUuid={node.uuid}
            onAddClass={handleAddClass}
            onSlashCommand={handleSlashCommand}
            onTemplateInstantiate={handleTemplateInstantiate}
            templateClassFilters={systemClassMap?.template != null ? [systemClassMap.template] : undefined}
            onPasteImage={handlePasteImage}
          />
        </section>
      )}
      
      {/* Empty state */}
      {children.length === 0 && (
        <div className="node-content-empty">
          {canCreate && (
            <Button icon={"mdi mdi-plus"} onClick={handleAddBlock} className="add-block-btn" title="Add block" size="sm" variant="ghost">
              Add block
            </Button>
          )}
        </div>
      )}
      
      {/* Add block button when there are children */}
      {children.length > 0 && (
        <div className="node-content-add hover-reveal">
          {canCreate && (
            <Button icon={"mdi mdi-plus"} onClick={handleAddBlock} className="add-block-btn" title="Add block" size="sm" variant="ghost">
              Add block
            </Button>
          )}
        </div>
      )}
      
      {/* Asset Upload Modal */}
      <AssetUploadModal
        isOpen={isAssetUploadOpen}
        onClose={() => { 
          // If this was a manual asset class addition, remove the class on cancel
          if (manualAssetBlockId && systemClassMap?.asset != null) {
            removeClass.mutate({ nodeId: manualAssetBlockId, classId: systemClassMap.asset });
          }
          setIsAssetUploadOpen(false);
          setTargetBlockId(null);
          setConvertToAsset(false);
          setAssetTypeFilter(undefined); 
          setPendingFile(null);
          setManualAssetBlockId(null);
        }}
        onUpload={handleAssetUploaded}
        parentId={targetBlockId || node.id}
        existingNodeId={convertToAsset ? targetBlockId || undefined : undefined}
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
              updateNode.mutate({ id: moveTargetBlockId, data: { parent_id: val } });
              setMoveTargetBlockId(null);
            }
          }}
          allowCreate={false}
        />
      </Modal>

    </div>
  );
}

