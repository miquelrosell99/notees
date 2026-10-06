/**
 * EmbedView — live transclusion of a node's subtree (SCHEMA.md: embeds render
 * the LIVE SUBTREE — the real child nodes, never a clone). Reads the target
 * and its block children from the local client and re-renders on notify (the
 * same subscription pattern as PageView), so edits anywhere re-project here
 * through the standard notification/op path. Read-only mini-projection for
 * this slice: no editing gestures inside the embed.
 *
 * Cycle guard (a RENDERER obligation per SCHEMA.md): EmbedBoundary seeds a
 * visited set with the page's own id; every EmbedView adds its nodeId before
 * recursing, and an embed whose target is already visited renders a
 * "recursive embed" placeholder instead of recursing. EMBED_MAX_DEPTH is a
 * backstop for runaway chains. A target that no longer exists renders a
 * "broken embed" placeholder with the raw id visible (broken-mention
 * fallback philosophy).
 */

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

import type { WorkerClient } from "@/core/worker-client.js";
import type { BlockTreeNode } from "@/core/workspace-client.js";
import type { WorkspaceClient } from "@/core/workspace-client.js";

import { BlockRow } from "./BlockRow.js";
import { displayNameFromClient } from "./dateDisplay.js";
import { InlineTokens } from "./InlineTokens.js";
import { openNodeLinkMenu } from "./components/NodeLinkContextMenu.js";
import { tableClassIdOf } from "./components/tableFamily.js";
import { useOutliner } from "./outliner-context.js";

type AnyClient = WorkspaceClient | WorkerClient;

/** Backstop for embed chains: nesting deeper than this renders a placeholder. */
export const EMBED_MAX_DEPTH = 5;

interface EmbedFrame {
  visited: ReadonlySet<string>;
  depth: number;
}

const EmbedContext = createContext<EmbedFrame | null>(null);

/**
 * Seeds the cycle-guard frame with the page's own id. PageView wraps the
 * block tree so any embed chain that re-enters the page renders the
 * recursive placeholder instead of looping.
 */
export function EmbedBoundary({ rootId, children }: { rootId: string; children: ReactNode }) {
  return (
    <EmbedContext.Provider value={{ visited: new Set([rootId]), depth: 0 }}>
      {children}
    </EmbedContext.Provider>
  );
}

function EmbedPlaceholder({ label, detail }: { label: string; detail: string }) {
  return (
    <span className="nt-placeholder" title={detail}>
      {label} <code>{detail}</code>
    </span>
  );
}

/**
 * The embed view switcher: Full / Card / Wide write
 * the token's `view` field through the standard content path — one
 * `object.update` replacing the token (absent view = the full transclusion,
 * the grammar's default). Rendered in the embed chrome only when the write
 * context (host block + token index) is known; read-only projections
 * (public shares, plain previews) omit it.
 */
export function EmbedViewSwitcher({
  client,
  hostId,
  tokenIndex,
  view,
}: {
  client: AnyClient;
  hostId: string;
  tokenIndex: number;
  view: "embed" | "small_card" | "wide_card";
}) {
  const setView = (next: "embed" | "small_card" | "wide_card") => {
    const host = client.getNode(hostId);
    if (host === undefined) return;
    const token = host.contentAst[tokenIndex];
    if (typeof token !== "object" || token === null) return;
    const t = token as Record<string, unknown>;
    if (t.type !== "embed_ref") return;
    const replaced = { ...t };
    if (next === "embed") delete replaced.view;
    else replaced.view = next;
    if (JSON.stringify(replaced) === JSON.stringify(token)) return;
    const nextAst = host.contentAst.map((entry, i) => (i === tokenIndex ? (replaced as typeof entry) : entry));
    void client.updateObject(hostId, { contentAst: nextAst });
  };
  const options = [
    { id: "embed" as const, label: "Full" },
    { id: "small_card" as const, label: "Card" },
    { id: "wide_card" as const, label: "Wide" },
  ];
  return (
    <span className="nt-embed-view-switch" role="group" aria-label="Embed view">
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          className={view === option.id ? "nt-embed-view-switch__btn nt-embed-view-switch__btn--active" : "nt-embed-view-switch__btn"}
          aria-pressed={view === option.id}
          onClick={(event) => {
            event.stopPropagation();
            setView(option.id);
          }}
        >
          {option.label}
        </button>
      ))}
    </span>
  );
}

