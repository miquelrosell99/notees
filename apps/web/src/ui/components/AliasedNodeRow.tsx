/**
 * AliasedNodeRow — the alias-side pseudo-property row (SCHEMA.md "Node
 * aliases"): ONE row of properties-section chrome over the `aliasedNodeId`
 * wire node field itself, rendered at the top of the properties table when
 * the carrier IS an alias (the field set, document chrome only — inline
 * blocks never get it, and every read filters aliases to pages).
 *
 * The row names the main page (the field's direct target) and is
 * RE-POINTABLE from the alias side: Change opens the pages-only picker and
 * writes the carrier's OWN `aliasedNodeId` (object.update — the applier
 * cycle-checks the would-be chain); Remove clears the field present-null.
 * The page-restriction guard validates a pick before writing (the picker
 * offers pages only; the guard is the enforcement — client convention,
 * exactly like the render contracts).
 *
 * The ADD direction lives on the OTHER side: the main page's title-row
 * AliasesButton writes THE SELECTED node's field (the backward write) —
 * this row never authors a first alias onto an ordinary page.
 */

import { useRef, useState } from "react";

import type { WorkerClient } from "@/core/worker-client.js";
import type { WorkspaceClient } from "@/core/workspace-client.js";

import { rendersWithDocumentChrome } from "@notees/domain";

import { Icon } from "../Icon.js";
import { displayNameFromClient } from "../dateDisplay.js";
import { NodeSelector } from "./pickers/NodeSelector.js";
import { aliasedNodeTargetError } from "./aliasProperty.js";

type AnyClient = WorkspaceClient | WorkerClient;

export function AliasedNodeRow({
  client,
  nodeId,
  onOpenPage,
}: {
  client: AnyClient;
  nodeId: string;
  onOpenPage?: ((pageId: string) => void) | undefined;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const changeButtonRef = useRef<HTMLButtonElement | null>(null);

  const node = client.getNode(nodeId);
  // The page restriction (SCHEMA.md "Node aliases"): every read filters
  // aliases to pages — a non-page carrier (raw-writer bypass) renders no row.
  const mainId =
    node !== undefined && rendersWithDocumentChrome(node) ? (node.aliasedNodeId ?? null) : null;
  if (mainId === null) return null;

  const main = client.getNode(mainId);
  const broken = main === undefined;
  const label = broken ? mainId : (displayNameFromClient(client, mainId) ?? mainId);

  /** Re-point the alias: the carrier's OWN field, cycle-checked at the applier. */
  const repoint = async (pickedId: string): Promise<void> => {
    const targetError = aliasedNodeTargetError(client, pickedId);
    if (targetError !== null) {
      setError(targetError);
      return;
    }
    await client.updateObject(nodeId, { aliasedNodeId: pickedId });
    setPickerOpen(false);
    setError(null);
  };

  const clear = async (): Promise<void> => {
    await client.updateObject(nodeId, { aliasedNodeId: null });
    setError(null);
  };

  return (
    <li className="nt-property nt-property-object node-metadata-row nt-aliased-node-row">
      <span className="section-label nt-property-name">Aliased node</span>
      <span className="nt-property-chips node-metadata-pills">
        <span
          className={`pill pill--hover-reveal-right${broken ? " pill--broken" : ""}`}
          title={broken ? `Broken reference: ${mainId}` : undefined}
        >
          {!broken && main.icon !== null && (
            <span className="pill__left-icon">
              <Icon path={main.icon} size={0.7} />
            </span>
          )}
          {broken ? (
            <span className="pill__text nt-chip-label nt-chip-label--broken">
              <code>{mainId}</code>
            </span>
          ) : (
            <button
              type="button"
              className="pill__text nt-chip-label"
              title="Open the main page"
              onClick={() => onOpenPage?.(mainId)}
            >
              {label}
            </button>
          )}
          <button
            ref={changeButtonRef}
            type="button"
            className="pill__right-button nt-chip-change"
            aria-label={`Change aliased node (currently ${label})`}
            aria-expanded={pickerOpen}
            title="Change"
            onClick={() => setPickerOpen((open) => !open)}
          >
            ✎
          </button>
          <button
            type="button"
            className="pill__right-button nt-chip-remove"
            aria-label={`Remove alias target ${label}`}
            title="Clear"
            onClick={() => void clear()}
          >
            ×
          </button>
        </span>
      </span>
      {pickerOpen && (
        <NodeSelector
          client={client}
          searchMode="pages"
          excludeNodeId={nodeId}
          canAdd={(candidate) => candidate.aliasedNodeId === null}
          anchorEl={changeButtonRef.current}
          onClose={() => setPickerOpen(false)}
          searchPlaceholder="Search Aliased node"
          onAdd={(picked) => void repoint(picked.id)}
        />
      )}
      {error !== null && (
        <p role="alert" className="nt-picker-error">
          {error}
        </p>
      )}
    </li>
  );
}
