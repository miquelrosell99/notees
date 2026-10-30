/**
 * NodeLinkContextMenu — right-click menu over an inline node link (mention)
 * in the block editor. Hit-tested by BlockTextEditor (which maps the pointer
 * to the mention token under it); this component only renders the actions:
 *
 * - Open / Open in sidebar — navigate to the link target.
 * - Edit link… — the page-level LinkEditModal: retarget the link and/or set
 *   (or edit) an optional custom label. NODE LINKS ONLY: the
 *   item renders only when the target token is a mention — external links
 *   (markdown spans in text tokens) never offer Edit here (they navigate;
 *   they are authored by the slash "Add URL" command / markdown pasting).
 * - Unlink — replace the link with its visible text (the custom label when
 *   one is set, otherwise the target's current display name). For a class
 *   chip the class membership STAYS — the pill reappears in the classes row
 *   (chips: rendered before the Convert item; mentions: in the removal
 *   group).
 * - Convert to class chip / Convert to link — CLASS TARGETS ONLY: flips the
 *   token between the mention and class_link forms (the inline chip and the
 *   plain link render differently but reference the same class node; the
 *   one-off wording rides across as customLabel ↔ displayText).
 * - Remove — CLASS CHIPS ONLY: unassign the class from the node AND dissolve
 *   every inline class_link to it into plain text (the
 *   removal-dissolution ruling — the applier refuses the unassign while the
 *   content references the class). The journal classes refuse with a toast.
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
import type { ClientNode, WorkspaceClient } from "@/core/workspace-client/index.js";
import type { WorkerClient } from "@/core/worker-client.js";

import { ContextMenu } from "../../components/ui/kit/ContextMenu.js";
import { LinkEditModalHost, useLinkEditModalOpener } from "../../ui/editor-popups/LinkEditModal.js";
import { refuseClassRemoval, removeClassDissolvingLinks } from "../metadata/classRemoval.js";
import { titleOf } from "../../ui/dateDisplay.js";
import { parentlessBlockResolverOf, renderStateLabel } from "../../ui/renderStateLabel.js";

export interface NodeLinkMenuState {
  x: number;
  y: number;
  targetNodeId: string;
}

/**
 * A request to open the node-link menu against a specific link token in
 * a node's content stream (any view mode — read or edit): a mention or a
 * class chip.
 */
