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
export { GraphRenderer, type GraphRendererRef } from './GraphRenderer';
export { TerrainRenderer, type TerrainRendererRef } from './TerrainRenderer';

// SGE WebGL2 graph canvas (physics worker + GPU renderer)
export { SGEGraphCanvas } from './SGEGraphCanvas';
export type { SGEGraphCanvasProps, SGEGraphCanvasRef } from './SGEGraphCanvas';
export { useSGEGraph } from './useSGEGraph';
export type { SGEGraphOptions, SGEGraphHandle, SGEGraphStats } from './useSGEGraph';
export { SGEWebGLRenderer } from './sgeWebGLRenderer';
export type { NodeVisual, RendererOptions, CameraState } from './sgeWebGLRenderer';

// Shared view types and helpers
export * from './viewTypes';
export * from './viewHelpers';
