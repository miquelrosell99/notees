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

// AST ↔ DOM engine
export {
  astToHtml,
  astToHtmlCached,
  domToAST,
  normalizeAST,
  getCursorPosition,
  setCursorPosition,
  getContentLength,
  getCaretX,
  getCaretCoordinates,
  getPlainText,
  findOffsetAtXInFirstLine,
  findOffsetAtXInLastLine,
  isTextOnlyChange,
  detectTrigger,
} from './astDom';

export type {
  ASTRenderContext,
  ResolvedLink,
  LinkStatus,
  TriggerMatch,
} from './astDom';

// AST Markdown conversion
export { convertMarkdownInAST } from './astBuilder';

// AST mutations
export {
  splitAtPosition,
  mergeDocuments,
  insertNodeLink,
  replaceTriggerWithLink,
  removeTriggerText,
  deleteRange,
  insertText,
  toggleMark,
  toggleCode,
  getActiveMarks,
  inlineNodeLength,
  flattenToInlines,
  documentLength,
} from './astMutations';

export type { ASTPosition, MarkType } from './astMutations';

// AST history
export { ASTHistory } from './astHistory';
export type { HistoryEntry } from './astHistory';