export interface NodeLinkMenuRequest extends NodeLinkMenuState {
  /** The node whose contentAst holds the token (page/block/class). */
  blockId: string;
  /** Index of the token inside contentAst. */
  tokenIndex: number;
  /** The link's one-off wording, when set (a mention's customLabel, a
   *  chip's displayText). */
  customLabel?: string | undefined;
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

/** Read the link token at `tokenIndex` — a mention or a class chip. */
function linkTokenAt(
  client: NodeLinkMenuHostProps["client"],
  request: NodeLinkMenuRequest,
):
  | { kind: "mention"; targetNodeId: string; customLabel?: string; isEmbedded?: boolean }
  | { kind: "class_link"; classId: string; displayText?: string }
  | null {
  const node = client.getNode(request.blockId);
  const token = node?.contentAst[request.tokenIndex];
  if (typeof token !== "object" || token === null) return null;
  const t = token as Record<string, unknown>;
  if (t.type === "mention" && typeof t.targetNodeId === "string") {
    return {
      kind: "mention",
      targetNodeId: t.targetNodeId,
      ...(typeof t.customLabel === "string" ? { customLabel: t.customLabel } : {}),
      ...(t.isEmbedded === true ? { isEmbedded: true } : {}),
    };
  }
  if (t.type === "class_link" && typeof t.classId === "string") {
    return {
      kind: "class_link",
      classId: t.classId,
      ...(typeof t.displayText === "string" ? { displayText: t.displayText } : {}),
    };
  }
  return null;
}

/** Read the mention token at `tokenIndex`, validating its type. */
function mentionTokenAt(
  client: NodeLinkMenuHostProps["client"],
  request: NodeLinkMenuRequest,
): { targetNodeId: string; customLabel?: string; isEmbedded?: boolean } | null {
  const token = linkTokenAt(client, request);
  if (token === null || token.kind !== "mention") return null;
  const { targetNodeId, customLabel, isEmbedded } = token;
  return { targetNodeId, ...(customLabel !== undefined ? { customLabel } : {}), ...(isEmbedded !== undefined ? { isEmbedded } : {}) };
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

  /** The visible text a link keeps when unlinked: the one-off wording when
   *  set, else the target's current name (mention title / class display
   *  name). */
  const linkKeptText = (token: NonNullable<ReturnType<typeof linkTokenAt>>): string => {
    if (token.kind === "mention") {
      return token.customLabel ?? titleOf(client, token.targetNodeId, { budget: "full" }) ?? "";
    }
    return token.displayText ?? titleOf(client, token.classId, { budget: "full" }) ?? "";
  };

  /** The class-targeted conversion, when the menu's token and target allow
   *  it: a mention of a class node becomes a class chip, a class chip
   *  becomes a mention — same target, one-off wording carried across. */
  const convertAction = ():
    | { label: "Convert to class chip" | "Convert to link"; run(): void }
    | null => {
    if (request === null) return null;
    const token = linkTokenAt(client, request);
    if (token === null) return null;
    if (token.kind === "mention") {
      if (client.getNode(token.targetNodeId)?.isClass !== true) return null;
      return {
        label: "Convert to class chip",
        run: () => {
          const node = client.getNode(request.blockId);
          if (node === undefined) return;
          const next = node.contentAst.slice();
          next[request.tokenIndex] = {
            type: "class_link",
            classId: token.targetNodeId,
            ...(token.customLabel !== undefined ? { displayText: token.customLabel } : {}),
          };
          rewrite(next);
          close();
        },
      };
    }
    if (client.getNode(token.classId)?.isClass !== true) return null;
    return {
      label: "Convert to link",
      run: () => {
        const node = client.getNode(request.blockId);
        if (node === undefined) return;
        const next = node.contentAst.slice();
        next[request.tokenIndex] = {
          type: "mention",
          targetNodeId: token.classId,
          ...(token.displayText !== undefined ? { customLabel: token.displayText } : {}),
        };
        rewrite(next);
        close();
      },
    };
  };

  const convert = convertAction();
  const menuToken = request === null ? null : linkTokenAt(client, request);
  const kind = menuToken?.kind === "class_link" ? ("chip" as const) : ("mention" as const);

  return (
    <>
      {children}
      {request !== null && (
        <NodeLinkContextMenu
          state={request}
          client={client}
          kind={kind}
          onClose={close}
          onOpen={(id) => {
            close();
            openNode(id);
          }}
          onOpenInSidebar={(id) => {
            close();
            openInSidebar(id);
          }}
          onConvert={convert === null ? undefined : convert.run}
          convertLabel={convert?.label}
          // Edit is a NODE-link action: offered only when the
          // target token is still a mention. External links navigate — they
          // are never edited (Unlink/Remove/Delete stay available).
          onEdit={
            mentionTokenAt(client, request) === null
              ? undefined
              : () => {
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
                    initialLabel: token.customLabel ?? "",
                    initialEmbedded: token.isEmbedded === true,
                  });
                }
          }
          onUnlink={() => {
            const node = client.getNode(request.blockId);
            const token = linkTokenAt(client, request);
            if (node === undefined || token === null) {
              close();
              return;
            }
            // The prose projection must resolve link labels exactly like
            // the renderer (customLabel/displayText ?? the target's current
            // full title) — without the resolvers a label-less link spans
            // zero prose and the splice lands beside it instead of on it.
            const resolveMentionName = (id: string) => titleOf(client, id, { budget: "full" });
            const resolveClassName = (id: string) => titleOf(client, id, { budget: "full" }) ?? "";
            // Unlink: replace the link with its visible text (the custom
            // label when one is set, else the target's current display name)
            // via the capture splice, so boundary runs trim and adjacent text
            // merges exactly like edit mode.
            const kept = linkKeptText(token);
            const span = proseSpans(node.contentAst, resolveClassName, resolveMentionName).find(
              (s) => s.tokenIndex === request.tokenIndex,
            );
            if (span === undefined) {
              close();
              return;
            }
            if (kept === "") {
              // A broken target with no label leaves nothing to keep — drop
              // the link wholesale (same outcome as Delete link).
              rewrite(spliceTokens(node.contentAst, span.start, span.end, [], resolveClassName, resolveMentionName));
              close();
              return;
            }
            rewrite(
              spliceTokens(node.contentAst, span.start, span.end, [
                { type: "text", text: kept },
              ], resolveClassName, resolveMentionName),
            );
          }}
          // CLASS CHIPS ONLY — the full removal: unassign the class AND
          // dissolve every inline class_link to it (the removal-dissolution
          // ruling). The journal classes refuse with a toast, menu stays.
          onRemoveClass={
            menuToken !== null && menuToken.kind === "class_link"
              ? () => {
                  if (refuseClassRemoval(menuToken.classId)) return;
                  close();
                  void removeClassDissolvingLinks(client, request.blockId, menuToken.classId);
                }
              : undefined
          }
          onDelete={() => {
            const node = client.getNode(request.blockId);
            if (node === undefined) {
              close();
              return;
            }
            const resolveMentionName = (id: string) => titleOf(client, id, { budget: "full" });
            const resolveClassName = (id: string) => titleOf(client, id, { budget: "full" }) ?? "";
            const span = proseSpans(node.contentAst, resolveClassName, resolveMentionName).find(
              (s) => s.tokenIndex === request.tokenIndex,
            );
            if (span === undefined) {
              close();
              return;
            }
            rewrite(spliceTokens(node.contentAst, span.start, span.end, [], resolveClassName, resolveMentionName));
          }}
        />
      )}
    </>
  );
}

