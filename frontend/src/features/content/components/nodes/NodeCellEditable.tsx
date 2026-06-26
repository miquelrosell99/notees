import { useState, useCallback, useRef, useEffect } from 'react';
import type { Node } from '@/types';
import { NodeNameContent } from '@/features/content/components/blocks/NodeNameContent';
import { NodeCollection } from '@/features/content/components/nodes/NodeCollection';
import { useNodeNavigation } from '@/features/content';
import { useContentSave } from '@/features/editor';

interface NodeCellEditableProps {
  node: Node;
}

/**
 * A node name cell that switches to an inline NodeCollection/BlockEditor on click.
 * Uses the same pattern as TextPropertyBlock for text properties.
 * Click outside or press Escape to close.
 */
export function NodeCellEditable({ node }: NodeCellEditableProps) {
  const [editing, setEditing] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const { handleContentChange, flushAll } = useContentSave();
  const { handleNodeClick } = useNodeNavigation();
  const flushRef = useRef(flushAll);
  flushRef.current = flushAll;

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
      <div ref={containerRef} className="table-node-cell__editor" onClickCapture={(e) => e.stopPropagation()}>
        <NodeCollection
          nodes={[node]}
          viewMode="document"
          availableViewModes={['document']}
          editable={true}
          onNodeClick={handleNodeClick}
          onContentChange={handleContentChange}
          pageId={node.uuid}
          nodeUuid={node.uuid}
          hideToolbar={true}
          hideProperties={true}
          maxDepth={0}
        />
      </div>
    );
  }

  return (
    <button
      type="button"
      className="table-node-cell__name"
      onClick={(e) => {
        e.stopPropagation();
        setEditing(true);
      }}
    >
      <NodeNameContent name={node.name} />
    </button>
  );
}
