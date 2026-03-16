import { useState, useCallback, useRef, useEffect } from 'react';
import type { Node } from '@/types';
import { NodeInline } from '../blocks/NodeInline';
import { BlockEditor } from '@/editor/BlockEditor';
import { useContentSave } from '@/hooks/useContentSave';

interface NodeCellEditableProps {
  node: Node;
}

/**
 * A node name cell that switches to an inline BlockEditor on click.
 * Click outside or press Escape to close.
 */
export function NodeCellEditable({ node }: NodeCellEditableProps) {
  const [editing, setEditing] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const { handleContentChange: save, flushAll } = useContentSave();
  const flushRef = useRef(flushAll);
  flushRef.current = flushAll;

  const closeEditing = useCallback(() => {
    flushRef.current();
    setEditing(false);
  }, []);

  // Click-outside → close editor
  useEffect(() => {
    if (!editing) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as HTMLElement)) {
        closeEditing();
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [editing, closeEditing]);

  // Bridge: BlockEditor string blockId → numeric node.id
  const handleContentChangeBridge = useCallback((_blockId: string, content: string) => {
    save(node.id, content);
  }, [node.id, save]);

  if (editing) {
    return (
      <div ref={containerRef} className="table-node-cell__editor" onClick={(e) => e.stopPropagation()}>
        <BlockEditor
          nodes={[node]}
          mode="document"
          hideProperties={true}
          draftMode={true}
          onContentChange={handleContentChangeBridge}
          canIndent={() => false}
          canOutdent={() => false}
          canMerge={() => false}
          canDelete={() => false}
          onEscape={closeEditing}
          className="table-node-cell__block-editor"
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
      />
    </span>
  );
}
