/**
 * Core library — builder helpers and stringification.
 *
 * The old AST DOM, mutations, and history modules have been removed.
 * Content editing is now handled by Lexical via NoteesEditor.
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
  ASTUnderline,
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
  underline,
  externalLink,
  paragraph,
  doc,
  inlineDoc,
  parseAST,
  ParseMode,
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

// AST Markdown conversion
export { convertMarkdownInAST } from './astBuilder';