/** One read-only row of the embedded subtree, recursive over its children. */
function EmbedBlock({
  tree,
  client,
  resolveName,
  resolveVerb,
}: {
  tree: BlockTreeNode;
  client: AnyClient;
  resolveName: (nodeId: string) => string | null;
  resolveVerb: (propertySchemaId: string) => string | null;
}) {
  // A table-classed block renders through the BlockRow grid even
  // read-only (the "same BlockRow path" for projections) — the
  // embed's own row renderer would flatten the rows/cells into a plain list.
  if (tree.node.classIds.includes(tableClassIdOf(client))) {
    return <BlockRow tree={tree} client={client} resolveName={resolveName} readOnly />;
  }
  return (
    <div className="nt-embed-block">
      <div className="nt-embed-block-content">
        <InlineTokens
          tokens={tree.node.contentAst}
          resolveName={resolveName}
          resolveVerb={resolveVerb}
          renderEmbed={(id, _token, index) => (
            <EmbedView nodeId={id} hostId={tree.node.id} tokenIndex={index} />
          )}
          onMentionMenu={(info) => openNodeLinkMenu({ blockId: tree.node.id, ...info })}
        />
      </div>
      {tree.children.length > 0 && (
        <div className="nt-embed-block-children">
          {tree.children.map((child) => (
            <EmbedBlock key={child.node.id} tree={child} client={client} resolveName={resolveName} resolveVerb={resolveVerb} />
          ))}
        </div>
      )}
    </div>
  );
}

export function EmbedView({
  nodeId,
  hostId,
  tokenIndex,
}: {
  nodeId: string;
  /**
   * The block whose contentAst carries this embed's token + the token's
   * index — the write context for the view switcher. Absent in read-only
   * projections (the public share render), which then render no switcher.
   */
  hostId?: string | undefined;
  tokenIndex?: number | undefined;
}) {
  const { client: seamClient } = useOutliner();
  // Every OutlinerContext provider (PageView, ClassView, ReferenceSubtree)
  // builds the value from the full client; the seam type just narrows it.
  // BlockRow's grid branch needs the full type's prop surface.
  const client = seamClient as AnyClient;
  const frame = useContext(EmbedContext);
  const [, setVersion] = useState(0);
  useEffect(() => client.subscribe(() => setVersion((v) => v + 1)), [client]);

  const visited = frame?.visited ?? new Set<string>();
  const depth = frame?.depth ?? 0;

  if (visited.has(nodeId)) {
    return <EmbedPlaceholder label="recursive embed" detail={nodeId} />;
  }
  if (depth >= EMBED_MAX_DEPTH) {
    return <EmbedPlaceholder label="max embed depth" detail={nodeId} />;
  }

  const node = client.getNode(nodeId);
  if (node === undefined) {
    return <EmbedPlaceholder label="broken embed" detail={nodeId} />;
  }

  const resolveName = (id: string) => displayNameFromClient(client, id);
  const resolveVerb = (schemaId: string) =>
    client.listPropertySchemas().find((schema) => schema.id === schemaId)?.name ?? null;
  const name = displayNameFromClient(client, nodeId) ?? nodeId;
  const childrenTree = client.getBlockTree(nodeId);
  const switcher =
    hostId !== undefined && tokenIndex !== undefined ? (
      <EmbedViewSwitcher
        client={client}
        hostId={hostId}
        tokenIndex={tokenIndex}
        view={
          (() => {
            const token = client.getNode(hostId)?.contentAst[tokenIndex];
            const v =
              typeof token === "object" && token !== null
                ? (token as { view?: unknown }).view
                : undefined;
            return v === "small_card" || v === "wide_card" ? v : "embed";
          })()
        }
      />
    ) : null;

  return (
    <EmbedContext.Provider value={{ visited: new Set(visited).add(nodeId), depth: depth + 1 }}>
      <div className="nt-embed">
        <div className="nt-embed-header">
          <span className="nt-embed-header-name">{name}</span>
          {switcher}
        </div>
        {node.contentAst.length > 0 && (
          <div className="nt-embed-content">
            <InlineTokens
              tokens={node.contentAst}
              resolveName={resolveName}
              resolveVerb={resolveVerb}
              renderEmbed={(id, _token, index) => (
                <EmbedView nodeId={id} hostId={nodeId} tokenIndex={index} />
              )}
              onMentionMenu={(info) => openNodeLinkMenu({ blockId: node.id, ...info })}
            />
          </div>
        )}
        {childrenTree.length > 0 && (
          <div className="nt-embed-children">
            {childrenTree.map((child) => (
              <EmbedBlock key={child.node.id} tree={child} client={client} resolveName={resolveName} resolveVerb={resolveVerb} />
            ))}
          </div>
        )}
      </div>
    </EmbedContext.Provider>
  );
}
