/**
 * Core AST library — the canonical module for AST operations.
 *
 * Import from '@/lib' for:
 *   - AST type definitions
 *   - AST builder helpers
 *   - The canonical stringifyAST function
 */

// Types
export type {
  ASTDocument,
  ASTBlockNode,
  ASTInlineNode,
  ASTText,
  ASTHardBreak,
  ASTNodeLink,
  ASTStrong,
  ASTEm,
  ASTCode,
  ASTStrikethrough,
  ASTHighlight,
  ASTExternalLink,
  ASTParagraph,
} from '@/types/ast';

export { isLeafNode } from '@/types/ast';

// Builder helpers
export {
  text,
  hardBreak,
  nodeLink,
  code,
  strong,
  em,
  strikethrough,
  highlight,
  externalLink,
  paragraph,
  doc,
  inlineDoc,
  fromPlainText,
  parseAST,
} from './astBuilder';

// Stringifier
export {
  stringifyAST,
  StringifyMode,
} from './stringifyAST';

export type {
  StringifyOptions,
  NodeLinkResolver,
  NodeLinkResolution,
} from './stringifyAST';
