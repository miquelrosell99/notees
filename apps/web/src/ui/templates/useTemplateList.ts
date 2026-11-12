/**
 * useTemplateList — the shared template derivation behind the gallery and
 * the `/template` slash popup: the template class's members, active-only,
 * sorted by title (numeric, base) with the id tiebreak, then the folded
 * search filter (foldSearch — both sides fold the same way). Each surface
 * keeps its own highlight/navigation state; this hook is the read +
 * filter half both popups duplicated near-verbatim.
 */

import { useMemo } from "react";

import { SYSTEM_CLASS_UUIDS } from "@notees/domain";

import type { ClientNode } from "@/core/workspace-client/index.js";

import { titleOfNode } from "../dateDisplay.js";
import { foldedIncludes, foldedQueryOf } from "../../features/search-filters/foldSearch.js";
import { useClientVersion } from "../../components/ui/kit/useClientVersion.js";

/** Structural read surface (the outliner seam satisfies it). */
export interface TemplateListClient {
  /** Template-class members — the flat, unfiltered candidate set. */
  getClassMembers(classId: string): ClientNode[];
  subscribe(listener: () => void): () => void;
}

/** Title sort (numeric, base) with the id tiebreak — the shared ordering. */
function compareTemplates(a: ClientNode, b: ClientNode): number {
  const nameA = titleOfNode(a) ?? a.id;
  const nameB = titleOfNode(b) ?? b.id;
  return (
    nameA.localeCompare(nameB, undefined, { numeric: true, sensitivity: "base" }) ||
    a.id.localeCompare(b.id)
  );
}

export interface TemplateList {
  /** The full sorted candidate set (the empty-state message reads it). */
  templates: ClientNode[];
  /** The folded-filtered list the rows render. */
  filtered: ClientNode[];
}

/**
 * The live, filtered template list. `deps` gates the member read beyond the
 * subscription (the slash popup's family-ready flag) — a change re-runs the
 * derivation.
 */
export function useTemplateList(
  client: TemplateListClient,
  query: string,
  deps: readonly unknown[] = [],
): TemplateList {
  const version = useClientVersion(client);
  const templates = useMemo<ClientNode[]>(() => {
    void version;
    return client
      .getClassMembers(SYSTEM_CLASS_UUIDS.template)
      .filter((node) => node.isActive)
      .sort(compareTemplates);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deps gate the member read (the family-ready flag)
  }, [client, version, ...deps]);

  const filtered = useMemo(() => {
    const q = foldedQueryOf(query);
    if (q === "") return templates;
    return templates.filter((node) => foldedIncludes(q, titleOfNode(node) ?? node.id));
  }, [templates, query]);

  return useMemo(() => ({ templates, filtered }), [templates, filtered]);
}
