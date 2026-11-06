/**
 * AppOverlays — the shell's always-on status layer: the in-process store
 * banner, the sync-details modal, the admin workspace-settings modal, the
 * backend-down risk lock, and the notification toaster. Pure
 * composition: every behavior arrives via props from App.
 */

import type { Dispatch, SetStateAction } from "react";

import type { SyncStatusSnapshot } from "@/core/workspace-client/index.js";
import { rememberWorkspaceName, rememberedWorkspaceList } from "@/core/workspace-registry.js";
import { currentMasterKey, WORKSPACE_CREATE_KEYING_COPY } from "@/core/crypto-custody.js";
import { STORAGE_KEYS, readStored } from "./storage.js";
import type { AnyClient } from "./clients.js";
import type { StoreMode } from "./storeMode.js";
import { InProcessStoreBanner } from "../../components/ui/kit/InProcessStoreBanner.js";
import { NotEncryptedBanner } from "../../components/ui/kit/NotEncryptedBanner.js";
import { SyncDetailsModal } from "../../features/modals/SyncDetailsModal.js";
import { WorkspaceSettingsModal } from "../../features/workspaces/WorkspaceSettingsModal.js";
import { WorkspaceSettingsHost } from "../../features/workspaces/WorkspaceSettingsHost.js";
import { requestAddSource } from "../../features/sources/AddSourceHost.js";
import { BackendDownLock } from "../../components/ui/kit/BackendDownLock.js";
import { NotificationToaster } from "../../components/ui/kit/NotificationToaster.js";

export interface AppOverlaysProps {
  client: AnyClient;
  storeMode: StoreMode;
  storeReason: string | undefined;
  syncStatus: SyncStatusSnapshot;
  syncDetailsOpen: boolean;
  setSyncDetailsOpen: Dispatch<SetStateAction<boolean>>;
  adminSettingsOpen: boolean;
  setAdminSettingsOpen: Dispatch<SetStateAction<boolean>>;
  serverUrl: string;
  token: string;
  workspaceName: string;
  setWorkspaceName: Dispatch<SetStateAction<string>>;
  /**
   * Positive knowledge that the open workspace carries no wrapped key — the
   * not-encrypted banner's gate (false: keyed, offline, or indeterminate).
   */
  workspacePlaintext: boolean;
  /** The workspace id the post-keying honest notice names (null = no notice). */
  keyedNoticeFor: string | null;
  /** The banner's deliberate keying action (ensure + reconnect). */
  onKeyWorkspace: () => Promise<void>;
  /** Clears the post-keying notice. */
  onDismissKeyedNotice: () => void;
}

export function AppOverlays(props: AppOverlaysProps) {
  const {
    client,
    storeMode,
    storeReason,
    syncStatus,
    syncDetailsOpen,
    setSyncDetailsOpen,
    adminSettingsOpen,
    setAdminSettingsOpen,
    serverUrl,
    token,
    workspaceName,
    setWorkspaceName,
    workspacePlaintext,
    keyedNoticeFor,
    onKeyWorkspace,
    onDismissKeyedNotice,
  } = props;
  const activeWorkspaceId = readStored(STORAGE_KEYS.workspaceId);
  // The post-keying notice only names the workspace it keying'd — a switch
  // must not carry it onto another workspace.
  const keyedNotice = keyedNoticeFor !== null && keyedNoticeFor === activeWorkspaceId;
  const keylessSession = currentMasterKey() === null;
  return (
    <>
      {storeMode === "in-process" && <InProcessStoreBanner reason={storeReason} />}
      {(keyedNotice || workspacePlaintext) && (
        <NotEncryptedBanner
          keyed={keyedNotice}
          onKey={onKeyWorkspace}
          keyDisabled={keylessSession}
          {...(keylessSession ? { keyDisabledHint: WORKSPACE_CREATE_KEYING_COPY } : {})}
          onDismissKeyed={onDismissKeyedNotice}
        />
      )}
      <SyncDetailsModal
        client={client}
        snapshot={syncStatus}
        isOpen={syncDetailsOpen}
        onClose={() => setSyncDetailsOpen(false)}
      />
      {adminSettingsOpen && (
        /* The account popup's admin entry (admin users only): the active
           workspace's settings, opened on the plugins tab — the
           admin-gated surface (the server enforces admin on the routes). */
        <WorkspaceSettingsModal
          isOpen
          onClose={() => setAdminSettingsOpen(false)}
          serverUrl={serverUrl}
          credential={token}
          workspaceId={activeWorkspaceId}
          workspaceName={workspaceName}
          workspaceRole={
            rememberedWorkspaceList().find((ws) => ws.id === activeWorkspaceId)?.role ?? "owner"
          }
          initialTab="plugins"
          client={client}
          onAddSource={() => requestAddSource({})}
          onRenamed={(name) => {
            const id = readStored(STORAGE_KEYS.workspaceId);
            rememberWorkspaceName(id, name);
            setWorkspaceName(name);
          }}
        />
      )}
      <BackendDownLock syncStatus={syncStatus} />
      <NotificationToaster />
      {/* The workspace-settings modal's app-level host: any surface
          requesting the modal (the AddSourceDialog's resolver-disabled
          pointer, the workspace switcher) opens it through the
          module-level queue, the AddSourceHost idiom. */}
      <WorkspaceSettingsHost
        client={client}
        serverUrl={serverUrl}
        credential={token}
        workspaceName={workspaceName}
        onRenamed={(name) => setWorkspaceName(name)}
      />
    </>
  );
}
