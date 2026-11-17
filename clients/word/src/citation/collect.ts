import type { ScannedField } from "./ooxml";

/**
 * Node ids referenced by all notees citation fields in the document, in
 * document order of first appearance, deduplicated. Bibliography fields and
 * foreign (non-notees) fields contribute nothing; citation embeds with an
 * empty `nodeIds` are skipped. Pure — shared by the Word adapter and any
 * other consumer that needs "which nodes does this document cite".
 */
export function collectCitationNodeIds(fields: ScannedField[]): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const field of fields) {
    if (field.kind !== "citation" || !field.embed) continue;
    if (!("nodeIds" in field.embed)) continue;
    for (const id of field.embed.nodeIds) {
      if (seen.has(id)) continue;
      seen.add(id);
      ordered.push(id);
    }
  }
  return ordered;
}
