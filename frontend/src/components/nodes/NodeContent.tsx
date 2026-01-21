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
import { useCreateNode, useUpdateNode, useAddTag, useAddType, useCreatePage, useBlockSelection, useTypes, useAddTagLink } from '@/hooks';
import { useNodesStore, useBlockSelectionStore } from '@/stores';
import type { Node, NodeUpdate } from '@/types';
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
  const updateNode = useUpdateNode();
  const createNode = useCreateNode();
  const createPage = useCreatePage();
  const addTag = useAddTag();
  const addType = useAddType();
  const addTagLink = useAddTagLink();
  const { data: allTypes } = useTypes();
  const { addSidebarCard, openNode, openCommentsForNode } = useNodesStore();
  
  // Block selection
  const { enterEditMode } = useBlockSelectionStore();
  useBlockSelection(children, { containerRef: contentRef, enabled: true });

  // Asset upload state
  const [isAssetUploadOpen, setIsAssetUploadOpen] = useState(false);
  const [targetBlockId, setTargetBlockId] = useState<number | null>(null);
  const [assetTypeFilter, setAssetTypeFilter] = useState<AssetCategory[] | undefined>(undefined);
  const [pendingFile, setPendingFile] = useState<File | null>(null);

  const handleBlockChange = useCallback((blockId: number, name: string) => {
    const data: NodeUpdate = { name };
    updateNode.mutate({ id: blockId, data });
  }, [updateNode]);

  const handleAddBlock = useCallback(async () => {
    const newNode = await createNode.mutateAsync({
      name: '',
      parent_id: node.id,
    });
    // Set the new block to edit mode so the user can start typing right away
    enterEditMode(newNode.id);
  }, [createNode, node.id, enterEditMode]);

  const handleNodeClick = useCallback((clickedNode: Node) => {
    openNode(clickedNode.id, clickedNode.is_page ? 'page' : 'block');
  }, [openNode]);

  const handleNodeShiftClick = useCallback((clickedNode: Node) => {
    addSidebarCard(clickedNode.id, clickedNode.is_page ? 'page' : 'block');
  }, [addSidebarCard]);

  // Handle successful asset upload
  const handleAssetUploaded = useCallback((asset: Asset) => {
    if (targetBlockId) {
      const block = children.find(c => c.id === targetBlockId);
      if (block) {
        let assetMarkdown: string;
        if (asset.category === 'image') {
          assetMarkdown = `![${asset.filename}](${asset.uuid})`;
        } else if (asset.category === 'audio') {
          assetMarkdown = `[audio:${asset.filename}](${asset.uuid})`;
        } else {
          assetMarkdown = `[file:${asset.filename}](${asset.uuid})`;
        }
        const newContent = block.name ? `${block.name}\n${assetMarkdown}` : assetMarkdown;
        updateNode.mutate({ id: targetBlockId, data: { name: newContent } });
      }
    }
    setIsAssetUploadOpen(false);
    setTargetBlockId(null);
    setAssetTypeFilter(undefined);
    setPendingFile(null);
  }, [targetBlockId, children, updateNode]);

  // Build block callbacks for context provider
  const blockCallbacks = useMemo<BlockCallbacks>(() => ({
    onAddType: (blockId, typeNodeId, _keepInline, _typeName) => {
      addType.mutate({ nodeId: blockId, typeId: typeNodeId });
    },
    onAddTag: (blockId, tagNodeId, keepInline, _tagName) => {
      addTag.mutate({ nodeId: blockId, tagId: tagNodeId });
      if (keepInline) {
        addTagLink.mutate({ nodeId: blockId, targetNodeId: tagNodeId });
      }
    },
    onCreateType: (blockId, name, _keepInline) => {
      const typeType = allTypes?.find(t => t.name?.toLowerCase() === 'type');
      createPage.mutate({ name }, {
        onSuccess: (newPage) => {
          addType.mutate({ nodeId: blockId, typeId: newPage.id });
          if (typeType) {
            addType.mutate({ nodeId: newPage.id, typeId: typeType.id });
          }
        }
      });
    },
    onCreateTag: (blockId, name, _keepInline) => {
      createPage.mutate({ name }, {
        onSuccess: (newPage) => {
          addTag.mutate({ nodeId: blockId, tagId: newPage.id });
        }
      });
    },
    onCreatePageLink: async (name) => {
      try {
        const newPage = await createPage.mutateAsync({ name });
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
  }), [addType, addTag, addTagLink, createPage, allTypes, openCommentsForNode, addSidebarCard]);

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
          setAssetTypeFilter(undefined); 
          setPendingFile(null); 
        }}
        onUpload={handleAssetUploaded}
        parentId={targetBlockId || node.id}
        acceptedTypes={assetTypeFilter}
        initialFile={pendingFile}
      />
    </div>
  );
}

export default NodeContent;
