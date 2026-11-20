/**
 * ClassFieldsStepHost — the app-level host for the create-first flow's
 * class-fields step (the QuickCreateModal over the freshly created node).
 * Requests arrive from gestures whose picker UNMOUNTS the moment the pick
 * lands — the editor's `@`/`+`/`#` popups close on pick, so picker-local
 * modal state would die with the picker before the fields step renders.
 * The request is therefore module-level (the AddSourceHost idiom:
 * listener-based because the host is long-lived and requests may arrive
 * before any host mounts — they queue until one does).
 */

import { useEffect, useState } from "react";

import type { AnyClient } from "./quickCreate.js";
import { QuickCreateModal } from "./QuickCreateModal.js";

export interface ClassFieldsStepRequest {
  /** The already-created node the fields land on. */
  nodeId: string;
  /** The picked classes — the form aggregates their bound properties. */
  classIds: string[];
}

type RequestListener = (request: ClassFieldsStepRequest) => void;

const listeners = new Set<RequestListener>();
/** Requests fired before any host mounted (queued until one listens). */
const pending: ClassFieldsStepRequest[] = [];

/** Ask the host to open the class-fields step for the created node. */
export function requestClassFieldsStep(request: ClassFieldsStepRequest): void {
  if (listeners.size === 0) {
    pending.push(request);
    return;
  }
  for (const listener of listeners) listener(request);
}

export interface ClassFieldsStepHostProps {
  client: AnyClient;
  /** Opens the duplicate-warning's existing node (the app page-open). */
  onOpenNode?: ((nodeId: string) => void) | undefined;
}

export function ClassFieldsStepHost({ client, onOpenNode = undefined }: ClassFieldsStepHostProps) {
  const [request, setRequest] = useState<ClassFieldsStepRequest | null>(null);

  useEffect(() => {
    const listener: RequestListener = (next) => setRequest(next);
    listeners.add(listener);
    // Drain anything requested before this host mounted.
    while (pending.length > 0) listener(pending.shift()!);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  if (request === null) return null;
  return (
    <QuickCreateModal
      isOpen
      client={client}
      nodeId={request.nodeId}
      classIds={request.classIds}
      onClose={() => setRequest(null)}
      onDone={() => setRequest(null)}
      onOpenExisting={onOpenNode}
    />
  );
}