interface NodeLinkContextMenuProps {
  state: NodeLinkMenuState;
  /** Resolves the target node (label + kind for the "Open" item). */
  client: {
    getNode(id: string): ClientNode | undefined;
    effectiveClassParentlessBlock(classId: string): boolean;
  };
  /** The token the menu stands on — drives Unlink/Remove placement. */
  kind: "mention" | "chip";
  onClose(): void;
  onOpen(nodeId: string): void;
  onOpenInSidebar(nodeId: string): void;
  /** NODE links only — absent for external-link targets. */
  onEdit?: (() => void) | undefined;
  /** CLASS targets only — flips the token between mention and class chip. */
  onConvert?: (() => void) | undefined;
  /** The Convert item's direction label ("Convert to class chip" / "Convert to link"). */
  convertLabel?: string | undefined;
  /** Unlink: replace the link with its visible text (class chips keep the membership). */
  onUnlink(): void;
  /** CLASS CHIPS only — unassign the class and dissolve its inline chips. */
  onRemoveClass?: (() => void) | undefined;
  onDelete(): void;
}

export function NodeLinkContextMenu({
  state,
  client,
  kind,
  onClose,
  onOpen,
  onOpenInSidebar,
  onEdit,
  onConvert,
  convertLabel,
  onUnlink,
  onRemoveClass,
  onDelete,
}: NodeLinkContextMenuProps) {
  const target = client.getNode(state.targetNodeId);
  const openLabel =
    target !== undefined
      ? `Open ${renderStateLabel(target, parentlessBlockResolverOf(client)).toLowerCase()}`
      : "Open";
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
        ...(onEdit !== undefined || onConvert !== undefined || kind === "chip"
          ? [
              { id: "sep-edit", label: "", separator: true } as const,
              ...(onEdit !== undefined
                ? [{ id: "edit", label: "Edit link…", icon: "mdi-pencil", onClick: onEdit } as const]
                : []),
              // The chip's Unlink rides before Convert ("remove from inline"):
              // the chip goes back to plain text, the class membership stays.
              ...(kind === "chip"
                ? [{ id: "unlink", label: "Unlink", icon: "mdi-link-variant-off", onClick: onUnlink } as const]
                : []),
              ...(onConvert !== undefined
                ? [{ id: "convert", label: convertLabel ?? "Convert", icon: "mdi-swap-horizontal", onClick: onConvert } as const]
                : []),
            ]
          : []),
        { id: "sep-remove", label: "", separator: true },
        ...(kind === "mention"
          ? [{ id: "unlink", label: "Unlink", icon: "mdi-link-variant-off", onClick: onUnlink } as const]
          : []),
        ...(onRemoveClass !== undefined
          ? [{
              id: "remove",
              label: "Remove",
              icon: "mdi-close-circle-outline",
              onClick: onRemoveClass,
            } as const]
          : []),
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
