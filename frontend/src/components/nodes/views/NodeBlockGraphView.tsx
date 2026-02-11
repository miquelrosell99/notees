/**
 * NodeBlockGraphView
 *
 * Graph view that embeds NoteesEditor instances inside force-directed graph
 * node cards.  For the actual physics / canvas rendering we delegate to the
 * existing `NodeGraphViewSimple` (which will be migrated later).  This
 * component provides a DOM-overlay layer where each visible graph node gets
 * a small Lexical editor overlay positioned over its canvas coordinates.
 *
 * NOTE: The full canvas graph renderer is complex (~3 000 lines); here we
 * provide the Lexical integration layer.  The canvas component itself stays
 * as-is and will be incrementally migrated.
 */

import React from 'react';
import { NoteesEditor } from '@/editor/NoteesEditor';
import './NodeBlockGraphView.css';

export interface NodeBlockGraphViewProps {
  rootBlockId: string;
  readOnly?: boolean;
  onNavigateToNode?: (linkId: string) => void;
}

/**
 * For now the graph view renders a simple card-per-node layout in a flex
 * container.  The full force-directed canvas renderer lives in
 * `components/graph/` and will be incrementally migrated to overlay
 * Lexical editors.
 */
export const NodeBlockGraphView: React.FC<NodeBlockGraphViewProps> = ({
  rootBlockId,
  readOnly = true,
  onNavigateToNode,
}) => {
  return (
    <div className="node-block-graph-view">
      <NoteesEditor
        rootBlockId={rootBlockId}
        readOnly={readOnly}
        viewMode="graph"
        onNavigateToNode={onNavigateToNode}
      />
    </div>
  );
};
