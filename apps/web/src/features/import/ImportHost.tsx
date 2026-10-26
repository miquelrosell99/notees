/**
 * ImportHost — the app-level host for the unified import modal, mounted
 * once in AppModals with the workspace client + the server coordinates.
 * Requests arrive from gestures that live far apart in the tree (today the
 * command palette's "Import…" row; later the sidebar or settings), so the
 * request is a module-level call (requestImport) this host listens to — the
 * AddSourceHost idiom: listener-based because the host is long-lived
 * (requests arriving before any host mounts queue until one does).
 *
 * Offline note: the host stays mounted without a server — the
 * current-workspace sources (Markdown file, Logseq folder, Logseq DB) work
 * fully offline; the workspace-creating sources fail loud in the modal.
 */

import { useEffect, useState } from "react";

import type { AnyClient } from "../collection/types.js";
import { subscribeImportRequests, type ImportRequest } from "./requestImport.js";
import { ImportOptionsModal, type ImportSourceId } from "./ImportOptionsModal.js";

export interface ImportHostProps {
  client: AnyClient;
  /** The sync server coordinates (null = offline). */
  serverUrl: string | null;
  credential: string;
  /** Switch the app to a freshly created/imported workspace. */
  onOpenWorkspace: (workspaceId: string, name: string) => void;
}

export function ImportHost({ client, serverUrl, credential, onOpenWorkspace }: ImportHostProps) {
  const [request, setRequest] = useState<ImportRequest | null>(null);

  useEffect(() => subscribeImportRequests(setRequest), []);

  if (request === null) return null;

  return (
    <ImportOptionsModal
      isOpen
      client={client}
      serverUrl={serverUrl}
      credential={credential}
      onOpenWorkspace={onOpenWorkspace}
      initialSource={request.initialSource as ImportSourceId | undefined}
      onClose={() => setRequest(null)}
    />
  );
}
