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
import { useCreateNode, useAddTag, useAddClass, useBlockSelection, useAddTagLink, useContentSave, useSystemClasses } from '@/hooks';
import { useNodesStore, useBlockSelectionStore } from '@/stores';
import type { Node } from '@/types';
import type { NodeCollectionViewMode } from '@/types/nodeCollection';
import { mdiPlus } from '@mdi/js';
import { NodeCollection } from './NodeCollection';
import { BoxSelect } from '../core/BoxSelect';
import { AssetUploadModal } from '../assets/AssetUploadModal';
import { Button } from '../core/Button';
import { type Asset, type AssetCategory } from '@/api/assets';
import type { BlockCallbacks } from '../blocks/BlockCallbacksContext';
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
  const createNode = useCreateNode();
  const addTag = useAddTag();
  const addClass = useAddClass();
  const addTagLink = useAddTagLink();
  const { systemClassIds } = useSystemClasses();
  const { addSidebarCard, openNode, openCommentsForNode } = useNodesStore();
  
  // Block selection
  const { enterEditMode } = useBlockSelectionStore();
  useBlockSelection(children, { containerRef: contentRef, enabled: true });

  // Debounced content save - batches rapid edits to reduce API calls
  // saveImmediate bypasses debounce for operations like asset uploads
  const { handleContentChange: handleBlockChange, saveImmediate } = useContentSave();

  // Asset upload state
  const [isAssetUploadOpen, setIsAssetUploadOpen] = useState(false);
  const [targetBlockId, setTargetBlockId] = useState<number | null>(null);
  const [convertToAsset, setConvertToAsset] = useState(false); // Whether to convert block to asset
  const [assetTypeFilter, setAssetTypeFilter] = useState<AssetCategory[] | undefined>(undefined);
  const [pendingFile, setPendingFile] = useState<File | null>(null);

  const handleAddBlock = useCallback(async () => {
    // Compute next sequence from all node children (not just filtered ones)
    // Find the max sequence and add 1, or default to 0 if no children
    const maxSequence = node.children?.reduce((max, child) => 
      Math.max(max, child.sequence ?? 0), -1) ?? -1;
    
    const newNode = await createNode.mutateAsync({
      name: '',
      parent_id: node.id,
      sequence: maxSequence + 1,
    });
    // Set the new block to edit mode so the user can start typing right away
    enterEditMode(newNode.id);
  }, [createNode, node.id, node.children, enterEditMode]);

  const handleNodeClick = useCallback((clickedNode: Node) => {
    openNode(clickedNode.id, clickedNode.is_page ? 'page' : 'block');
  }, [openNode]);

  const handleNodeShiftClick = useCallback((clickedNode: Node) => {
    addSidebarCard(clickedNode.id, clickedNode.is_page ? 'page' : 'block');
  }, [addSidebarCard]);

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

  // Build block callbacks for context provider
  const blockCallbacks = useMemo<BlockCallbacks>(() => ({
    onAddClass: (blockId, classNodeId, _keepInline, _className) => {
      addClass.mutate({ nodeId: blockId, classId: classNodeId });
    },
    onAddTag: (blockId, tagNodeId, keepInline, _tagName) => {
      addTag.mutate({ nodeId: blockId, tagId: tagNodeId });
      if (keepInline) {
        addTagLink.mutate({ nodeId: blockId, targetNodeId: tagNodeId });
      }
    },
    onCreateClass: (blockId, name, _keepInline) => {
      if (!systemClassIds?.page || !systemClassIds?.class) return;
      createNode.mutate({ name, classes: [systemClassIds.page, systemClassIds.class] }, {
        onSuccess: (newPage) => {
          addClass.mutate({ nodeId: blockId, classId: newPage.id });
        }
      });
    },
    onCreateTag: (blockId, name, _keepInline) => {
      if (!systemClassIds?.page) return;
      createNode.mutate({ name, classes: [systemClassIds.page] }, {
        onSuccess: (newPage) => {
          addTag.mutate({ nodeId: blockId, tagId: newPage.id });
        }
      });
    },
    onCreatePageLink: async (name) => {
      try {
        if (!systemClassIds?.page) return undefined;
        const newPage = await createNode.mutateAsync({ name, classes: [systemClassIds.page] });
        return String(newPage.id);
      } catch (error) {
        console.error('Failed to create page for link:', error);
        return undefined;
      }
    },
    onOpenComments: (blockId) => {
      openCommentsForNode(blockId);
    },
    onAssetUpload: (blockId, typesOrFile) => {
      setTargetBlockId(blockId);
      // Check if block is empty - if so, convert it to an asset
      const block = children.find(c => c.id === blockId);
      const isEmpty = !block?.name || block.name.trim() === '';
      setConvertToAsset(isEmpty);
      
      if (typesOrFile instanceof File) {
        setPendingFile(typesOrFile);
        setAssetTypeFilter(undefined);
      } else {
        setPendingFile(null);
        setAssetTypeFilter(typesOrFile);
      }
      setIsAssetUploadOpen(true);
    },
    onOpenBacklinks: (blockId) => {
      addSidebarCard(blockId, 'block');
    },
    getCommentCount: (block) => block.comment_count ?? 0,
    getBacklinkCount: (block) => block.backlink_count ?? 0,
  }), [addClass, addTag, addTagLink, createNode, openCommentsForNode, addSidebarCard, systemClassIds, children]);

  const viewMode = toViewMode(displayMode);

  return (
    <div className={`node-content ${displayMode}`} ref={contentRef}>
      {/* Box selection for multi-select (disabled in card mode) */}
      {displayMode !== 'card' && (
        <BoxSelect containerRef={contentRef} enabled={true} />
      )}
      
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
            provideBlockCallbacks={true}
            blockCallbacks={blockCallbacks}
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
