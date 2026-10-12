/**
 * Table-of-content derivation — heading-token-derived (owner 2026-10-12):
 * the content grammar gained the block-scale `heading` token (the v1
 * "Convert to heading" marker, restored in the block context menu), and the
 * TOC lists heading blocks ALONE — the old "short one-line plain text"
 * heuristic and the sub-page entries retired (the owner: only blocks marked
 * as headings belong here; a plain one-liner is prose, not structure).
 *
 * Entries, in true child order, nested one level: a top-level heading's
 * subtree headings indent beneath it (intermediate non-heading blocks pass
 * their level through — only heading ancestry indents).
 *
 * Pure reads (getChildren / plainTextExcerpt) — cheap, never a query, so the
 * context column derives the TOC on every render without touching the
 * lazy-loading contract. Empty = the section hides entirely (owner rule).
 */

import { plainTextExcerpt } from "@notees/domain";

import type { WorkerClient } from "@/core/worker-client.js";
import type { ClientNode, WorkspaceClient } from "@/core/workspace-client.js";

type AnyClient = WorkspaceClient | WorkerClient;

/** Cycle-protection depth cap for the recursive walk. */
const TOC_DEPTH_CAP = 16;

export interface TocEntry {
  node: ClientNode;
  /** The heading's flattened text. */
  label: string;
  /** 0 = top level, 1 = nested under a heading. */
  depth: 0 | 1;
}

/** The heading text when the node's content is ONE heading token, else null. */
export function headingLabelOf(node: ClientNode): string | null {
  const ast = node.contentAst;
  if (ast.length !== 1) return null;
  const token = ast[0]!;
  if (token.type !== "heading") return null;
  const label = plainTextExcerpt([token]).trim();
  return label === "" ? null : label;
}

/** The page's TOC entries (empty = the section hides entirely, owner rule). */
export function tocEntriesOf(client: AnyClient, pageId: string): TocEntry[] {
  const entries: TocEntry[] = [];
  const walk = (parentId: string, depth: 0 | 1, remaining: number): void => {
    if (remaining <= 0) return;
    for (const child of client.getChildren(parentId)) {
      if (child.isClass) continue;
      const label = headingLabelOf(child);
      if (label !== null) {
        entries.push({ node: child, label, depth });
        walk(child.id, 1, remaining - 1);
      } else {
        // Non-heading blocks pass their level through — only heading
        // ancestry indents the entries beneath.
        walk(child.id, depth, remaining - 1);
      }
    }
  };
  walk(pageId, 0, TOC_DEPTH_CAP);
  return entries;
}
