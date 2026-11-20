/**
 * Title-focus request — the create-first New flow's hand-off: the creator
 * creates the node, opens the page, and asks for the title editor; the page
 * chrome consumes the request once when the title row mounts and auto-enters
 * edit (BlockRow's autoEdit + the editor's mount caret). One-shot: a single
 * request is consumed by the first mount that matches its node id, so a
 * stale request never hijacks a later navigation.
 */

let pending: string | null = null;

/** Ask the page chrome to auto-enter the title editor when `nodeId` mounts. */
export function requestTitleFocus(nodeId: string): void {
  pending = nodeId;
}

/** True once for the matching node id (the request is consumed). */
export function consumeTitleFocus(nodeId: string): boolean {
  if (pending !== nodeId) return false;
  pending = null;
  return true;
}
