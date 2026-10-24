import { useEffect, useRef, useState } from "react";

import { rendersWithDocumentChrome } from "@notees/domain";

import { labelFromClient } from "../../ui/dateDisplay.js";
import { parentlessBlockResolverOf, parentRenderFacts } from "../../ui/renderStateLabel.js";
import { AddPill } from "../../components/ui/fleet/AddPill.js";
import { NodePill } from "./NodePills.js";
import { AliasNodePicker } from "./AliasNodePicker.js";
import type { AnyClient } from "./shared.js";

/**
 * AliasesRow — the "Aliases:" row at the TOP of the metadata panel (owner
 * 2026-10-09; relocated from the title-row AliasesButton): every live page
 * whose alias-terminal is this node (chains included, via the client's
 * aliasNodesOf read over the `aliased_node_id` column), as a node list —
 * one pill per alias, a "+ Add alias" ghost pill, an × per entry that clears
 * THE ALIAS's own field (the relation's mutations, like ClassesRow).
 *
 * The pills ride the shared NodePill element + AddPill + NodeSelector (the
 * TagsRow composition — NodePills itself stays class-scoped: its picker,
 * color-chain resolution, and removal locks are class semantics). ADD writes
 * THE SELECTED node's `aliasedNodeId` to the ACTIVE node — the backward
 * write, never the active node's own field (the main page holds nothing) —
 * with the page-restriction guard validating the pick (the picker filters
 * out already-aliased nodes and the active node itself). Opening a pill
 * rides the RAW bypass (the retired popup's NAVIGATE contract): the alias's
 * OWN view, from where the "Alias of …" banner jumps back — the resolving
 * open would land on the page already on screen.
 *
 * Pages only: the write guard makes a non-page target unwritable, so a block
 * (BlockRow hosts the same section) renders no row.
 *
 * Empty pages render NO row at all (owner 2026-10-21): the page header's
 * action row carries the "Add aliases" button until the first alias
 * exists — an empty section is redundant chrome. The row appears once
 * ≥1 alias exists (its own "+ Add alias" pill then covers adding more;
 * the header button retires).
 */
export function AliasesRow({
  client,
  nodeId,
  onOpenPage,
  onOpenPageRaw = undefined,
  /** Read-only projection: alias pills render without add/remove. */
  readOnly = false,
}: {
  client: AnyClient;
  nodeId: string;
  onOpenPage?: ((pageId: string) => void) | undefined;
  /** The RAW open — bypasses the alias redirect so the alias's OWN view renders. */
  onOpenPageRaw?: ((pageId: string) => void) | undefined;
  readOnly?: boolean | undefined;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const addButtonRef = useRef<HTMLButtonElement | null>(null);

  // Freshness: the cached aliasNodesOf read converges via the client's
  // change notification — bump a version so the row follows writes (the
  // panel hosts no subscription of its own).
  const [, setVersion] = useState(0);
  useEffect(() => client.subscribe(() => setVersion((v) => v + 1)), [client]);

  const node = client.getNode(nodeId);
  if (
    node === undefined ||
    !rendersWithDocumentChrome(node, parentRenderFacts(client, node), parentlessBlockResolverOf(client))
  )
    return null;

  const aliases = client.aliasNodesOf(nodeId);
  // Hide when empty (owner 2026-10-21) — the header's "Add aliases" action
  // is the entry point until the first alias exists.
  if (aliases.length === 0) return null;

  return (
    <div className="node-metadata-row nt-aliases-row">
      <div className="section-label">Aliases:</div>
      <span className="nt-property-chips node-metadata-pills">
        {aliases.map((alias) => {
          const label = labelFromClient(client, alias.id) ?? "Untitled";
          return (
            <NodePill
              key={alias.id}
              color={client.effectiveNodeColor(alias)}
              icon={alias.icon}
              label={label}
              onOpen={() => (onOpenPageRaw ?? onOpenPage)?.(alias.id)}
              onRemove={readOnly ? undefined : () => void client.updateObject(alias.id, { aliasedNodeId: null })}
              removeLabel={`Remove alias ${label}`}
            />
          );
        })}
        {!readOnly && (
          <span className="nt-class-add-anchor">
            <AddPill
              ref={addButtonRef}
              className={aliases.length > 0 ? "pill--icon-only" : ""}
              label="Add alias"
              aria-expanded={pickerOpen}
              onClick={(element) => {
                addButtonRef.current = element;
                setPickerOpen(true);
              }}
            />
          </span>
        )}
      </span>
      {pickerOpen && (
        <AliasNodePicker
          client={client}
          nodeId={nodeId}
          anchorEl={addButtonRef.current}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </div>
  );
}
