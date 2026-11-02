/**
 * mergeHost — the app-level host for the unified merge modal, mounted once
 * in AppModals with the workspace client. Requests arrive from gestures
 * that live far apart in the tree (the command palette's "Merge nodes…"
 * and "Merge current page into…" rows, the node context menu's
 * "Merge into…"), so the request is a module-level call (requestMerge)
 * this host listens to — the AddSourceHost idiom: listener-based because
 * the host is long-lived (requests arriving before any host mounts queue
 * until one does).
 *
 * A request carries an optional seed source id (the gesture's node — the
 * palette's current page, the context-menu node); the general palette row
 * opens the modal empty. On merge the host closes and navigates to the
 * target through the app's onOpenNode.
 */

import { useEffect, useState } from "react";

import type { AnyClient } from "../../ui/app/clients.js";
import { MergeNodesModal } from "./MergeNodesModal.js";

export interface MergeRequest {
  /** The gesture's node, pre-seeded as the first merge source. */
  sourceId?: string | undefined;
}

type RequestListener = (request: MergeRequest) => void;

const listeners = new Set<RequestListener>();
/** Requests fired before any host mounted (queued until one listens). */
const pending: MergeRequest[] = [];

/** Ask the host to open the merge modal, optionally seeded with a source. */
export function requestMerge(sourceId?: string): void {
  const request: MergeRequest = sourceId !== undefined ? { sourceId } : {};
  if (listeners.size === 0) {
    pending.push(request);
    return;
  }
  for (const listener of listeners) listener(request);
}

export interface MergeHostProps {
  client: AnyClient;
  /** The app's page-open — the post-merge navigation to the target. */
  onOpenNode: (nodeId: string) => void;
}

export function MergeHost({ client, onOpenNode }: MergeHostProps) {
  /** The open request plus a sequence number (the modal remounts per request). */
  const [request, setRequest] = useState<(MergeRequest & { seq: number }) | null>(null);

  useEffect(() => {
    let seq = 0;
    const listener: RequestListener = (next) => setRequest({ ...next, seq: ++seq });
    listeners.add(listener);
    // Drain anything requested before this host mounted.
    while (pending.length > 0) listener(pending.shift()!);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  if (request === null) return null;

  return (
    <MergeNodesModal
      key={request.seq}
      isOpen
      client={client}
      initialSourceIds={request.sourceId !== undefined ? [request.sourceId] : undefined}
      onClose={() => setRequest(null)}
      onMerged={(targetId) => {
        setRequest(null);
        onOpenNode(targetId);
      }}
    />
  );
}
