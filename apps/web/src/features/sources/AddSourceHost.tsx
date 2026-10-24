/**
 * AddSourceHost — the app-level host for the add-source dialog, mounted
 * once in AppModals with the workspace client + the server coordinates.
 * Requests arrive from gestures that live far apart in the tree (the
 * command palette's "Add source…" row, the Sources settings button, the
 * NodeSelector paste-URL "Create source from link" row), so the request is
 * a module-level call (requestAddSource) this host listens to — the
 * PropertyCreateHost idiom: listener-based because the host is long-lived
 * (requests arriving before any host mounts queue until one does).
 *
 * The routing decision (owner ruling): an identifier-shaped paste (DOI /
 * arXiv / URL) opens the dialog in identifier mode; a BARE URL with the
 * resolver disabled creates a plain web_page weblink instead (the dialog
 * would only show the settings note — the honest shortcut is the link
 * itself). With the resolver on, a URL routes into the dialog (the ?url=
 * PDF flow decides whether it resolves).
 *
 * A request-level onCreated (the picker row's context) receives the
 * created id INSTEAD of the app's page-open — the picker links the node
 * like any create-row result.
 */

import { useEffect, useState } from "react";

import { SYSTEM_CLASS_UUIDS } from "@notees/domain";

import type { AnyClient } from "../modals/quickCreate.js";
import { readSourceSettings } from "../modals/quickCreate.js";
import { classifySourceInput } from "./resolver.js";
import { AddSourceDialog } from "./AddSourceDialog.js";

export interface AddSourceRequest {
  /** A pasted identifier/link the dialog prefills its input with. */
  initialInput?: string | undefined;
  /** Caller-specific follow-up receiving the created node id (the picker
   *  links it like a create-row result); absent = the app opens the page. */
  onCreated?: ((nodeId: string) => void) | undefined;
}

type RequestListener = (request: AddSourceRequest) => void;

const listeners = new Set<RequestListener>();
/** Requests fired before any host mounted (queued until one listens). */
const pending: AddSourceRequest[] = [];

/** Ask the host to open the add-source dialog with the given input. */
export function requestAddSource(request: AddSourceRequest): void {
  if (listeners.size === 0) {
    pending.push(request);
    return;
  }
  for (const listener of listeners) listener(request);
}

export interface AddSourceHostProps {
  client: AnyClient;
  /** The sync server coordinates; null hides the host (offline mode). */
  serverUrl: string | null;
  credential: string;
  onCreated: (nodeId: string) => void;
  onOpenNode: (nodeId: string) => void;
}

export function AddSourceHost({
  client,
  serverUrl,
  credential,
  onCreated,
  onOpenNode,
}: AddSourceHostProps) {
  const [request, setRequest] = useState<AddSourceRequest | null>(null);

  useEffect(() => {
    const listener: RequestListener = (next) => setRequest(next);
    listeners.add(listener);
    // Drain anything requested before this host mounted.
    while (pending.length > 0) listener(pending.shift()!);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  if (request === null || serverUrl === null) return null;

  const finish = (nodeId: string): void => {
    setRequest(null);
    if (request.onCreated !== undefined) request.onCreated(nodeId);
    else onCreated(nodeId);
  };
  const cancel = (): void => setRequest(null);

  // The bare-URL + resolver-off shortcut: a plain weblink create, no dialog.
  const raw = (request.initialInput ?? "").trim();
  if (
    raw !== "" &&
    classifySourceInput(raw)?.kind === "url" &&
    !readSourceSettings(client).resolverEnabled
  ) {
    void client
      .createObject({
        isEmbedded: false,
        name: raw,
        classIds: [SYSTEM_CLASS_UUIDS.web_page],
      })
      .then(finish)
      .catch((error: unknown) => {
        console.warn("[add-source] weblink create failed:", error);
        cancel();
      });
    return null;
  }

  return (
    <AddSourceDialog
      isOpen
      client={client}
      serverUrl={serverUrl}
      credential={credential}
      initialInput={request.initialInput ?? ""}
      onClose={cancel}
      onCreated={finish}
      onOpenNode={(nodeId) => {
        cancel();
        onOpenNode(nodeId);
      }}
    />
  );
}
