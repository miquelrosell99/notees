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

import type { BlockTreeNode } from "@/core/workspace-client.js";

import { displayNameFromClient } from "./dateDisplay.js";
import { InlineTokens } from "./InlineTokens.js";
import { openNodeLinkMenu } from "./components/NodeLinkContextMenu.js";
import { useOutliner } from "./outliner-context.js";

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

/** One read-only row of the embedded subtree, recursive over its children. */
function EmbedBlock({
  tree,
  resolveName,
  renderEmbed,
}: {
  tree: BlockTreeNode;
  resolveName: (nodeId: string) => string | null;
  renderEmbed: (nodeId: string) => ReactNode;
}) {
  return (
    <div className="nt-embed-block">
      <div className="nt-embed-block-content">
        <InlineTokens
          tokens={tree.node.contentAst}
          resolveName={resolveName}
          renderEmbed={renderEmbed}
          onMentionMenu={(info) => openNodeLinkMenu({ blockId: tree.node.id, ...info })}
        />
      </div>
      {tree.children.length > 0 && (
        <div className="nt-embed-block-children">
          {tree.children.map((child) => (
            <EmbedBlock key={child.node.id} tree={child} resolveName={resolveName} renderEmbed={renderEmbed} />
          ))}
        </div>
      )}
    </div>
  );
}

export function EmbedView({ nodeId }: { nodeId: string }) {
  const { client } = useOutliner();
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
  const renderEmbed = (id: string) => <EmbedView nodeId={id} />;
  const name = displayNameFromClient(client, nodeId) ?? nodeId;
  const childrenTree = client.getBlockTree(nodeId);

  return (
    <EmbedContext.Provider value={{ visited: new Set(visited).add(nodeId), depth: depth + 1 }}>
      <div className="nt-embed">
        <div className="nt-embed-header">{name}</div>
        {node.contentAst.length > 0 && (
          <div className="nt-embed-content">
            <InlineTokens
              tokens={node.contentAst}
              resolveName={resolveName}
              renderEmbed={renderEmbed}
              onMentionMenu={(info) => openNodeLinkMenu({ blockId: node.id, ...info })}
            />
          </div>
        )}
        {childrenTree.length > 0 && (
          <div className="nt-embed-children">
            {childrenTree.map((child) => (
              <EmbedBlock key={child.node.id} tree={child} resolveName={resolveName} renderEmbed={renderEmbed} />
            ))}
          </div>
        )}
      </div>
    </EmbedContext.Provider>
  );
}
