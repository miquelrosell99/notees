/**
 * AppOverlays — the shell's always-on status layer: the in-process store
 * banner, the sync-details modal, the admin workspace-settings modal, the
 * backend-unavailable overlay, and the notification toaster. Pure
 * composition: every behavior arrives via props from App.
 */

import type { Dispatch, SetStateAction } from "react";

import type { SyncStatusSnapshot } from "@/core/workspace-client/index.js";
import { rememberWorkspaceName, rememberedWorkspaceList } from "@/core/workspace-registry.js";
import { STORAGE_KEYS, readStored } from "./storage.js";
import type { AnyClient } from "./clients.js";
import type { StoreMode } from "./storeMode.js";
import { InProcessStoreBanner } from "../../components/ui/fleet/InProcessStoreBanner.js";
import { SyncDetailsModal } from "../../features/modals/SyncDetailsModal.js";
import { WorkspaceSettingsModal } from "../../features/workspaces/WorkspaceSettingsModal.js";
import { requestAddSource } from "../../features/sources/AddSourceHost.js";
import { BackendUnavailableOverlay } from "../../components/ui/fleet/BackendUnavailableOverlay.js";
import { NotificationToaster } from "../../components/ui/fleet/NotificationToaster.js";

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
  } = props;
  return (
    <>
      {storeMode === "in-process" && <InProcessStoreBanner reason={storeReason} />}
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
          workspaceId={readStored(STORAGE_KEYS.workspaceId)}
          workspaceName={workspaceName}
          workspaceRole={
            rememberedWorkspaceList().find((ws) => ws.id === readStored(STORAGE_KEYS.workspaceId))?.role ?? "owner"
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
      <BackendUnavailableOverlay syncStatus={syncStatus} />
      <NotificationToaster />
    </>
  );
}
