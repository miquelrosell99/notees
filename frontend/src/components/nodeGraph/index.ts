/**
 * Graph Components
 * 
 * Architecture:
 * - NodeGraphRenderer: Core visualization (physics, links, nodes, pan/zoom)
 * - NodeGraphView: Universal graph component — self-fetching or controlled mode,
 *   with optional chrome (settings, colors, visibility, search, mode switcher)
 * - GraphViewAllCard: Minimap card using NodeGraphView (chrome=false)
 * - GraphViewLocal: Sidebar card with local subgraph using NodeGraphView (controlled, chrome=false)
 */


// Core components
export { NodeGraphRenderer } from './NodeGraphRenderer';
export type { NodeGraphRendererRef, GraphNode, GraphLink, GraphSettings, GraphViewMode } from './NodeGraphRenderer';

// Re-export ClassColor from shared for convenience
export type { ClassColor } from '../shared/ClassColorsPanel';

export { NodeGraphView } from './NodeGraphView';
export type { NodeGraphViewProps } from './NodeGraphView';

// Usage components
export { GraphViewAllCard } from './GraphViewAllCard';
export type { GraphViewAllCardProps } from './GraphViewAllCard';

export { GraphViewLocal } from './GraphViewLocal';
export type { GraphViewLocalProps } from './GraphViewLocal';
