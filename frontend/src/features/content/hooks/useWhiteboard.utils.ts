/**
 * useWhiteboard utilities — AST parsing helpers
 */

import type { Node } from '@/types/api';
import type { ASTWhiteboard } from '@/types/ast';
import { parseAST } from '@/lib/astBuilder';
import { stringifyAST, StringifyMode } from '@/lib/stringifyAST';
import type { WhiteboardData } from '@/types/whiteboard';
import { DEFAULT_WHITEBOARD_DATA } from '@/types/whiteboard';

export function parseWhiteboardData(node: Node | undefined): WhiteboardData {
  if (!node?.name) return { ...DEFAULT_WHITEBOARD_DATA };

  const ast = parseAST(node.name);
  const wb = ast.find(b => b.type === 'whiteboard') as ASTWhiteboard | undefined;
  if (wb) {
    // Strip legacy per-document fields (grid, background) that are now global.
    const { grid: _grid, background: _bg, ...rest } = wb.data as WhiteboardData & { grid?: unknown; background?: unknown };
    // Ensure groups array exists (backward compatibility)
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
  if (!node?.name) return '';
  const ast = parseAST(node.name);
  const para = ast.find(b => b.type === 'paragraph' || b.type === 'heading');
  if (para) {
    return stringifyAST([para], { mode: StringifyMode.TEXT_ONLY });
  }
  return '';
}
