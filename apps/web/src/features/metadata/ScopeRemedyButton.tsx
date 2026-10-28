/**
 * ScopeRemedyButton — the guided scope remedy (owner-approved Tier 3,
 * 2026-10-26): rendered at the scope-rejection surfaces (the add-property
 * picker's ineligible matches, the effective read's eligible:false rows,
 * the property-write failure line). For every scope class the node's class
 * closure misses, one offer — "Let <class> extend <scope class>?" — opens a
 * ConfirmationModal stating the consequence (the class AND all its members
 * become eligible for the scope class's properties) and, on confirm,
 * submits class.setExtends with the UNION of the class's current parents
 * and the scope class (existing parents are never silently dropped). Once
 * the edge lands, the schema is eligible and the offer renders nothing.
 *
 * Fleet-only composition (Button + ConfirmationModal) with co-located
 * token-only CSS; the client subscription follows the established metadata
 * pattern so the offer re-derives as soon as the op applies.
 */

import { useEffect, useState } from "react";

import type { ClientPropertySchema } from "@/core/workspace-client/index.js";

import { Button } from "../../components/ui/kit/Button.js";
import { ConfirmationModal } from "../../components/ui/kit/ConfirmationModal.js";
import { missingScopeClasses, nearestRemedyClass } from "./scopeRemedy.js";
import type { AnyClient } from "./shared.js";
import "./ScopeRemedyButton.css";

export function ScopeRemedyButton({
  client,
  nodeId,
  schema,
}: {
  client: AnyClient;
  nodeId: string;
  schema: Pick<ClientPropertySchema, "scopeClassIds">;
}) {
  const [, setVersion] = useState(0);
  useEffect(() => client.subscribe(() => setVersion((v) => v + 1)), [client]);
  const [confirmFor, setConfirmFor] = useState<string | null>(null);

  const node = client.getNode(nodeId);
  if (node === undefined) return null;
  const remedyClassId = nearestRemedyClass(client, node.classIds);
  // A classless node has no extends receiver — the offer is class-only.
  if (remedyClassId === null) return null;
  const missing = missingScopeClasses(client, node.classIds, schema);
  if (missing.length === 0) return null;

  const remedyName = client.getDisplayName(remedyClassId) ?? remedyClassId;

  const apply = async (scopeClassId: string): Promise<void> => {
    // UNION — replace semantics ride the full parent set: the current
    // parents plus the missing scope class, never dropping an existing edge.
    const parentClassIds = [...new Set([...client.getClassParents(remedyClassId), scopeClassId])];
    await client.setClassExtends(remedyClassId, parentClassIds);
    setConfirmFor(null);
  };

  return (
    <div className="nt-scope-remedy">
      {missing.map((scopeClassId) => {
        const scopeName = client.getDisplayName(scopeClassId) ?? scopeClassId;
        return (
          <div className="nt-scope-remedy__offer" key={scopeClassId}>
            <Button size="xs" variant="outline" onClick={() => setConfirmFor(scopeClassId)}>
              Let {remedyName} extend {scopeName}?
            </Button>
            {confirmFor === scopeClassId && (
              <ConfirmationModal
                isOpen
                title={`Let ${remedyName} extend ${scopeName}?`}
                message={`${remedyName} and all its members become eligible for ${scopeName}-scoped properties.`}
                secondaryMessage="Existing extends parents are kept — the new edge joins them."
                confirmLabel="Extend"
                onConfirm={() => apply(scopeClassId)}
                onCancel={() => setConfirmFor(null)}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
