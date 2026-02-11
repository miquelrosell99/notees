/**
 * Block Components Index
 * 
 * Contains NodeInline (lightweight node display) and surviving components.
 * NoteesEditor (Lexical-based) replaces the old Block component for editing.
 */

// NodeInline - lightweight node display (replaces BlockPreview)
export { NodeInline } from './NodeInline';
export type { NodeInlineProps } from './NodeInline';

// Bullet component (shared, domain-agnostic)
export { Bullet } from './Bullet';
export type { BulletProps, BulletSize, BulletVariant } from './Bullet';

// Code block display component
export { CodeBlock } from './CodeBlock';
export type { CodeBlockProps } from './CodeBlock';

// Text property block (uses NoteesEditor)
export { TextPropertyBlock } from './TextPropertyBlock';
