/**
 * Link-only block detection — the Revision-12 link-based display
 * transformation (SCHEMA.md "Node structure"), refined by the owner ruling
 * 2026-10-16: a block whose ENTIRE content is a single link/mention presents
 * that node in its place ONLY when the link itself is marked embedded
 * (`isEmbedded: true` on the mention token). Embedding is a MANUAL per-link
 * choice — the default is FALSE, so an unmarked link-only block renders as
 * an ordinary inline link (the chip), never an implicit transclusion. A
 * block that mixes a link with other content always renders normally.
 */

import type { ContentAst } from "@notees/protocol";

/**
 * The referenced node id when the stream is exactly one mention token that
 * IS marked embedded — null otherwise. The strict single-token shape is the
 * normative trigger ("the link is the sole content of its containing
 * block"), and the token flag is the normative gate (manual embedding).
 */
export function linkOnlyMentionTarget(contentAst: ContentAst): string | null {
  if (contentAst.length !== 1) return null;
  const token = contentAst[0]!;
  if (token.type !== "mention") return null;
  if (token.isEmbedded !== true) return null;
  return token.targetNodeId;
}
