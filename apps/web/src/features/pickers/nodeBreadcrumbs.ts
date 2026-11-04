/**
 * nodeBreadcrumbs — the shared picker/search result-row breadcrumb helpers
 * (extracted from NodeSelector, whose SearchPage copy admitted it was
 * "verbatim"): the parent-page path, the containing-page path for a block
 * hit, and the class pills.
 *
 * Titles derive from the unified funnel's `titleOf(client, id,
 * { flatten: "chrome" })` — the chrome flatten resolves display templates and
 * flattens markdown links / class chips / mentions to strings, subsuming
 * titleOfNode's plain content flatten (the funnel's empty default reads ""
 * either way, so the `|| "Untitled"` arms are unchanged).
 */

import { titleOf } from "../../ui/dateDisplay.js";
import {
  nearestDocumentChromeAncestor,
  rendersWithDocumentChromeOf,
  type RoleFacts,
} from "../../ui/renderStateLabel.js";

/** The client shape the breadcrumb helpers need: the title funnel's two
 *  mandatory reads plus the role predicates' resolver. The template axis's
 *  reads stay undeclared — full clients carry them at runtime and the funnel
 *  picks them up structurally; narrow picker clients degrade to untemplated
 *  titles (the pre-extraction NodeSelector behavior). */
type BreadcrumbClient = {
  getNode(id: string): (RoleFacts & { id: string }) | undefined;
  getDisplayName(id: string): string | null;
  effectiveClassParentlessBlock(classId: string): boolean;
};

/**
 * Build parent page path (e.g. "Root / Parent /") for a document-chrome
 * node: the chrome ancestors above it, nearest first, capped at 36 chars
 * (the tail survives, the head collapses to ".../").
 */
export function buildParentPath(
  client: BreadcrumbClient,
  node: { parentId?: string | null },
): string {
  if (node.parentId == null) return "";
  const segments: string[] = [];
  let currentId: string | null | undefined = node.parentId;
  let guard = 0;
  while (currentId != null && guard < 64) {
    const parent = client.getNode(currentId);
    if (parent === undefined || !rendersWithDocumentChromeOf(client, parent)) break;
    segments.unshift(titleOf(client, parent.id, { flatten: "chrome" }) || "Untitled");
    currentId = parent.parentId;
    guard += 1;
  }
  if (segments.length === 0) return "";
  const fullPath = segments.join(" / ") + " /";
  if (fullPath.length <= 36) return fullPath;
  const parts = [...segments];
  while (parts.length > 1) {
    parts.shift();
    const candidate = ".../ " + parts.join(" / ") + " /";
    if (candidate.length <= 36) return candidate;
  }
  const last = parts[0]!;
  return ".../ " + (last.length > 26 ? last.slice(0, 23) + "..." : last) + " /";
}

/**
 * Containing-page breadcrumb for a block hit: the nearest document-chrome
 * ancestor's path plus the page itself — the label that tells a "…" block
 * result apart from same-named pages. Empty string when no chrome ancestor
 * resolves.
 */
export function buildContainingPagePath(
  client: BreadcrumbClient,
  node: { parentId?: string | null },
): string {
  const page = nearestDocumentChromeAncestor(client, node);
  if (page === undefined) return "";
  const ancestors = buildParentPath(client, page);
  const name = titleOf(client, page.id, { flatten: "chrome" }) || "Untitled";
  return ancestors !== "" ? `${ancestors} ${name}` : name;
}

/** The node's display classes as small pills (nameless or vanished classes drop out). */
export function getDisplayClasses(
  client: BreadcrumbClient,
  node: { classIds: readonly string[] },
): Array<{ nodeUuid: string; name: string }> {
  if (node.classIds.length === 0) return [];
  return node.classIds
    .map((classUuid) => {
      const name = titleOf(client, classUuid, { flatten: "chrome" });
      if (!name) return null;
      return { nodeUuid: classUuid, name };
    })
    .filter((c): c is { nodeUuid: string; name: string } => c !== null);
}
