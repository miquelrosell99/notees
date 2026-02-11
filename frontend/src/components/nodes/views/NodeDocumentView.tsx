/**
 * NodeDocumentView Component
 * 
 * Document view for NodeCollection.
 * Displays nodes as a flat recursive list without bullets or indentation.
 * Ideal for reading-focused layouts.
 * 
 * Features:
 * - No bullet points
 * - No indentation
 * - Paragraph-style spacing
 * - Editable: renders Block component (without bullet)
 * - Read-only: renders BlockPreview component
 * - Recursive children handling
 */
import { useCallback, useMemo } from 'react';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import type { Node } from '@/types';
import type { NodeDocumentViewProps } from '@/types/nodeCollection';
import { NodeInline } from '../../blocks/NodeInline';
import { NoteesEditor } from '@/editor/NoteesEditor';
import { findNodeById } from '@/utils/nodeTree';
import './NodeDocumentView.css';

interface DocumentNodeProps {
  node: Node;
  depth: number;
  editable: boolean;
  maxDepth: number;
  siblings: Node[];
  parentBlock?: Node | null;
  onNodeClick?: (node: Node) => void;
  onNodeShiftClick?: (node: Node) => void;
  onContentChange?: (nodeId: number, content: string) => void;
}

function DocumentNode({
  node,
  depth,
  editable,
  maxDepth,
  siblings,
  parentBlock,
  onNodeClick,
  onNodeShiftClick,
  onContentChange,
}: DocumentNodeProps) {
  const children = useMemo(() => node.children ?? [], [node.children]);
  const shouldRenderChildren = depth < maxDepth && children.length > 0;

  const handleNavigateToNode = useCallback((linkId: string) => {
    const id = Number(linkId);
    if (isNaN(id)) return;
    if (id === node.id) {
      onNodeClick?.(node);
    } else {
      const childNode = findNodeById(id, children);
      if (childNode) onNodeClick?.(childNode);
      else onNodeClick?.({ id, is_page: false } as Node);
    }
  }, [node, children, onNodeClick]);

  const handleContentChangeBridge = useCallback((blockId: string, content: string) => {
    const id = Number(blockId);
    if (!isNaN(id)) onContentChange?.(id, content);
  }, [onContentChange]);

  return (
    <div className="document-node">
      {editable ? (
        <NoteesEditor
          editorId={`doc-${node.id}`}
          rootBlockId={String(node.uuid || node.id)}
          viewMode="document"
          readOnly={false}
          onNavigateToNode={handleNavigateToNode}
          onContentChange={handleContentChangeBridge}
          placeholder="Type here…"
        />
      ) : (
        <div className="document-node__content">
          <NodeInline
            name={node.name}
            isPage={node.is_page}
            nodeId={node.id}
            onClick={() => onNodeClick?.(node)}
            onShiftClick={() => onNodeShiftClick?.(node)}
          />
          
          {shouldRenderChildren && (
            <div className="document-node__children">
              {children.map((child) => (
                <DocumentNode
                  key={child.id}
                  node={child}
                  depth={depth + 1}
                  editable={editable}
                  maxDepth={maxDepth}
                  siblings={children}
                  parentBlock={node}
                  onNodeClick={onNodeClick}
                  onNodeShiftClick={onNodeShiftClick}
                  onContentChange={onContentChange}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * NodeDocumentView - Document view for NodeCollection
 */
export function NodeDocumentView({
  nodes,
  editable,
  depth = 0,
  maxDepth = Infinity,
  onNodeClick,
  onNodeShiftClick,
  onContentChange,
  className = '',
}: NodeDocumentViewProps) {
  return (
    <div className={`node-document-view ${className}`}>
      <SortableContext 
        items={nodes.map(node => `block-${node.id}`)}
        strategy={verticalListSortingStrategy}
      >
        {nodes.map((node) => (
          <DocumentNode
            key={node.id}
            node={node}
            depth={depth}
            editable={editable}
            maxDepth={maxDepth}
            siblings={nodes}
            parentBlock={null}
            onNodeClick={onNodeClick}
            onNodeShiftClick={onNodeShiftClick}
            onContentChange={onContentChange}
          />
        ))}
      </SortableContext>
    </div>
  );
}
