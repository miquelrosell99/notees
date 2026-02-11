/**
 * Graph Components
 * 
 * Architecture:
 * - NodeGraphRenderer: Core visualization (physics, links, nodes, pan/zoom)
 * - NodeGraphView: Full-featured with settings, menus, type coloring
 * - NodeGraphViewSimple: Simplified without UI chrome
 * - GraphViewAll: Main page view using NodeGraphView
 * - GraphViewAllCard: Minimap card using NodeGraphViewSimple
 * - GraphViewLocal: Sidebar card with local graph around current node
 */


// Core components
export { NodeGraphRenderer } from './NodeGraphRenderer';
export type { NodeGraphRendererRef, GraphNode, GraphLink, GraphSettings, GraphViewMode } from './NodeGraphRenderer';

// Re-export ClassColor from shared for convenience
export type { ClassColor } from '../shared/ClassColorsPanel';

export { NodeGraphView } from './NodeGraphView';
export type { NodeGraphViewProps } from './NodeGraphView';

export { NodeGraphViewSimple } from './NodeGraphViewSimple';
export type { NodeGraphViewSimpleProps } from './NodeGraphViewSimple';

// Usage components
export { GraphViewAll } from './GraphViewAll';
export type { GraphViewAllProps } from './GraphViewAll';

export { GraphViewAllCard } from './GraphViewAllCard';
export type { GraphViewAllCardProps } from './GraphViewAllCard';

export { GraphViewLocal } from './GraphViewLocal';
export type { GraphViewLocalProps } from './GraphViewLocal';
