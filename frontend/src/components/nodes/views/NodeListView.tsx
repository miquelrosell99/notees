/**
 * NodeListView Component
 * 
 * List/outline view for NodeCollection.
 * Displays nodes as a recursive bullet list with indentation.
 * 
 * Features:
 * - Bullet points with expand/collapse
 * - Indentation based on depth
 * - Editable: renders Block component
 * - Read-only: renders BlockPreview component
 * - Recursive children handling
 */
import { useCallback } from 'react';
import type { Node } from '@/types';
import type { NodeListViewProps } from '@/types/nodeCollection';
import { Block } from '../../blocks/Block';
import { BlockPreview } from '../../blocks/BlockPreview';
import './NodeListView.css';

interface NodeListItemProps {
  node: Node;
  depth: number;
  editable: boolean;
  maxDepth: number;
  showBullets: boolean;
  showIndentation: boolean;
  siblings: Node[];
  parentBlock?: Node | null;
  onNodeClick?: (node: Node) => void;
  onNodeShiftClick?: (node: Node) => void;
  onContentChange?: (nodeId: number, content: string) => void;
}

function NodeListItem({
  node,
  depth,
  editable,
  maxDepth,
  showBullets,
  showIndentation,
  siblings,
  parentBlock,
  onNodeClick,
  onNodeShiftClick,
  onContentChange,
}: NodeListItemProps) {
  const children = node.children ?? [];
  const shouldRenderChildren = depth < maxDepth && children.length > 0;

  // Handlers
  const handleBulletClick = useCallback(() => {
    onNodeClick?.(node);
  }, [node, onNodeClick]);

  const handleShiftClick = useCallback(() => {
    onNodeShiftClick?.(node);
  }, [node, onNodeShiftClick]);

  const handleContentChange = useCallback((blockId: number, content: string) => {
    onContentChange?.(blockId, content);
  }, [onContentChange]);

  // Editable mode: render full Block component
  if (editable) {
    return (
      <Block
        block={node}
        children={children}
        siblings={siblings}
        depth={showIndentation ? depth : 0}
        parentId={node.parent_id}
        parentBlock={parentBlock}
        onContentChange={handleContentChange}
        onBulletClick={handleBulletClick}
        onShiftClick={handleShiftClick}
        showBullet={showBullets}
      />
    );
  }

  // Read-only mode: render BlockPreview with recursive children
  return (
    <div className="node-list-item" style={{ '--depth': showIndentation ? depth : 0 } as React.CSSProperties}>
      <BlockPreview
        variant="simple"
        node={node}
        showBullet={showBullets}
        onClick={() => onNodeClick?.(node)}
        onShiftClick={() => onNodeShiftClick?.(node)}
        onBulletClick={() => onNodeClick?.(node)}
      />
      
      {shouldRenderChildren && (
        <div className="node-list-item__children">
          {children.map((child) => (
            <NodeListItem
              key={child.id}
              node={child}
              depth={depth + 1}
              editable={editable}
              maxDepth={maxDepth}
              showBullets={showBullets}
              showIndentation={showIndentation}
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
  );
}

/**
 * NodeListView - List/outline view for NodeCollection
 */
export function NodeListView({
  nodes,
  editable,
  depth = 0,
  maxDepth = Infinity,
  showBullets = true,
  showIndentation = true,
  onNodeClick,
  onNodeShiftClick,
  onContentChange,
  className = '',
}: NodeListViewProps) {
  return (
    <div className={`node-list-view ${className}`}>
      {nodes.map((node) => (
        <NodeListItem
          key={node.id}
          node={node}
          depth={depth}
          editable={editable}
          maxDepth={maxDepth}
          showBullets={showBullets}
          showIndentation={showIndentation}
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
