/**
 * NodeLinkContextMenu — right-click menu over an inline node link (mention)
 * in the block editor. Hit-tested by BlockTextEditor (which maps the pointer
 * to the mention token under it); this component only renders the actions:
 *
 * - Open / Open in sidebar — navigate to the link target.
 * - Edit link… — the page-level LinkEditModal: retarget the link and/or set
 *   (or edit) an optional custom label.
 * - Remove link — unlink but keep the visible text (the custom label when
 *   one is set, otherwise the captured surface text).
 * - Delete link — drop the mention token from the block entirely.
 *
 * Rendered with `companion` so the contentEditable blur handler treats focus
 * into the menu as staying inside the edit session.
 */

import { useEffect, useState, type ReactNode } from "react";

import { spliceTokens } from "@/editor/edit-apply.js";
import { withCandidateSpans } from "@/editor/capture.js";
import { proseSpans } from "@/editor/prose.js";
import type { ContentAst } from "@notees/protocol";
import type { ClientNode, WorkspaceClient } from "@/core/workspace-client.js";
import type { WorkerClient } from "@/core/worker-client.js";

import { ContextMenu } from "./ui/ContextMenu.js";
import { LinkEditModalHost, useLinkEditModalOpener } from "../editor-popups/LinkEditModal.js";
import { renderStateLabel } from "../renderStateLabel.js";

export interface NodeLinkMenuState {
  x: number;
  y: number;
  targetNodeId: string;
}

/**
 * A request to open the node-link menu against a specific mention token in
 * a node's content stream (any view mode — read or edit).
 */
export interface NodeLinkMenuRequest extends NodeLinkMenuState {
  /** The node whose contentAst holds the mention (page/block/class). */
  blockId: string;
  /** Index of the mention token inside contentAst. */
  tokenIndex: number;
  /** The link's custom label, when set. */
  displayText?: string | undefined;
}

// ── Global opener ──────────────────────────────────────────────────────────
// One host serves the whole app: any surface that renders mentions calls
// openNodeLinkMenu(...) without threading props through view layers.

type Opener = (request: NodeLinkMenuRequest) => void;
let activeOpener: Opener | null = null;

/** The single host registers itself here (App-level, under the app shell). */
export function registerNodeLinkMenuOpener(opener: Opener | null): void {
  activeOpener = opener;
}

/** Open the node-link menu for a mention (no-op before the host mounts). */
export function openNodeLinkMenu(request: NodeLinkMenuRequest): void {
  activeOpener?.(request);
}

interface NodeLinkMenuHostProps {
  client: WorkspaceClient | WorkerClient;
  openNode(nodeId: string): void;
  openInSidebar(nodeId: string): void;
  children: ReactNode;
}

/** Read the mention token at `tokenIndex`, validating its type. */
function mentionTokenAt(
  client: NodeLinkMenuHostProps["client"],
  request: NodeLinkMenuRequest,
): { targetNodeId: string; text: string; displayText?: string } | null {
  const node = client.getNode(request.blockId);
  const token = node?.contentAst[request.tokenIndex];
  if (
    typeof token !== "object" ||
    token === null ||
    (token as Record<string, unknown>).type !== "mention"
  ) {
    return null;
  }
  const t = token as Record<string, unknown>;
  return {
    targetNodeId: String(t.targetNodeId),
    text: String(t.text),
    ...(typeof t.displayText === "string" ? { displayText: t.displayText } : {}),
  };
}

/**
 * The page-level host of the node-link context menu — renders the menu for
 * openNodeLinkMenu requests from ANY surface (block trees, embeds,
 * references, query results, whiteboard cards, class descriptions) and
 * performs the edits. "Edit link…" opens the shared LinkEditModal (the host
 * carries its own, nested — safe under any enclosing host).
 */
export function NodeLinkMenuHost(props: NodeLinkMenuHostProps) {
  // The opener context must be consumed BELOW the host's own
  // LinkEditModalHost, so the menu's host renders the inner piece itself.
  return (
    <LinkEditModalHost client={props.client}>
      <NodeLinkMenuInner {...props} />
    </LinkEditModalHost>
  );
}

