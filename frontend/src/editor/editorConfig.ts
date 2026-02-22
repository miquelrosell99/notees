/**
 * Editor configuration — node registry and serialization helpers.
 *
 * Split from BlockEditor.tsx so that BlockEditor only exports React
 * components, enabling Vite Fast Refresh (HMR).  Exporting non-component
 * values from a component file forces full module invalidation, which
 * breaks Lexical's node-type registry and causes
 * "Type inline-link … does not match registered node" errors.
 */

import { BlockNode } from './nodes/BlockNode';
import { InlineLinkNode } from './nodes/InlineLinkNode';
import { BlockHeadingNode } from './nodes/BlockHeadingNode';
import { BlockCodeNode } from './nodes/BlockCodeNode';
import { BlockTableCellNode } from './nodes/BlockTableCellNode';
import type { ContentAST } from '../runtime/types';

// ─── Lexical node registry (shared between List and Card editors) ─

export const EDITOR_NODES = [
  BlockNode,
  InlineLinkNode,
  BlockHeadingNode,
  BlockCodeNode,
  BlockTableCellNode,
];

/**
 * Serialize a ContentAST to a JSON string suitable for API persistence.
 *
 * The `name` column in the database stores the full AST as JSON —
 * NOT plain text — so we must preserve every formatting mark,
 * node-link, and structural node.
 */
export function serializeContentAST(contentAST: ContentAST): string {
  return JSON.stringify(contentAST);
}
