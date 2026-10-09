import { useState } from "react";

import type { WorkerClient } from "@/core/worker-client.js";
import type { WorkspaceClient } from "@/core/workspace-client.js";
import { aliasedNodeTargetError } from "./aliasProperty.js";
import { NodeSelector } from "./pickers/NodeSelector.js";

type AnyClient = WorkspaceClient | WorkerClient;

/**
 * AliasNodePicker — the shared node-alias picker popup: a pages-only
 * NodeSelector anchored at the caller's trigger, guard-validated, writing THE
 * BACKWARD write (the picked node's `aliasedNodeId` becomes the main page —
 * never the active node's own field). The picker filters out nodes that
 * already alias something and the main itself; a guard rejection surfaces an
 * inline error and stays open. Used by the metadata panel's AliasesRow and
 * the page header's action row (the Capacities precedent) — one pick flow,
 * no logic drift between the two surfaces.
 */
export function AliasNodePicker({
  client,
  nodeId,
  anchorEl,
  onClose,
}: {
  client: AnyClient;
  /** The main page the picked node will alias. */
  nodeId: string;
  anchorEl: HTMLElement | null;
  onClose: () => void;
}) {
  const [error, setError] = useState<string | null>(null);

  const addAlias = async (pickedId: string): Promise<void> => {
    const targetError = aliasedNodeTargetError(client, pickedId);
    if (targetError !== null) {
      setError(targetError);
      return;
    }
    await client.updateObject(pickedId, { aliasedNodeId: nodeId });
    onClose();
  };

  return (
    <>
      <NodeSelector
        client={client}
        searchMode="pages"
        excludeNodeId={nodeId}
        canAdd={(candidate) => candidate.aliasedNodeId === null}
        anchorEl={anchorEl}
        onClose={onClose}
        searchPlaceholder="Search pages…"
        onAdd={(picked) => void addAlias(picked.id)}
      />
      {error !== null && (
        <p role="alert" className="nt-picker-error">
          {error}
        </p>
      )}
    </>
  );
}
