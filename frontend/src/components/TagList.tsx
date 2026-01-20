/**
 * Tag list component for displaying and navigating tags
 */
import { useTags, useNodesByTag } from '@/hooks';
import './TagList.css';
import { useNodesStore } from '@/stores';
import type { Node } from '@/types';
import { TagIcon, NodeIcon } from './icons';

interface TagListProps {
  className?: string;
  onTagClick?: (tagId: number) => void;
}

export function TagList({ className = '', onTagClick }: TagListProps) {
  const { data: tags, isLoading, error } = useTags();

  if (isLoading) {
    return <div className={`tag-list loading ${className}`}>Loading tags...</div>;
  }

  if (error) {
    return <div className={`tag-list error ${className}`}>Failed to load tags</div>;
  }

  if (!tags || tags.length === 0) {
    return (
      <div className={`tag-list empty ${className}`}>
        <p>No tags found</p>
      </div>
    );
  }

  return (
    <ul className={`tag-list ${className}`}>
      {tags.map((tag: Node) => (
        <li key={tag.id} className="tag-item">
          <button
            className="tag-button"
            onClick={() => onTagClick?.(tag.id)}
          >
            <span className="tag-icon"><TagIcon size="xs" /></span>
            <span className="tag-name">{tag.name || 'Untitled'}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

interface TaggedNodesProps {
  tagId: number | null;
  className?: string;
  onNodeClick?: (node: Node) => void;
}

export function TaggedNodes({ tagId, className = '', onNodeClick }: TaggedNodesProps) {
  const { data: nodes, isLoading, error } = useNodesByTag(tagId);
  const { openNode } = useNodesStore();

  const handleNodeClick = (node: Node) => {
    if (onNodeClick) {
      onNodeClick(node);
    } else {
      openNode(node.id, node.is_page ? 'page' : 'block');
    }
  };

  if (isLoading) {
    return <div className={`tagged-nodes loading ${className}`}>Loading...</div>;
  }

  if (error) {
    return <div className={`tagged-nodes error ${className}`}>Failed to load nodes</div>;
  }

  if (!nodes || nodes.length === 0) {
    return (
      <div className={`tagged-nodes empty ${className}`}>
        <p>No nodes with this tag</p>
      </div>
    );
  }

  return (
    <ul className={`tagged-nodes ${className}`}>
      {nodes.map((node: Node) => (
        <li key={node.id} className="tagged-node-item">
          <button
            className="tagged-node-button"
            onClick={() => handleNodeClick(node)}
          >
            <span className="node-icon">
              <NodeIcon icon={node.icon} isPage={true} />
            </span>
            <span className="node-title">
              {node.name || 'Untitled'}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
