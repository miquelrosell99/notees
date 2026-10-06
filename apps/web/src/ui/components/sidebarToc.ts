/**
 * Sidebar TOC derivation — the table of contents
 * is tree-derived, never token-derived: the content grammar has no heading
 * token (SCHEMA.md:55-68), so structure comes from the block tree itself.
 *
 * Entries, in true child order:
 *   - every main child (the render bit set — the Pages zone) is an entry;
 *     sub-pages ARE the document's sections (the same call as the deck
 *     builder's slide heuristic);
 *   - an inline-body child qualifies as a heading when its content is one
 *     short plain text line (single text token, trimmed length within the
 *     budget, no sentence-final punctuation) — outliner convention: a
 *     top-level one-liner reads as a head;
 *   - one nesting level: a qualifying heading's own qualifying children
 *     indent beneath it.
 *
 * Pure reads (getChildren / getDisplayName) — cheap, never a query, so the
 * rail derives the TOC on every render without touching the lazy-loading
 * contract.
 */

import type { WorkerClient } from "@/core/worker-client.js";
import type { ClientNode, WorkspaceClient } from "@/core/workspace-client.js";

type AnyClient = WorkspaceClient | WorkerClient;

/** Character budget for the heading heuristic (a one-liner, not a sentence). */
export const TOC_HEADING_MAX_CHARS = 72;

export interface TocEntry {
  node: ClientNode;
  /** The heading/page text shown in the rail. */
  label: string;
  /** 0 = top level, 1 = nested under a qualifying heading. */
  depth: 0 | 1;
  /** main child (page) vs. the heading heuristic over inline body blocks. */
  kind: "page" | "heading";
}

/**
 * The heading text when the node's content is one short plain line, else
 * null. Marks don't disqualify (a bolded one-liner is still a head).
 */
export function headingTextOf(node: ClientNode): string | null {
  const ast = node.contentAst;
  if (ast.length !== 1) return null;
  const token = ast[0] as { type?: string; text?: string };
  if (token.type !== "text" || typeof token.text !== "string") return null;
  const text = token.text.trim();
  if (text.length === 0 || text.length > TOC_HEADING_MAX_CHARS) return null;
  if (/[.!?:;,]$/.test(text)) return null;
  return text;
}

function labelOf(client: AnyClient, node: ClientNode, fallback: string | null): string {
  return client.getDisplayName(node.id) ?? fallback ?? "";
}

/** The page's TOC entries (empty = the section hides entirely, owner rule). */
export function tocEntriesOf(client: AnyClient, pageId: string): TocEntry[] {
  const entries: TocEntry[] = [];
  for (const child of client.getChildren(pageId)) {
    if (child.isClass) continue;
    if (child.presentAsMain) {
      entries.push({ node: child, label: labelOf(client, child, null), depth: 0, kind: "page" });
      continue;
    }
    const heading = headingTextOf(child);
    if (heading === null) continue;
    entries.push({ node: child, label: heading, depth: 0, kind: "heading" });
    for (const grandchild of client.getChildren(child.id)) {
      if (grandchild.isClass || grandchild.presentAsMain) continue;
      const nested = headingTextOf(grandchild);
      if (nested !== null) {
        entries.push({ node: grandchild, label: nested, depth: 1, kind: "heading" });
      }
    }
  }
  return entries;
}
