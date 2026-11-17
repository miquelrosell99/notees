import type { CitationEmbed } from "./embed";
import type { ScannedField } from "./ooxml";

export interface RefreshPlanEntry {
  /** Position of the field in the scan order — the index WordFieldAccess updates by. */
  fieldIndex: number;
  /** The parsed embed: carries the styleId + locator the field was inserted with. */
  embed: CitationEmbed;
}

/**
 * Pure refresh plan: keep only citation fields whose ADDIN code parses to a
 * well-formed embed. Foreign fields (Zotero, …) and hand-corrupted codes
 * (prefix present, JSON garbage) classify as foreign upstream and are skipped
 * here — never deleted, never re-rendered (skip-not-corrupt contract).
 *
 * v1 renders once per planned field; batching renders by distinct styleId is
 * a recorded optimization, not this task.
 */
/**
 * The fields refresh reports as "skipped (foreign/corrupted)": foreign codes
 * (Zotero, …) and hand-corrupted notees citation codes — both classify as
 * kind "foreign" — plus any citation-kind field whose embed failed to parse.
 * Bibliography fields are healthy non-citations: refresh leaves them alone
 * but they are NOT "skipped citations" and never enter that count.
 */
export function isSkippedField(field: Pick<ScannedField, "kind" | "embed">): boolean {
  if (field.kind === "citation") return field.embed === null || !("nodeIds" in field.embed);
  return field.kind === "foreign";
}

export function planRefresh(fields: ScannedField[]): RefreshPlanEntry[] {
  const plan: RefreshPlanEntry[] = [];
  fields.forEach((field, fieldIndex) => {
    if (field.kind !== "citation" || field.embed === null) return;
    if (!("nodeIds" in field.embed)) return;
    plan.push({ fieldIndex, embed: field.embed });
  });
  return plan;
}
