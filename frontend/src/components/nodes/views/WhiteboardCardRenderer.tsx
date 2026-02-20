/**
 * WhiteboardCardRenderer — Renders card elements on the whiteboard.
 *
 * Uses NodeCard (same as NodeCollection card view) for consistent rendering.
 *
 * Two modes:
 *   'block'     — Uses the block's own nodeId to display the child block as a card.
 *   'reference' — Uses the referenced node's nodeId to display that node as a card.
 */
import React, { useMemo, useCallback } from 'react';
import type { WhiteboardCardElement } from '@/types/whiteboard';
import { useNode } from '@/hooks/useNodes';
import { NodeCard } from './CardItem';
import { getNodeGraphRuntime } from '@/runtime/NodeGraphRuntime';
import { apiNodesToGraphNodes } from '@/hooks/useRuntimeSync';
import type { Node } from '@/types/api';

interface Props {
  element: WhiteboardCardElement;
  zoom: number;
}

// ─── Card wrapper — fetches node by numeric ID and renders via NodeCard ─────

const WhiteboardNodeCard: React.FC<{ nodeId: number; element: WhiteboardCardElement; zoom: number }> = ({ nodeId, element, zoom }) => {
  const { data: node } = useNode(nodeId, { include_children: true });

  // Sync node + children into the NodeGraphRuntime so BlockEditor can find their content.
  // Mirrors the same useMemo pattern used by CardView.
  useMemo(() => {
    if (!node) return;
    const allNodes: Node[] = [];
    const collect = (n: Node) => {
      allNodes.push(n);
      if (n.children) {
        for (const child of n.children) collect(child);
      }
    };
    collect(node);
    const runtime = getNodeGraphRuntime();
    const { graphNodes } = apiNodesToGraphNodes(allNodes);
    runtime.upsertNodes(graphNodes);
  }, [node]);

  if (!node) {
    return (
      <div className="whiteboard-card">
        <span style={{ opacity: 0.5, fontStyle: 'italic', padding: '8px' }}>Loading...</span>
      </div>
    );
  }

  // Stop pointer events from reaching the whiteboard canvas ONLY when the
  // click target is an interactive element (button, input, select, textarea,
  // or anything with data-interactive). Plain empty-space clicks propagate
  // normally so the whiteboard can still select/drag the card element.
  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest('button, input, select, textarea, a, [role="button"], [data-interactive]')) {
      e.stopPropagation();
    }
  }, []);

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
        pointerEvents: 'auto',
      }}
      onPointerDown={handlePointerDown}
    >
      <NodeCard
        node={node}
        index={0}
        layout="no-cover"
        editable={true}
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
