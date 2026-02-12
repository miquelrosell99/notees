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
import { useRef, useCallback, useState } from 'react';
import { useCreateNode, useContentSave, useNodeNavigation } from '@/hooks';
import { useAppStore } from '@/stores';
import { getNodeGraphRuntime } from '@/runtime/NodeGraphRuntime';
import type { Node } from '@/types';
import type { NodeCollectionViewMode } from '@/types/nodeCollection';
import { mdiPlus } from '@mdi/js';
import { NodeCollection } from './NodeCollection';
import { AssetUploadModal } from '../assets/AssetUploadModal';
import { Button } from '../core/Button';
import { type Asset, type AssetCategory } from '@/api/assets';
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
  const { addSidebarCard } = useAppStore();
  const { handleNodeClick, handleNodeShiftClick } = useNodeNavigation();

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
    // Add child block at the end
    const maxSequence = children.reduce((max, child) => 
      Math.max(max, child.sequence ?? 0), -1);
    
    const newNode = await createNode.mutateAsync({
      name: '',
      parent_id: node.id,
      sequence: maxSequence + 1,
    });
    // Request focus on the newly created block so the editor focuses it after sync
    const runtime = getNodeGraphRuntime();
    runtime.requestFocus(newNode.uuid);
  }, [createNode, node.id, children]);

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
