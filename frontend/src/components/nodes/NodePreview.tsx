/**
 * NodePreview Component (Transclusion)
 * 
 * A floating preview popup that appears when hovering over node links.
 * Supports full editing capabilities like a mini editor instance.
 */
import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { useNode, useUpdateNode, useCreateNode, useClasses } from '@/hooks';
import { nodeNameToText } from '@/hooks/useStringifyAST';
import { getEffectiveIcon } from '@/utils/nodeIcon';
import { useNodesStore } from '@/stores';
import { mdiPlus, mdiOpenInNew, mdiArrowExpand, mdiClose } from '@mdi/js';
import Icon from '@mdi/react';
import { NoteesEditor } from '@/editor/NoteesEditor';
import { Bullet } from '../blocks/Bullet';
import { NodeIcon } from '../icons';
import { Button } from '../core/Button';
import './NodePreview.css';

interface NodePreviewProps {
  nodeId: number;
  position: { x: number; y: number };
  onClose: () => void;
  /** Anchor element to position relative to */
  anchorRect?: DOMRect | null;
}

export function NodePreview({ nodeId, position, onClose, anchorRect }: NodePreviewProps) {
  const { data: node, isLoading, error } = useNode(nodeId, { include_children: true });
  const { data: allClasses } = useClasses();
  const updateNode = useUpdateNode();
  const createNode = useCreateNode();
  const { openNode, addSidebarCard } = useNodesStore();
  
  const containerRef = useRef<HTMLDivElement>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [adjustedPosition, setAdjustedPosition] = useState(position);

  // Get effective icon (node's icon or first class's icon)
  const effectiveIcon = useMemo(() => getEffectiveIcon(node, allClasses), [node, allClasses]);

  // Adjust position to stay within viewport
  useEffect(() => {
    if (!containerRef.current) return;
    
    let x = position.x;
    let y = position.y;
    
    // Offset from anchor
    if (anchorRect) {
      x = anchorRect.right + 8;
      y = anchorRect.top;
    }
    
    // Keep within viewport
    const padding = 16;
    const maxWidth = 400;
    const maxHeight = 500;
    
    if (x + maxWidth > window.innerWidth - padding) {
      x = anchorRect ? anchorRect.left - maxWidth - 8 : window.innerWidth - maxWidth - padding;
    }
    if (y + maxHeight > window.innerHeight - padding) {
      y = window.innerHeight - maxHeight - padding;
    }
    if (x < padding) x = padding;
    if (y < padding) y = padding;
    
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Calculate position based on DOM measurements
    setAdjustedPosition({ x, y });
  }, [position, anchorRect, nodeId]);

  // Close on click outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as HTMLElement)) {
        onClose();
      }
    };

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    // Delay adding listener to prevent immediate close
    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside);
      document.addEventListener('keydown', handleEscape);
    }, 100);
    
    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [onClose]);

  const handleOpenNode = useCallback(() => {
    openNode(nodeId, node?.is_page ? 'page' : 'block');
    onClose();
  }, [nodeId, node, openNode, onClose]);

  const handleOpenInSidebar = useCallback(() => {
    addSidebarCard(nodeId, node?.is_page ? 'page' : 'block');
    onClose();
  }, [nodeId, node, addSidebarCard, onClose]);

  const handleContentChange = useCallback((content: string) => {
    updateNode.mutate({ id: nodeId, data: { name: content } });
  }, [nodeId, updateNode]);

  const handleChildContentChange = useCallback((childId: number, content: string) => {
    updateNode.mutate({ id: childId, data: { name: content } });
  }, [updateNode]);

  const handleAddBlock = useCallback(async () => {
    // Compute next sequence from all node children
    const maxSequence = node?.children?.reduce((max, child) => 
      Math.max(max, child.sequence ?? 0), -1) ?? -1;
    
    const _newNode = await createNode.mutateAsync({ 
      name: '', 
      parent_id: nodeId,
      sequence: maxSequence + 1,
    });
  }, [nodeId, node?.children, createNode]);

  if (isLoading) {
    return (
      <div
        ref={containerRef}
        className="node-preview loading"
        style={{ left: adjustedPosition.x, top: adjustedPosition.y }}
      >
        <div className="node-preview-loading">Loading...</div>
      </div>
    );
  }

  if (error || !node) {
    return (
      <div
        ref={containerRef}
        className="node-preview error"
        style={{ left: adjustedPosition.x, top: adjustedPosition.y }}
      >
        <div className="node-preview-error">Node not found</div>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className={`node-preview ${isEditing ? 'editing' : ''}`}
      style={{ left: adjustedPosition.x, top: adjustedPosition.y }}
    >
      <div className="node-preview-header">
        <div className="node-preview-title">
          <NodeIcon icon={effectiveIcon} isPage={node.is_page} size="sm" />
          <span className="node-preview-name">{nodeNameToText(node.name) || 'Untitled'}</span>
        </div>
        <div className="node-preview-actions">
          <button
            className="node-preview-btn"
            onClick={handleOpenInSidebar}
            title="Open in sidebar"
          >
            <Icon path={mdiArrowExpand} size={0.65} />
          </button>
          <button
            className="node-preview-btn"
            onClick={handleOpenNode}
            title="Open page"
          >
            <Icon path={mdiOpenInNew} size={0.65} />
          </button>
          <button
            className="node-preview-btn"
            onClick={onClose}
            title="Close"
          >
            <Icon path={mdiClose} size={0.65} />
          </button>
        </div>
      </div>
      
      <div className="node-preview-content">
        {node.is_page ? (
          <>
            {/* Page content - show children */}
            <div className="node-preview-blocks">
              {node.children && node.children.length > 0 ? (
                <NoteesEditor
                  editorId={`preview-${nodeId}`}
                  rootBlockId={String(node.uuid || node.id)}
                  mode="list"
                  readOnly={!isEditing}
                  placeholder="No content"
                />
              ) : (
                <div className="node-preview-empty">No content</div>
              )}
            </div>
            {isEditing && (
              <Button 
                icon={mdiPlus}
                className="node-preview-add-block" 
                onClick={handleAddBlock}
                title="Add block"
                size="sm"
                variant="ghost"
              >
                Add block
              </Button>
            )}
          </>
        ) : (
          /* Block content - show the block itself */
          <NoteesEditor
            editorId={`preview-block-${nodeId}`}
            rootBlockId={String(node.uuid || node.id)}
            mode="document"
            readOnly={!isEditing}
            placeholder="Empty block"
          />
        )}
      </div>
      
      <div className="node-preview-footer">
        <span className="node-preview-hint">
          Click to edit • Esc to close
        </span>
      </div>
    </div>
  );
}

export default NodePreview;
