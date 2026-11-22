/**
 * AttributionRows — the metadata panel's "Created / Last edited" pair: the
 * node's derived attribution columns (envelope actorId + timestamp of the
 * first create / the latest accepted mutation) rendered as two read-only
 * rows at the bottom of the Properties sidebar. Actors resolve to a human
 * through the actor registry (GET /api/actors, primed alongside the prefs
 * pull); unclaimed actors (operator writes, legacy devices, offline) fall
 * back to the actorId uuid prefix — the PropertyHistoryModal precedent.
 * Rows whose date AND actor are both absent (pre-attribution rows in an
 * upgraded derived DB) render nothing.
 */

import { actorDisplayName, useActorRegistry } from "../../core/actor-registry.js";
import type { AnyClient } from "./shared.js";

export function AttributionRows({ client, nodeId }: { client: AnyClient; nodeId: string }) {
  const registry = useActorRegistry();
  const node = client.getNode(nodeId);
  if (node === undefined) return null;

  const row = (label: string, iso: string | null, actor: string | null) => {
    if (iso === null && actor === null) return null;
    const date = iso !== null ? new Date(iso) : null;
    return (
      <div className="nt-props-sidebar__prop" key={label}>
        <span className="nt-property-name">{label}</span>
        <span
          className="nt-props-sidebar__value"
          title={date !== null ? date.toLocaleString() : undefined}
        >
          {date !== null ? date.toLocaleString() : "—"}
          {actor !== null && <>{` · ${actorDisplayName(actor, registry)}`}</>}
        </span>
      </div>
    );
  };

  return (
    <>
      {row("Created", node.createdAt, node.createdBy)}
      {row("Last edited", node.updatedAt, node.updatedBy)}
    </>
  );
}
