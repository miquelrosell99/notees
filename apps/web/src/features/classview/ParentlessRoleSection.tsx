/**
 * ParentlessRoleSection — the class page's standalone-role control (owner
 * 2026-10-24): where the class's PARENTLESS members live. "Page" (the
 * default) = document chrome — the Pages hub, page pickers, the graph.
 * "Block" = block chrome — the node surfaces through queries, collections,
 * and the search "blocks" scope instead, and drops out of the Pages hub +
 * graph (full Block-role citizenship, SCHEMA.md "Node structure").
 *
 * Extends-aware (law 3): a class under a flagged base INHERITS the demote
 * (one-way; there is no per-level unflag) — the control then shows "Block"
 * with the inheritance called out and the choice disabled: clearing an
 * inherited flag is a silent no-op by construction.
 */

import { useState } from "react";

import type { WorkerClient } from "@/core/worker-client.js";
import type { WorkspaceClient } from "@/core/workspace-client/index.js";

import { SelectionButton } from "../../components/ui/fleet/SelectionButton.js";
import { Section } from "../../ui/Section.js";

import "./ParentlessRoleSection.css";

type AnyClient = WorkspaceClient | WorkerClient;

export function ParentlessRoleSection({
  client,
  classId,
}: {
  client: AnyClient;
  classId: string;
}) {
  const [pending, setPending] = useState(false);
  const node = client.getNode(classId);
  if (node === undefined || !node.isClass) return null;

  // Own flag (the stored row) vs the EFFECTIVE demote (own OR any
  // extends-ancestor's — the one-way demote).
  const ownBlock = node.parentlessRole === "block";
  const inherited = client
    .getClassParents(classId)
    .some((parentId) => client.effectiveClassParentlessBlock(parentId));
  const effectiveBlock = ownBlock || inherited;

  const choose = async (value: string) => {
    const next = value === "block" ? "block" : "page";
    if (next === "page" && inherited) return; // No per-level unflag (law 3).
    if ((next === "block") === effectiveBlock) return;
    setPending(true);
    try {
      await client.updateClassParentlessRole(classId, next);
    } finally {
      setPending(false);
    }
  };

  return (
    <Section
      client={client}
      title="Standalone instances"
      defaultCollapsed={false}
      load={() => ({ role: effectiveBlock ? "block" : "page" })}
      renderResults={() => (
        <div className="nt-parentless-role">
          <SelectionButton
            options={[
              { value: "page", icon: "mdi-file-document-outline", label: "Page" },
              { value: "block", icon: "mdi-format-list-bulleted", label: "Block" },
            ]}
            value={effectiveBlock ? "block" : "page"}
            onChange={(value) => void choose(value)}
            disabled={pending || inherited}
            label="Render as"
          />
          <p className="nt-parentless-role__hint">
            {inherited
              ? "Block, inherited from an extends-parent — the demote cannot be cleared per level."
              : effectiveBlock
                ? "Parentless members render as blocks — found via queries and search, not the Pages hub."
                : "Parentless members render as pages (the default)."}
          </p>
        </div>
      )}
      emptyText=""
      renderWhenEmpty
    />
  );
}
