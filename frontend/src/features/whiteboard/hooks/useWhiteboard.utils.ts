/**
 * useWhiteboard utilities — AST parsing helpers
 */

import type { Node } from '@/types/api';
import type { ASTWhiteboard } from '@/types/ast';
import { parseAST } from '@/lib/astBuilder';
import { stringifyAST, StringifyMode } from '@/lib/stringifyAST';
import type { WhiteboardData } from '@/features/whiteboard/types/whiteboard';
import { DEFAULT_WHITEBOARD_DATA } from '@/features/whiteboard/types/whiteboard';

export function parseWhiteboardData(node: Node | undefined): WhiteboardData {
  if (!node?.content) return { ...DEFAULT_WHITEBOARD_DATA };

  const ast = parseAST(node.content);
  const wb = ast.find(b => b.type === 'whiteboard') as ASTWhiteboard | undefined;
  if (wb) {
    // Strip legacy per-document fields (grid, background) that are now global.
    const { grid: _grid, background: _bg, ...rest } = wb.data as WhiteboardData & { grid?: unknown; background?: unknown };
    return { ...rest, groups: (rest as WhiteboardData).groups || [] } as WhiteboardData;
  }

  return { ...DEFAULT_WHITEBOARD_DATA };
}

/**
 * Extract the title from a whiteboard node's AST.
 *
 * The title is the first paragraph/heading block (children approach).
 */
export function parseWhiteboardTitle(node: Node | undefined): string {
  if (!node?.content) return '';
  const ast = parseAST(node.content);
  const para = ast.find(b => b.type === 'paragraph' || b.type === 'heading');
  if (para) {
    return stringifyAST([para], { mode: StringifyMode.TEXT_ONLY });
  }
  return '';
}
