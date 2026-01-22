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
import { useCallback } from 'react';
import type { Node } from '@/types';
import type { NodeDocumentViewProps } from '@/types/nodeCollection';
import { Block } from '../../blocks/Block';
import { BlockPreview } from '../../blocks/BlockPreview';
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
  const children = node.children ?? [];
  const shouldRenderChildren = depth < maxDepth && children.length > 0;

  // Helper to find a node by ID in the tree (for child bullet clicks)
  const findNodeById = useCallback((id: number, nodes: Node[]): Node | null => {
    for (const n of nodes) {
      if (n.id === id) return n;
      if (n.children) {
        const found = findNodeById(id, n.children);
        if (found) return found;
      }
    }
    return null;
  }, []);

  // Handlers
  const handleBulletClick = useCallback((blockId: number) => {
    if (blockId === node.id) {
      onNodeClick?.(node);
    } else {
      const childNode = findNodeById(blockId, children);
      if (childNode) {
        onNodeClick?.(childNode);
      } else {
        onNodeClick?.({ id: blockId, is_page: false } as Node);
      }
    }
  }, [node, children, onNodeClick, findNodeById]);

  const handleShiftClick = useCallback((blockId: number) => {
    if (blockId === node.id) {
      onNodeShiftClick?.(node);
    } else {
      const childNode = findNodeById(blockId, children);
      if (childNode) {
        onNodeShiftClick?.(childNode);
      } else {
        onNodeShiftClick?.({ id: blockId, is_page: false } as Node);
      }
    }
  }, [node, children, onNodeShiftClick, findNodeById]);

  const handleContentChange = useCallback((blockId: number, content: string) => {
    onContentChange?.(blockId, content);
  }, [onContentChange]);

  return (
    <div className="document-node">
      {/* Editable mode: render Block without bullet */}
      {editable ? (
        <Block
          block={node}
          children={children}
          siblings={siblings}
          depth={0}
          parentId={node.parent_id}
          parentBlock={parentBlock}
          onContentChange={handleContentChange}
          onBulletClick={handleBulletClick}
          onShiftClick={handleShiftClick}
          showBullet={false}
        />
      ) : (
        /* Read-only mode: render BlockPreview without bullet */
        <div className="document-node__content">
          <BlockPreview
            variant="simple"
            node={node}
            showBullet={false}
            onClick={() => onNodeClick?.(node)}
            onShiftClick={() => onNodeShiftClick?.(node)}
          />
          
          {/* Recursive children */}
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
    </div>
  );
}
