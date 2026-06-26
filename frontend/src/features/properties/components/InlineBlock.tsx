import { useNode } from '@/features/content';
import { NodeInline } from '@/features/content';
import { Spinner } from '@/components/ui/Spinner';
import './PropertyCell.css';

/**
 * InlineBlock - Fetches a node by ID and renders it as a read-only Block.
 * Used for text properties (value is a block node ID) and single-value node properties.
 */
export function InlineBlock({ nodeUuid }: { nodeUuid: string }) {
  const { data: blockNode } = useNode(nodeUuid);

  if (!blockNode) {
    return (
      <div className="property-cell property-cell--loading">
        <Spinner size="sm" />
      </div>
    );
  }

  return (
    <NodeInline
      name={blockNode.name}
      icon={blockNode.icon}
      isPage={blockNode.is_page}
      nodeUuid={blockNode.uuid}
    />
  );
}
