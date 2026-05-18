import { useNode } from '@/hooks';
import { NodeInline } from '@/components/blocks/NodeInline';
import './PropertyCell.css';

/**
 * InlineBlock - Fetches a node by ID and renders it as a read-only Block.
 * Used for text properties (value is a block node ID) and single-value node properties.
 */
export function InlineBlock({ nodeId }: { nodeId: number }) {
  const { data: blockNode } = useNode(nodeId);

  if (!blockNode) {
    return (
      <div className="property-cell property-cell--loading">
        Loading...
      </div>
    );
  }

  return (
    <NodeInline
      name={blockNode.name}
      icon={blockNode.icon}
      isPage={blockNode.is_page}
      nodeId={blockNode.id}
    />
  );
}
