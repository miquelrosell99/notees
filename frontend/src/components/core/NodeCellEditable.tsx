import { useState, useCallback, useRef, useEffect } from 'react';
import type { Node } from '@/types';
import { NodeInline } from '../blocks/NodeInline';
import { NodeCollection } from '../nodes/NodeCollection';
import { useContentSave, useNodeNavigation } from '@/hooks';
import { useBlockPersist } from '@/hooks/useBlockPersist';

interface NodeCellEditableProps {
  node: Node;
  /** Pre-resolved display text for nodes with inline links */
  displayText?: string;
}

/**
 * A node name cell that switches to an inline NodeCollection/BlockEditor on click.
 * Uses the same pattern as TextPropertyBlock for text properties.
 * Click outside or press Escape to close.
 */
export function NodeCellEditable({ node, displayText }: NodeCellEditableProps) {
  const [editing, setEditing] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const { handleContentChange, flushAll } = useContentSave();
  const { handleNodeClick } = useNodeNavigation();
  const flushRef = useRef(flushAll);
  flushRef.current = flushAll;

  useBlockPersist();

  const closeEditing = useCallback(() => {
    flushRef.current();
    setEditing(false);
  }, []);

  // Click-outside → close editor
  useEffect(() => {
    if (!editing) return;
    const handleMouseDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as HTMLElement)) {
        closeEditing();
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        closeEditing();
      }
    };
    document.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleMouseDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [editing, closeEditing]);

  if (editing) {
    return (
      <div ref={containerRef} className="table-node-cell__editor" onClick={(e) => e.stopPropagation()}>
        <NodeCollection
          nodes={[node]}
          viewMode="document"
          availableViewModes={['document']}
          editable={true}
          onNodeClick={handleNodeClick}
          onContentChange={handleContentChange}
          pageId={node.id}
          pageUuid={node.uuid}
          hideToolbar={true}
          hideProperties={true}
          maxDepth={0}
        />
      </div>
    );
  }

  return (
    <span
      className="table-node-cell__name"
      onClick={(e) => {
        e.stopPropagation();
        setEditing(true);
      }}
    >
      <NodeInline
        name={node.name}
        icon={node.icon}
        isPage={node.is_page}
        nodeId={node.id}
        showIcon={false}
        displayText={displayText}
      />
    </span>
  );
}
