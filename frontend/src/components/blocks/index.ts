/**
 * Block Components Index
 * 
 * Block-related components for editing and displaying blocks.
 */

// Core block components
export { Block } from './Block';
export { BlockEditor, TASK_STATES } from './BlockEditor';
export type { TaskState } from './BlockEditor';
export { CodeBlock } from './CodeBlock';
export type { CodeBlockProps } from './CodeBlock';

// Block preview (deprecated - use Block with capability flags)
export { BlockPreview } from './BlockPreview';
export type { BlockPreviewProps } from './BlockPreview';

// Block callbacks context
export { BlockCallbacksProvider, useBlockCallbacks, useBlockCallbacksRequired } from './BlockCallbacksContext';
export type { BlockCallbacks } from './BlockCallbacksContext';

// Block drag preview
export { BlockDrag } from './BlockDrag';
export type { BlockDragProps } from './BlockDrag';

// Bullet component
export { Bullet } from './Bullet';
export type { BulletProps, BulletSize, BulletVariant } from './Bullet';
export { TextPropertyBlock } from './TextPropertyBlock';
