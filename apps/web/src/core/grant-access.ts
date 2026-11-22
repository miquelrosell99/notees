/**
 * The client-side grant-access state (the per-node-sharing proposal's app
 * gate): the Shares Inbox fetched once per server+credential+workspace,
 * reduced to "is the caller RESTRICTED on this workspace, and which subtrees
 * can she view". The hover gate (NodeHoverPreviewHost) consults it: an
 * out-of-closure mention previews as a "not shared with you" chip instead of
 * loading the node's content.
 *
 * Trusted-circle honesty: this is a UX boundary, not confidentiality — a
 * restricted member holds the workspace key and could read anything with a
 * different client. The integrity boundary is the server's relay write-guard.
 */

import { useSyncExternalStore } from "react";

import { fetchGrantInbox } from "../features/sharing/shareApi.js";

export interface GrantAccessState {
  /** The workspace this state describes (the connected one at prime time). */
  workspaceId: string;
  /** The caller's membership role is "member" (write-guarded) here. */
  restricted: boolean;
  /** Edit-grant roots — the writable closures. */
  editRoots: ReadonlySet<string>;
  /** View roots — edit AND read closures (everything she may open). */
  viewRoots: ReadonlySet<string>;
}

let cache: GrantAccessState | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function snapshot(): GrantAccessState | null {
  return cache;
}

/** React seam: re-renders when a prime lands. Null = no gating (full peer). */
export function useGrantAccess(): GrantAccessState | null {
  return useSyncExternalStore(subscribe, snapshot);
}

/**
 * Fetch the inbox once and reduce it. Rows from OTHER workspaces are
 * ignored — the gate speaks for the connected workspace. Fire-and-forget;
 * until it lands the gate renders nothing special (full-peer behavior).
 */
export function primeGrantAccess(serverUrl: string, credential: string, workspaceId: string): void {
  void (async () => {
    try {
      const { grants } = await fetchGrantInbox(serverUrl, credential);
      const own = grants.filter((grant) => grant.workspaceId === workspaceId);
      if (own.length === 0) {
        cache = { workspaceId, restricted: false, editRoots: new Set(), viewRoots: new Set() };
        emit();
        return;
      }
      const editRoots = new Set(own.filter((g) => g.role === "edit").map((g) => g.nodeId));
      const viewRoots = new Set(own.map((g) => g.nodeId));
      cache = {
        workspaceId,
        // Restricted = the caller's role on THIS workspace is "member"
        // (owner rows mean full peer — no gating).
        restricted: own.every((g) => g.workspaceRole === "member"),
        editRoots,
        viewRoots,
      };
      emit();
    } catch {
      // Unreachable / anonymous: the gate stays off (full-peer rendering).
    }
  })();
}

/**
 * Whether `nodeId` sits inside any of the roots' descendant closures —
 * an ancestor walk over the client's local projection. Undefined nodes
 * (unsynced creates) read as outside unless a root IS the id.
 */
export function withinAccessClosure(
  client: { getNode(id: string): { parentId: string | null } | undefined },
  roots: ReadonlySet<string>,
  nodeId: string,
): boolean {
  let cursor: string | null = nodeId;
  const seen = new Set<string>();
  while (cursor !== null && !seen.has(cursor)) {
    if (roots.has(cursor)) return true;
    seen.add(cursor);
    const row = client.getNode(cursor);
    if (row === undefined) return false;
    cursor = row.parentId;
  }
  return false;
}

/** Test seam: clears the module cache and notifies subscribers. */
export function __resetGrantAccessForTests(): void {
  cache = null;
  emit();
}
