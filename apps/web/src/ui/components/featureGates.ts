/**
 * Feature chrome gates (§34.35/§34.55) — the READ gating every family-flavored
 * surface composes: a class's chrome shows only when its own family AND every
 * managed ancestor's family are enabled (gatingFeaturesForClass over
 * SYSTEM_CLASS_EXTENDS — disabling EVENT hides meeting and birthday chrome
 * with it; disabling MEETINGS alone hides meeting chrome only). All reads are
 * live: an absent workspace_feature row means enabled (F2), so this is a pure
 * client read — no caching, no writes.
 */

import { gatingFeaturesForClass, SYSTEM_CLASS_UUIDS } from "@notees/domain";
import type { SystemClassName } from "@notees/domain";

import type { AnyClient } from "./Sidebar.js";

/** Reverse-lookup a seeded system class id; null for user classes/unknown ids. */
export function systemClassNameForId(classId: string): SystemClassName | null {
  for (const [name, id] of Object.entries(SYSTEM_CLASS_UUIDS)) {
    if (id === classId) return name as SystemClassName;
  }
  return null;
}

/**
 * True when every family gate for `classId` is enabled. Non-system classes
 * (user classes, the always-on base vocabulary) gate on nothing → true.
 */
export function isClassFamilyEnabled(
  client: Pick<AnyClient, "isFeatureEnabled">,
  classId: string,
): boolean {
  const name = systemClassNameForId(classId);
  if (name === null) return true;
  return gatingFeaturesForClass(name).every((feature) => client.isFeatureEnabled(feature));
}
