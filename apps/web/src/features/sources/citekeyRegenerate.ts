/**
 * The citekey regeneration behind the metadata panel's trailing regenerate
 * affordance (the citekey row of source-lineage nodes): renders the
 * workspace pattern from the node's CURRENT metadata through the shipped
 * read contract (`citekeyEntryOf` — the same entry the Sources hub rows
 * derive), collision-suffixed against the live library the way quick-create
 * disambiguates (deterministic a/b/c, case-insensitive) MINUS the node's own
 * current citekey, so a re-click with unchanged metadata rewrites the same
 * value instead of suffixing itself. An empty render — no authors/family,
 * no title, no date — is not an error: the value reads "" and the affordance
 * disables (nothing to generate from). Pure read + composition; the WRITE
 * rides the row's existing `property.set` path (no new op, undo-journal
 * eligible).
 */

import { SYSTEM_PROPERTY_UUIDS } from "@notees/domain";

import type { ClientNode } from "@/core/workspace-client/index.js";

import type { AnyClient } from "../collection/types.js";
import {
  existingCitekeys,
  generateCitekey,
  readSourceSettings,
} from "../modals/quickCreate.js";
import { citekeyEntryOf } from "./sourcesQuery.js";

/** The regeneration snapshot the row's trailing affordance renders from. */
export interface CitekeyRegeneration {
  /**
   * The generated value; "" when the metadata renders empty (no
   * authors/family, no title, no date) — the button disables.
   */
  value: string;
}

export function citekeyRegenerationFor(
  client: AnyClient,
  node: ClientNode,
): CitekeyRegeneration {
  const entry = citekeyEntryOf(client, node);
  // The collision scan covers the SIBLING sources: the node's own current
  // citekeys stay out, so regenerating over unchanged metadata is a
  // no-op write of the same value, not a self-suffixing.
  const own = new Set<string>();
  for (const row of client.getEffectiveProperties(node.id)) {
    if (row.propertySchemaId !== SYSTEM_PROPERTY_UUIDS.citekey) continue;
    if (typeof row.value === "string" && row.value.trim() !== "") {
      own.add(row.value.trim().toLowerCase());
    }
  }
  const siblings = existingCitekeys(client).filter((key) => !own.has(key.toLowerCase()));
  const settings = readSourceSettings(client);
  return { value: generateCitekey(settings.citekeyPattern, entry, siblings) };
}
