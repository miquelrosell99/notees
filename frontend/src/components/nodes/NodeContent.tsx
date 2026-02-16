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
import { useContentSave, useNodeNavigation, useAddClass, useClasses } from '@/hooks';
import { useBlockPersist } from '@/hooks/useBlockPersist';
import { useAppStore } from '@/stores';
import { getNodeGraphRuntime } from '@/runtime/NodeGraphRuntime';
import type { Node } from '@/types';
import type { NodeCollectionViewMode } from '@/types/nodeCollection';
import { mdiPlus } from '@mdi/js';
import { NodeCollection } from './NodeCollection';
import { AssetUploadModal } from '../assets/AssetUploadModal';
import { Button } from '../core/Button';
import { type Asset, type AssetCategory } from '@/api/assets';
import { SYSTEM_CLASS_UUIDS } from '@/constants/systemProperties';
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
  const { addSidebarCard, openCommentsForNode } = useAppStore();
  const { handleNodeClick, handleNodeShiftClick } = useNodeNavigation();

  // Debounced content save - batches rapid edits to reduce API calls
  // saveImmediate bypasses debounce for operations like asset uploads
  const { handleContentChange: handleBlockChange, saveImmediate } = useContentSave();

  // Add class mutation
  const addClass = useAddClass();
  const handleAddClass = useCallback((blockId: number, classId: number) => {
    addClass.mutate({ nodeId: blockId, classId });
  }, [addClass]);

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

  // Asset upload state
  const [isAssetUploadOpen, setIsAssetUploadOpen] = useState(false);
  const [targetBlockId, setTargetBlockId] = useState<number | null>(null);
  const [convertToAsset, setConvertToAsset] = useState(false); // Whether to convert block to asset
  const [assetTypeFilter, setAssetTypeFilter] = useState<AssetCategory[] | undefined>(undefined);
  const [pendingFile, setPendingFile] = useState<File | null>(null);

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
        const classId = systemClassMap?.table;
        if (classId != null && blockServerId != null) {
          addClass.mutate({ nodeId: blockServerId, classId });
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
      case 'comment':
        if (blockServerId != null) {
          openCommentsForNode(blockServerId);
        }
        break;
    }
  }, [systemClassMap, addClass, node.id, openCommentsForNode]);

  // Ensure blocks created via the Add Block button get persisted even when
  // no BlockEditor (which normally hosts useBlockPersist) is mounted yet.
  useBlockPersist();

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
  // - If block was converted to asset: do nothing (block is now the asset)
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
    setIsAssetUploadOpen(false);
    setTargetBlockId(null);
    setConvertToAsset(false);
    setAssetTypeFilter(undefined);
    setPendingFile(null);
  }, [targetBlockId, convertToAsset, children, saveImmediate]);

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
          setIsAssetUploadOpen(false);
          setConvertToAsset(false);
          setAssetTypeFilter(undefined); 
          setPendingFile(null); 
        }}
        onUpload={handleAssetUploaded}
        parentId={targetBlockId || node.id}
        existingNodeId={convertToAsset ? targetBlockId || undefined : undefined}
        acceptedTypes={assetTypeFilter}
        initialFile={pendingFile}
      />
    </div>
  );
}

export default NodeContent;
