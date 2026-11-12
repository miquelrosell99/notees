/**
 * mergeSummary — the shared MergePlanSummary display helpers for the merge
 * modals (MergeNodesModal's multi-source merge and MergeDuplicatesModal's
 * cluster merge aggregate the same planner counts).
 *
 * `SUMMARY_LABELS` pairs every summary key with its singular/plural display
 * labels; `summarizeMerge` folds per-source summaries into one count set;
 * `summaryLineOf` renders the "· "-joined line (the generic zero-total text
 * when nothing would move); `mergeErrorMessage` flattens a rejected preview
 * or apply into the error line both modals show.
 */

import type { MergePlanSummary } from "@notees/store";

/** The MergePlanSummary keys with their singular/plural display labels. */
export const SUMMARY_LABELS: readonly (readonly [keyof MergePlanSummary, string, string])[] = [
  ["childrenMoved", "child moved", "children moved"],
  ["classesRemapped", "class remapped", "classes remapped"],
  ["tagsRemapped", "tag remapped", "tags remapped"],
  ["propertiesCopied", "property copied", "properties copied"],
  ["propertiesSkipped", "property skipped", "properties skipped"],
  ["contentLinksRewritten", "content link rewritten", "content links rewritten"],
  ["propertyValuesRewritten", "property value rewritten", "property values rewritten"],
  ["standaloneChildrenRelocated", "block relocated", "blocks relocated"],
  ["aliasesRepointed", "alias repointed", "aliases repointed"],
  ["collectionsRemapped", "collection remapped", "collections remapped"],
  ["fieldsCopied", "field copied", "fields copied"],
];

export function zeroSummary(): MergePlanSummary {
  return {
    childrenMoved: 0,
    classesRemapped: 0,
    tagsRemapped: 0,
    propertiesCopied: 0,
    propertiesSkipped: 0,
    contentLinksRewritten: 0,
    propertyValuesRewritten: 0,
    standaloneChildrenRelocated: 0,
    aliasesRepointed: 0,
    collectionsRemapped: 0,
    fieldsCopied: 0,
  };
}

/** Fold per-source summaries into one aggregated count set. */
export function summarizeMerge(summaries: readonly MergePlanSummary[]): MergePlanSummary {
  const total = zeroSummary();
  for (const one of summaries) {
    for (const [key] of SUMMARY_LABELS) total[key] += one[key];
  }
  return total;
}

/**
 * The "· "-joined preview line for an aggregated summary — which children,
 * classes, properties, and links move or fill empty slots. The zero-total
 * answer is the generic "the sources merge away as-is" text.
 */
export function summaryLineOf(summary: MergePlanSummary): string {
  return (
    SUMMARY_LABELS.filter(([key]) => summary[key] > 0)
      .map(
        ([key, singular, plural]) =>
          `${summary[key]} ${summary[key] === 1 ? singular : plural}`,
      )
      .join(" · ") || "Nothing to move — the sources merge away as-is."
  );
}

/** A rejected preview/apply flattens to the modal's error line. */
export function mergeErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Merge failed. Please try again.";
}
