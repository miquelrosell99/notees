/**
 * Block Components Index
 * 
 * Contains NodeInline (lightweight node display) and surviving components.
 * BlockEditor (Lexical-based) replaces the old Block component for editing.
 */

// NodeInline - lightweight node display (replaces BlockPreview)
export { NodeInline } from './NodeInline';
export type { NodeInlineProps } from './NodeInline';

// Bullet component (shared, domain-agnostic)
export { Bullet } from './Bullet';
export type { BulletProps, BulletSize, BulletVariant } from './Bullet';

// Text property block (uses BlockEditor)


// Embed block (node portal with dashed-border card)
export { EmbedBlock } from './EmbedBlock';
export type { EmbedBlockProps } from './EmbedBlock';
