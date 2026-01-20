/**
 * NodeContent Component
 * 
 * Displays the children blocks of a node with:
 * - Block selection support (box select)
 * - Drag and drop reordering
 * - Add block functionality
 * - Support for different display modes (bullet, document)
 * 
 * Used by both page view and block view.
 */
import { useRef, useCallback, useState } from 'react';
import { useCreateNode, useUpdateNode, useAddTag, useAddType, useCreatePage, useBlockSelection, useTypes, useAddTagLink } from '@/hooks';
import { useNodesStore, useBlockSelectionStore } from '@/stores';
import type { Node, NodeUpdate } from '@/types';
import { Block } from './Block';
import { BoxSelect } from './core/BoxSelect';
import { AssetUploadModal } from './AssetUploadModal';
import { ButtonAdd } from './core/ButtonAdd';
import { CardViewCard } from './CardViewCard';
import { type Asset, type AssetCategory } from '../api/assets';
import './NodeContent.css';
import './CardViewCard.css';

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
  const { addSidebarCard, openNode, openCommentsForNode, cardLayout, setCardLayout } = useNodesStore();
  
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
  const handleBlockBulletClick = useCallback((blockId: number) => {
    openNode(blockId, 'block');
  }, [openNode]);

  const handleBlockShiftClick = useCallback((blockId: number) => {
    addSidebarCard(blockId, 'block');
  }, [addSidebarCard]);

  // Handle adding a type to a block
  const handleAddType = useCallback((blockId: number) => (typeNodeId: number, _keepInline: boolean, _typeName: string) => {
    addType.mutate({ nodeId: blockId, typeId: typeNodeId });
  }, [addType]);

  // Handle adding a tag to a block
  const handleAddTag = useCallback((blockId: number) => (tagNodeId: number, keepInline: boolean, _tagName: string) => {
    // Always add to the tags property
    addTag.mutate({ nodeId: blockId, tagId: tagNodeId });
    
    // If kept inline, also mark the link as a tag
    if (keepInline) {
      addTagLink.mutate({ nodeId: blockId, targetNodeId: tagNodeId });
    }
  }, [addTag, addTagLink]);

  // Handle creating a new type
  const handleCreateType = useCallback((blockId: number) => (name: string) => {
    const typeType = allTypes?.find(t => t.name?.toLowerCase() === 'type');
    
    createPage.mutate({ name }, {
      onSuccess: (newPage) => {
        addType.mutate({ nodeId: blockId, typeId: newPage.id });
        if (typeType) {
          addType.mutate({ nodeId: newPage.id, typeId: typeType.id });
        }
      }
    });
  }, [createPage, addType, allTypes]);

  // Handle creating a new tag
  const handleCreateTag = useCallback((blockId: number) => (name: string) => {
    createPage.mutate({ name }, {
      onSuccess: (newPage) => {
        addTag.mutate({ nodeId: blockId, tagId: newPage.id });
      }
    });
  }, [createPage, addTag]);

  // Handle opening comments for a block
  const handleOpenComments = useCallback((blockId: number) => () => {
    openCommentsForNode(blockId);
  }, [openCommentsForNode]);

  // Handle opening asset upload for a block
  const handleAssetUpload = useCallback((blockId: number) => (typesOrFile?: AssetCategory[] | File) => {
    setTargetBlockId(blockId);
    
    if (typesOrFile instanceof File) {
      setPendingFile(typesOrFile);
      setAssetTypeFilter(undefined);
    } else {
      setPendingFile(null);
      setAssetTypeFilter(typesOrFile);
    }
    setIsAssetUploadOpen(true);
  }, []);

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
      
      {/* Card mode: render as cards with layout selector */}
      {displayMode === 'card' && children.length > 0 && (
        <>
          {/* Card layout selector */}
          <div className="card-layout-selector">
            <span className="card-layout-selector__label">Layout:</span>
            <button 
              className={`card-layout-option ${cardLayout === 'no-cover' ? 'card-layout-option--active' : ''}`}
              onClick={() => setCardLayout('no-cover')}
              title="No cover"
            >
              <span className="layout-icon layout-icon--no-cover">
                <span className="layout-icon__content"></span>
              </span>
            </button>
            <button 
              className={`card-layout-option ${cardLayout === 'cover-top' ? 'card-layout-option--active' : ''}`}
              onClick={() => setCardLayout('cover-top')}
              title="Cover on top"
            >
              <span className="layout-icon layout-icon--cover-top">
                <span className="layout-icon__cover"></span>
                <span className="layout-icon__content"></span>
              </span>
            </button>
            <button 
              className={`card-layout-option ${cardLayout === 'cover-side' ? 'card-layout-option--active' : ''}`}
              onClick={() => setCardLayout('cover-side')}
              title="Cover on side"
            >
              <span className="layout-icon layout-icon--cover-side">
                <span className="layout-icon__cover"></span>
                <span className="layout-icon__content"></span>
              </span>
            </button>
          </div>
          
          {/* Cards grid */}
          <section className="node-content-cards">
            {children.map((child) => (
              <CardViewCard
                key={child.id}
                node={child}
                layout={cardLayout}
                onClick={() => handleBlockBulletClick(child.id)}
                onShiftClick={() => handleBlockShiftClick(child.id)}
              />
            ))}
          </section>
        </>
      )}
      
      {/* Bullet/Document mode: render as blocks */}
      {displayMode !== 'card' && children.length > 0 && (
        <section className={`node-content-children blocks-container ${displayMode === 'document' ? 'document-mode' : ''}`}>
          {children.map((child) => (
            <Block
              key={child.id}
              block={child}
              children={child.children}
              siblings={children}
              parentId={node.id}
              parentBlock={node}
              onContentChange={handleBlockChange}
              onBulletClick={handleBlockBulletClick}
              onShiftClick={handleBlockShiftClick}
              onAddType={handleAddType(child.id)}
              onAddTag={handleAddTag(child.id)}
              onCreateType={handleCreateType(child.id)}
              onCreateTag={handleCreateTag(child.id)}
              onOpenComments={handleOpenComments(child.id)}
              onAssetUpload={handleAssetUpload(child.id)}
              commentCount={child.comment_count}
              backlinkCount={child.backlink_count}
              onOpenBacklinks={() => addSidebarCard(child.id, 'block')}
            />
          ))}
        </section>
      )}
      
      {/* Empty state */}
      {children.length === 0 && (
        <div className="node-content-empty">
          <ButtonAdd onClick={handleAddBlock} className="add-block-btn" title="Add block" size="sm">
            Add block
          </ButtonAdd>
        </div>
      )}
      
      {/* Add block button when there are children */}
      {children.length > 0 && (
        <div className="node-content-add">
          <ButtonAdd onClick={handleAddBlock} className="add-block-btn" title="Add block" size="sm">
            Add block
          </ButtonAdd>
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
