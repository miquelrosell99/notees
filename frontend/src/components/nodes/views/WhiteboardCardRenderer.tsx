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

const WhiteboardNodeCard: React.FC<{ nodeId: number; element: WhiteboardCardElement; zoom: number }> = ({ nodeId, element, zoom }) => {
  const { data: node } = useNode(nodeId, { include_children: true });

  if (!node) {
    return (
      <div className="whiteboard-card">
        <span style={{ opacity: 0.5, fontStyle: 'italic', padding: '8px' }}>Loading...</span>
      </div>
    );
  }

  return (
    // Counter-scale: render at the logical canvas size, then apply zoom via CSS
    // transform so the card's internal layout is always at 1× pixel density.
    <div
      style={{
        width: element.width,
        height: element.height,
        transform: `scale(${zoom})`,
        transformOrigin: 'top left',
        overflow: 'hidden',
        pointerEvents: 'none',
      }}
    >
      <NodeCard
        node={node}
        index={0}
        layout="no-cover"
        editable={false}
      />
    </div>
  );
};

// ─── Main renderer (dispatches by cardMode) ─────────────────────────

export const WhiteboardCardRenderer: React.FC<Props> = ({ element, zoom }) => {
  // Block card: use the block's own nodeId
  // Reference card: use the referenced node's nodeId
  return <WhiteboardNodeCard nodeId={element.nodeId} element={element} zoom={zoom} />;
};
