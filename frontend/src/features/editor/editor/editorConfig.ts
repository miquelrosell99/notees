/**
 * Editor configuration — serialization helpers.
 *
 * Split from the legacy BlockEditor.tsx so that BlockEditor only exports React
 * components, enabling Vite Fast Refresh (HMR).  Exporting non-component
 * values from a component file forces full module invalidation, which
 * defeats Fast Refresh and causes stale editor state on hot updates.
 */

import type { ContentAST } from '@/runtime/types';

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
