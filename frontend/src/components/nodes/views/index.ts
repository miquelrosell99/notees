/**
 * NodeCollection Views Index
 *
 * Exports all view mode components for NodeCollection.
 * All views now use Lexical BlockEditor internally.
 */

export { ListView } from './ListView';
export { DocumentView } from './DocumentView';
export { CardView } from './CardView';
export { NodeCard } from './CardItem';
export type { NodeCardProps } from './CardItem';
export { TableView } from './TableView';
export { GanttView } from './GanttView';
export { GraphView } from './GraphView';
export type { GraphViewProps } from './GraphView';
export { TerrainView } from './TerrainView';
export type { TerrainViewProps } from './TerrainView';
export { TimelineView } from './TimelineView';
export { WhiteboardView } from './WhiteboardView';
export { TerrainRenderer, type TerrainRendererRef } from './TerrainRenderer';

// Graph canvas (physics worker + WebGL2 renderer)
export { GraphCanvas } from './GraphCanvas';
export type { GraphCanvasProps, GraphCanvasRef } from './GraphCanvas';
export { useGraphCanvas } from './useGraphCanvas';
export type { GraphCanvasOptions, GraphCanvasHandle, GraphCanvasStats } from './useGraphCanvas';
export { GraphWebGLRenderer } from './graphWebGLRenderer';
export type { NodeVisual, RendererOptions, CameraState } from './graphWebGLRenderer';

// Shared view types and helpers
export * from './viewTypes';
export * from './viewHelpers';
