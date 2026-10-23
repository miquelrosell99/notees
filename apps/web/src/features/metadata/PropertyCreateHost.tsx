/**
 * PropertyCreateHost — the app-level host for the S1 creation modal. The
 * modal is opened from gestures that live far apart in the tree (the
 * block-editor slash command, the Ctrl/Cmd+Alt+P global chord, the
 * VerbPopover create-and-bind), so the request is a module-level call
 * (requestPropertyCreate) this host listens to — the same idiom as
 * requestQueryBuilderOpen, but listener-based because the host is
 * long-lived (requests arriving before any host mounts queue until one
 * does).
 *
 * The request carries the caller's context:
 *  - `nodeId`: after the create, the host ASSIGNS the schema to the node
 *    (owner ruling 2026-10-23 — assignment without a value; the panel row
 *    renders empty and the row's editor authors the first value later);
 *  - `contextClassId`: the class page's add popover — the modal itself
 *    binds the schema to the class (+ the optional binding default);
 *  - `onCreated`: a caller-specific follow-up (the verb flow binds the
 *    typed-link mark with the new schema id).
 *
 * Rendered once in AppModals with the workspace client.
 */

import { useEffect, useState } from "react";

import { PropertyCreateModal } from "./PropertyCreateModal.js";
import type { AnyClient } from "./shared.js";

export interface PropertyCreateRequest {
  /** After the create, assign the schema to this node (no value — the row
   *  renders empty; the row's editor authors the first value later). */
  nodeId?: string | undefined;
  /** Class context: the modal binds the schema to this class. */
  contextClassId?: string | undefined;
  /** The picker's typed query, carried in as the name. */
  initialName?: string | undefined;
  /** Pre-selected type (the verb flow pre-selects object). */
  initialType?: string | undefined;
  /** Pre-selected cardinality (the verb flow pre-selects multi). */
  initialMulti?: boolean | undefined;
  /** Caller-specific follow-up after the create lands (the type rides
   *  explicitly — a cached listPropertySchemas read can still be stale). */
  onCreated?: ((schemaId: string, type: string) => void) | undefined;
  /** The modal closed without creating (the user cancelled). */
  onCancel?: (() => void) | undefined;
}

type RequestListener = (request: PropertyCreateRequest) => void;

const listeners = new Set<RequestListener>();
/** Requests fired before any host mounted (queued until one listens). */
const pending: PropertyCreateRequest[] = [];

/** Ask the host to open the S1 creation modal with the given context. */
export function requestPropertyCreate(request: PropertyCreateRequest): void {
  if (listeners.size === 0) {
    pending.push(request);
    return;
  }
  for (const listener of listeners) listener(request);
}

export function PropertyCreateHost({ client }: { client: AnyClient }) {
  const [request, setRequest] = useState<PropertyCreateRequest | null>(null);

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
    <PropertyCreateModal
      isOpen
      client={client}
      initialName={request.initialName}
      initialType={request.initialType}
      initialMulti={request.initialMulti}
      contextClassId={request.contextClassId}
      onCreated={(schemaId, type) => {
        if (request.nodeId !== undefined) {
          void client.assignProperty(request.nodeId, schemaId).catch((error: unknown) => {
            console.warn("[property-create] assignment failed:", error);
          });
        }
        request.onCreated?.(schemaId, type);
      }}
      onClose={() => {
        request.onCancel?.();
        setRequest(null);
      }}
    />
  );
}
