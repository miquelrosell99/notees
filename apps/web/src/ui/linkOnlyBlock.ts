/**
 * Link-only block detection — the Revision-12 link-based display
 * transformation (SCHEMA.md "Node structure"): a block whose ENTIRE content
 * is a single link/mention to another node presents that node in its place
 * (the web editor renders the referenced node's content inline in place,
 * transclusion-style, regardless of the referenced node's structural role).
 * A block that mixes a link with other content keeps the ordinary mention
 * chip; a block without a link renders normally.
 */

import type { ContentAst } from "@notees/protocol";

/**
 * The referenced node id when the stream is exactly one mention token,
 * null otherwise. The strict single-token shape is the normative trigger —
 * "the link is the sole content of its containing block".
 */
export function linkOnlyMentionTarget(contentAst: ContentAst): string | null {
  if (contentAst.length !== 1) return null;
  const token = contentAst[0]!;
  if (token.type !== "mention") return null;
  return token.targetNodeId;
}
