/**
 * WhiteboardCardRenderer — Renders card elements on the whiteboard.
 *
 * Uses NodeCard (same as NodeCollection card view) for consistent rendering.
 *
 * Two modes:
 *   'block'     — Uses the block's own nodeId to display the child block as a card.
 *   'reference' — Uses the referenced node's nodeId to display that node as a card.
 */
import React from 'react';
import type { WhiteboardCardElement } from '@/types/whiteboard';
import { useNode } from '@/hooks/useNodes';
import { NodeCard } from './CardItem';

interface Props {
  element: WhiteboardCardElement;
  zoom: number;
}

// ─── Card wrapper — fetches node by numeric ID and renders via NodeCard ─────

const WhiteboardNodeCard: React.FC<{ nodeId: number }> = ({ nodeId }) => {
  const { data: node } = useNode(nodeId, { include_children: true });

  if (!node) {
    return (
      <div className="whiteboard-card">
        <span style={{ opacity: 0.5, fontStyle: 'italic', padding: '8px' }}>Loading...</span>
      </div>
    );
  }

  return (
    <NodeCard
      node={node}
      index={0}
      layout="no-cover"
      editable={false}
    />
  );
};

// ─── Main renderer (dispatches by cardMode) ─────────────────────────

export const WhiteboardCardRenderer: React.FC<Props> = ({ element }) => {
  // Block card: use the block's own nodeId
  // Reference card: use the referenced node's nodeId
  return <WhiteboardNodeCard nodeId={element.nodeId} />;
};
