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
import { useContentSave, useNodeNavigation, useAddClass, useRemoveClass, useClasses } from '@/hooks';
import { useBlockPersist } from '@/hooks/useBlockPersist';
import { useLazyChildren } from '@/hooks/useLazyChildren';
import { useAppStore } from '@/stores';
import { getNodeGraphRuntime } from '@/runtime/NodeGraphRuntime';
import type { Node } from '@/types';
import type { NodeCollectionViewMode } from '@/types/nodeCollection';
import { mdiPlus } from '@mdi/js';
import { NodeCollection } from './NodeCollection';
import { AssetUploadModal } from '../assets/AssetUploadModal';
import { Button } from '../core/Button';
import { type Asset, type AssetCategory, uploadAsset } from '@/api/assets';
import { createNode, getNode } from '@/api/nodes';
import { SYSTEM_CLASS_UUIDS } from '@/constants/systemProperties';
import { TableCreationModal, type TableSize } from '../core/TableCreationModal';

import './NodeContent.css';

interface NodeContentProps {
  /** The parent node whose children to display */
  node: Node;
  /** Children blocks to display (filtered if needed) */
  children: Node[];
  /** Display mode for content */
  displayMode?: 'bullet' | 'document' | 'card';
  /** Whether late night filter is active */
  lateNightFilterActive?: boolean;
  /** Total children count (before filtering) */
  totalChildrenCount?: number;
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
  lateNightFilterActive = false,
  totalChildrenCount = 0,
}: NodeContentProps) {
  const contentRef = useRef<HTMLDivElement>(null);
  const addSidebarCard = useAppStore(s => s.addSidebarCard);
  const { handleNodeClick, handleNodeShiftClick } = useNodeNavigation();

  // Lazy-load children of collapsed blocks when they are expanded
  useLazyChildren();

  // Debounced content save - batches rapid edits to reduce API calls
  // saveImmediate bypasses debounce for operations like asset uploads
  const { handleContentChange: handleBlockChange, saveImmediate } = useContentSave();

  // Add/remove class mutations
  const addClass = useAddClass();
  const removeClass = useRemoveClass();

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
  const [manualAssetBlockContent, setManualAssetBlockContent] = useState<string>('');

  const handleAddClass = useCallback((blockId: number, classId: number) => {
    // Check if this is adding the asset class manually
    if (systemClassMap?.asset != null && classId === systemClassMap.asset) {
      // Add the class first
      addClass.mutate({ nodeId: blockId, classId });
      // Find the block to check its content
      const block = children.find(c => c.id === blockId);
      const blockContent = block?.name || '';
      // Store state for the upload modal
      setManualAssetBlockId(blockId);
      setManualAssetBlockContent(blockContent);
      // Open asset upload modal
      setTargetBlockId(blockId);
      setConvertToAsset(true);
      setAssetTypeFilter(undefined);
      setIsAssetUploadOpen(true);
      return;
    }
    addClass.mutate({ nodeId: blockId, classId });
  }, [addClass, systemClassMap, children]);

  // Asset upload state
  const [isAssetUploadOpen, setIsAssetUploadOpen] = useState(false);
  const [targetBlockId, setTargetBlockId] = useState<number | null>(null);
  const [convertToAsset, setConvertToAsset] = useState(false); // Whether to convert block to asset
  const [assetTypeFilter, setAssetTypeFilter] = useState<AssetCategory[] | undefined>(undefined);
  const [pendingFile, setPendingFile] = useState<File | null>(null);

  // Table creation modal state
  const [isTableModalOpen, setIsTableModalOpen] = useState(false);
  const [tableTargetBlockId, setTableTargetBlockId] = useState<number | null>(null);

  // Handle template instantiation from the inline /template picker
  const handleTemplateInstantiate = useCallback(async (templateNodeId: number, _blockServerId: number | undefined) => {
    try {
      const { instantiateTemplate } = await import('@/api/nodes');
      const result = await instantiateTemplate(templateNodeId, {
        parent_id: node.id,
        as_blocks: true,
        variables: {},
      });
      if (result.blocks.length > 0) {
        const { apiNodesToGraphNodes } = await import('@/hooks/useRuntimeSync');
        const { getNodeGraphRuntime } = await import('@/runtime/NodeGraphRuntime');
        const runtime = getNodeGraphRuntime();
        const { graphNodes } = apiNodesToGraphNodes(result.blocks, node.id, node.uuid);
        runtime.upsertNodes(graphNodes);
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
    }
  }, [systemClassMap, addClass, node.id]);

  // Ensure blocks created via the Add Block button get persisted even when
  // no BlockEditor (which normally hosts useBlockPersist) is mounted yet.
  useBlockPersist();

  // Handle table creation from modal — new table with selected dimensions
  const handleTableConfirm = useCallback(async (size: TableSize) => {
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
    console.log('[NodeContent] handleAddBlock triggered', { nodeUuid: node.uuid, childrenCount: children.length });
    // Create via runtime intent so the block appears immediately (no API roundtrip)
    // and useBlockPersist handles persistence automatically.
    const runtime = getNodeGraphRuntime();
    const newBlockId = crypto.randomUUID();

    // Register the parent's serverId so useBlockPersist can resolve it
    runtime.registerParentServerId(node.uuid, node.id);

    // Find the last child's blockId to insert after it
    const lastChild = children.length > 0
      ? children.reduce((a, b) => ((a.sequence ?? 0) >= (b.sequence ?? 0) ? a : b))
      : null;

    console.log('[NodeContent] Applying create_block intent', { newBlockId, parentId: node.uuid, afterBlockId: lastChild?.uuid ?? null });
    runtime.requestFocus(newBlockId);
    runtime.applyIntent({
      type: 'create_block',
      parentId: node.uuid,
      afterBlockId: lastChild?.uuid ?? null,
      blockId: newBlockId,
      contentAST: [{ type: 'paragraph', children: [{ type: 'text', text: '' }] }],
    });
    runtime.flushEvents();
    console.log('[NodeContent] Intent flushed');
  }, [node.uuid, children]);

  // Handle successful asset upload
  // Strategy:
  // - If block was converted to asset: handle manual asset class flow (name vs filename)
  // - If block has content: insert [[assetNodeId]] link at end
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
    // Manual asset class flow: if block had no content, use filename as content
    if (manualAssetBlockId && targetBlockId === manualAssetBlockId) {
      if (!manualAssetBlockContent) {
        // Block was empty — use the uploaded file's name as content
        saveImmediate(manualAssetBlockId, asset.filename);
      }
      // If block had content, the content is already preserved (it was passed as existingNodeId)
    }
    setIsAssetUploadOpen(false);
    setTargetBlockId(null);
    setConvertToAsset(false);
    setAssetTypeFilter(undefined);
    setPendingFile(null);
    setManualAssetBlockId(null);
    setManualAssetBlockContent('');
  }, [targetBlockId, convertToAsset, children, saveImmediate, manualAssetBlockId, manualAssetBlockContent]);

  // Handle image paste in a block
  // - If block has NO content: convert block directly to asset (upload with existingNodeId)
  // - If block HAS content: upload as new asset, insert [[uuid]] link into content
  const handlePasteImage = useCallback(async (blockServerId: number, file: File, hasContent: boolean) => {
    try {
      if (!hasContent) {
        // Empty block: convert to asset directly
        await uploadAsset(file, node.id, blockServerId);
      } else {
        // Block has content: upload as new asset node, then insert link
        const asset = await uploadAsset(file, node.id);
        // Get the asset node to obtain its UUID for the link
        const assetNode = await getNode(asset.node_id);
        if (assetNode?.uuid) {
          // Insert [[uuid]] link at the end of the block content
          const block = children.find(c => c.id === blockServerId);
          const currentContent = block?.name || '';
          const link = `[[${assetNode.uuid}]]`;
          const newContent = currentContent ? `${currentContent} ${link}` : link;
          saveImmediate(blockServerId, newContent);
        }
      }
    } catch (err) {
      console.error('[NodeContent] Failed to handle pasted image:', err);
    }
  }, [node.id, children, saveImmediate]);

  const viewMode = toViewMode(displayMode);

  return (
    <div className={`node-content ${displayMode}`} ref={contentRef}>
      {/* Late night filter indicator */}
      {lateNightFilterActive && children.length === 0 && totalChildrenCount > 0 && (
        <div className="node-content-filter-indicator">
          🌙 No late night thoughts found (10PM - 4AM)
        </div>
      )}
      
      {/* Render children using NodeCollection with callbacks */}
      {children.length > 0 && (
        <section className={`node-content-children blocks-container ${displayMode === 'document' ? 'document-mode' : ''}`}>
          <NodeCollection
            nodes={children}
            viewMode={viewMode}
            availableViewModes={[viewMode]}
            editable={true}
            onNodeClick={handleNodeClick}
            onNodeShiftClick={handleNodeShiftClick}
            onContentChange={handleBlockChange}
            showEmpty={false}
            showClasses={true}
            pageId={node.id}
            pageUuid={node.uuid}
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
          <Button icon={mdiPlus} onClick={handleAddBlock} className="add-block-btn" title="Add block" size="sm" variant="ghost">
            Add block
          </Button>
        </div>
      )}
      
      {/* Add block button when there are children */}
      {children.length > 0 && (
        <div className="node-content-add">
          <Button icon={mdiPlus} onClick={handleAddBlock} className="add-block-btn" title="Add block" size="sm" variant="ghost">
            Add block
          </Button>
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
          setManualAssetBlockContent('');
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


    </div>
  );
}

export default NodeContent;