function NodeLinkMenuInner({ client, openNode, openInSidebar, children }: NodeLinkMenuHostProps) {
  const [request, setRequest] = useState<NodeLinkMenuRequest | null>(null);
  useEffect(() => {
    registerNodeLinkMenuOpener(setRequest);
    return () => registerNodeLinkMenuOpener(null);
  }, []);
  const openLinkEditor = useLinkEditModalOpener();

  const close = () => setRequest(null);

  const rewrite = (tokens: ContentAst | null) => {
    if (request === null || tokens === null) return;
    void client.updateObject(request.blockId, {
      contentAst: withCandidateSpans(tokens),
    });
  };

  return (
    <>
      {children}
      {request !== null && (
        <NodeLinkContextMenu
          state={request}
          client={client}
          onClose={close}
          onOpen={(id) => {
            close();
            openNode(id);
          }}
          onOpenInSidebar={(id) => {
            close();
            openInSidebar(id);
          }}
          onEdit={() => {
            const token = mentionTokenAt(client, request);
            if (token === null) {
              close();
              return;
            }
            close();
            openLinkEditor({
              kind: "node",
              blockId: request.blockId,
              tokenIndex: request.tokenIndex,
              insertAt: null,
              initialNodeId: token.targetNodeId,
              initialLabel: token.displayText ?? "",
            });
          }}
          onRemove={() => {
            const node = client.getNode(request.blockId);
            const token = mentionTokenAt(client, request);
            if (node === undefined || token === null) {
              close();
              return;
            }
            // Unlink: replace the mention with its visible text (the custom
            // label when one is set) via the capture splice, so boundary
            // runs trim and adjacent text merges exactly like edit mode.
            const kept = token.displayText ?? token.text;
            const span = proseSpans(node.contentAst).find(
              (s) => s.tokenIndex === request.tokenIndex,
            );
            if (span === undefined) {
              close();
              return;
            }
            rewrite(
              spliceTokens(node.contentAst, span.start, span.end, [
                { type: "text", text: kept },
              ]),
            );
          }}
          onDelete={() => {
            const node = client.getNode(request.blockId);
            if (node === undefined) {
              close();
              return;
            }
            const span = proseSpans(node.contentAst).find(
              (s) => s.tokenIndex === request.tokenIndex,
            );
            if (span === undefined) {
              close();
              return;
            }
            rewrite(spliceTokens(node.contentAst, span.start, span.end, []));
          }}
        />
      )}
    </>
  );
}

interface NodeLinkContextMenuProps {
  state: NodeLinkMenuState;
  /** Resolves the target node (label + kind for the "Open" item). */
  client: { getNode(id: string): ClientNode | undefined };
  onClose(): void;
  onOpen(nodeId: string): void;
  onOpenInSidebar(nodeId: string): void;
  onEdit(): void;
  onRemove(): void;
  onDelete(): void;
}

export function NodeLinkContextMenu({
  state,
  client,
  onClose,
  onOpen,
  onOpenInSidebar,
  onEdit,
  onRemove,
  onDelete,
}: NodeLinkContextMenuProps) {
  const target = client.getNode(state.targetNodeId);
  const openLabel =
    target !== undefined ? `Open ${renderStateLabel(target).toLowerCase()}` : "Open";
  return (
    <ContextMenu
      companion
      position={{ x: state.x, y: state.y }}
      onClose={onClose}
      items={[
        {
          id: "open",
          label: openLabel,
          icon: "mdi-open-in-app",
          onClick: () => onOpen(state.targetNodeId),
        },
        {
          id: "open-sidebar",
          label: "Open in sidebar",
          icon: "mdi-dock-right",
          onClick: () => onOpenInSidebar(state.targetNodeId),
        },
        { id: "sep-edit", label: "", separator: true },
        { id: "edit", label: "Edit link…", icon: "mdi-pencil", onClick: onEdit },
        { id: "sep-remove", label: "", separator: true },
        { id: "remove", label: "Remove link", icon: "mdi-link-variant-off", onClick: onRemove },
        {
          id: "delete",
          label: "Delete link",
          icon: "mdi-trash-can-outline",
          danger: true,
          onClick: onDelete,
        },
      ]}
    />
  );
}
