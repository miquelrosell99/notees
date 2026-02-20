/**
 * Core library — builder helpers and stringification.
 *
 * The old AST DOM, mutations, and history modules have been removed.
 * Content editing is now handled by Lexical via BlockEditor.
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
  ASTCode,
  ASTNodeLink,
  ASTStrong,
  ASTEm,
  ASTStrikethrough,
  ASTHighlight,
  ASTUnderline,
  ASTExternalLink,
  ASTParagraph,
  ASTHeading,
  ASTWhiteboard,
} from '@/types/ast';

export { isLeafNode, isHeadingBlock, isWhiteboardBlock } from '@/types/ast';

// Builder helpers
export {
  text,
  hardBreak,
  code,
  nodeLink,
  strong,
  em,
  strikethrough,
  highlight,
  underline,
  externalLink,
  paragraph,
  heading,
  whiteboard,
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
