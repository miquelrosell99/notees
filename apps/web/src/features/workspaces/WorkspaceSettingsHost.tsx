/**
 * WorkspaceSettingsHost — the app-level host for the workspace-settings
 * modal requested from gestures that live far apart in the tree (the
 * Sources hub's settings shortcut): the AddSourceHost idiom — a
 * module-level request this host listens to, listener-based because the
 * host is long-lived (requests arriving before any host mounts queue until
 * one does). The modal opens on the features tab, the Sources settings
 * section's home (the citekey pattern + the source-type list).
 */

import { useEffect, useState } from "react";

import { rememberWorkspaceName, rememberedWorkspaceList } from "../../core/workspace-registry.js";
import { STORAGE_KEYS, readStored } from "../../ui/app/storage.js";
import type { AnyClient } from "../../ui/app/clients.js";
import { requestAddSource } from "../sources/AddSourceHost.js";
import { WorkspaceSettingsModal } from "./WorkspaceSettingsModal.js";

type RequestListener = () => void;

const listeners = new Set<RequestListener>();
/** Requests fired before any host mounted (queued until one listens). */
let pending = false;

/** Ask the host to open the workspace settings (the Sources settings tab). */
export function requestWorkspaceSettings(): void {
  if (listeners.size === 0) {
    pending = true;
    return;
  }
  for (const listener of listeners) listener();
}

export interface WorkspaceSettingsHostProps {
  client: AnyClient;
  /** The sync server coordinates; empty hides the host (offline mode). */
  serverUrl: string;
  credential: string;
  workspaceName: string;
  /** Called after a successful rename so the shell can update its label. */
  onRenamed: (name: string) => void;
}

export function WorkspaceSettingsHost({
  client,
  serverUrl,
  credential,
  workspaceName,
  onRenamed,
}: WorkspaceSettingsHostProps) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const listener: RequestListener = () => setOpen(true);
    listeners.add(listener);
    // Drain anything requested before this host mounted.
    if (pending) {
      pending = false;
      listener();
    }
    return () => {
      listeners.delete(listener);
    };
  }, []);

  if (!open) return null;

  // The SAME wiring the account popup's admin entry uses (AppOverlays):
  // the active workspace's coordinates come from the device-local registry.
  const workspaceId = readStored(STORAGE_KEYS.workspaceId) ?? "";
  const workspaceRole =
    rememberedWorkspaceList().find((workspace) => workspace.id === workspaceId)?.role ?? "owner";
  return (
    <WorkspaceSettingsModal
      isOpen
      onClose={() => setOpen(false)}
      serverUrl={serverUrl}
      credential={credential}
      workspaceId={workspaceId}
      workspaceName={workspaceName}
      workspaceRole={workspaceRole}
      initialTab="features"
      client={client}
      onAddSource={() => requestAddSource({})}
      onRenamed={(name) => {
        rememberWorkspaceName(workspaceId, name);
        onRenamed(name);
      }}
    />
  );
}
