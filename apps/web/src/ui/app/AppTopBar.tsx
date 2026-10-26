/**
 * AppTopBar — the shell's top region: the TopBar (breadcrumbs, history
 * arrows, calendar/undo/history buttons, layout + focus + condensed
 * toggles, the workspace switcher) plus the popups and pickers it anchors
 * (the New-class NodeSelector, the history menu, the calendar popup).
 * Pure composition: every behavior arrives via props from App.
 */

import type { Dispatch, RefObject, SetStateAction } from "react";
import { useState } from "react";

import { dayNodeId } from "@notees/domain";
import type { UndoUiState } from "@/core/undo-journal.js";
import { rememberWorkspaceName } from "@/core/workspace-registry.js";
import { STORAGE_KEYS, readStored } from "./storage.js";
import type { AnyClient } from "./clients.js";
import type { WorkspaceConnection } from "./useWorkspaceConnection.js";
import { TopBar } from "./TopBar.js";
import { Breadcrumbs } from "../../features/node-menu/Breadcrumbs.js";
import { WorkspaceSwitcher } from "../../features/workspaces/WorkspaceSwitcher.js";
import { createNodesWithClasses } from "../../features/templates/createNodesWithClasses.js";
import { HistoryMenuPopup } from "../../features/page-sections/HistoryMenuPopup.js";
import { CalendarPopup } from "../../features/calendar/TopBarCalendarPopup.js";
import { NodeSelector } from "../../features/pickers/NodeSelector.js";
import { AssetUploadModal } from "../../features/modals/AssetUploadModal.js";
import { QuickCreateModal } from "../../features/modals/QuickCreateModal.js";
import { routeNewNodeClass } from "../../features/modals/quickCreate.js";

export interface AppTopBarProps {
  client: AnyClient;
  selectedPageId: string | null;
  openPage: (nodeId: string) => void;
  sidebarOpen: boolean;
  setSidebarOpen: Dispatch<SetStateAction<boolean>>;
  rightPanelOpen: boolean;
  setRightPanelOpen: Dispatch<SetStateAction<boolean>>;
  canGoBack: boolean;
  canGoForward: boolean;
  calendarOpen: boolean;
  setCalendarOpen: Dispatch<SetStateAction<boolean>>;
  calendarButtonRef: RefObject<HTMLButtonElement | null>;
  firstDayOfWeek: number;
  undoUi: UndoUiState;
  runUndo: () => void;
  runRedo: () => void;
  historyOpen: boolean;
  setHistoryOpen: Dispatch<SetStateAction<boolean>>;
  historyButtonRef: RefObject<HTMLButtonElement | null>;
  newPickerOpen: boolean;
  setNewPickerOpen: Dispatch<SetStateAction<boolean>>;
  newButtonRef: RefObject<HTMLButtonElement | null>;
  setPaletteOpen: Dispatch<SetStateAction<boolean>>;
  sectionsLayout: boolean;
  setSectionsLayout: Dispatch<SetStateAction<boolean>>;
  focusMode: boolean;
  setFocusMode: (value: boolean) => void;
  toggleFocusMode: () => boolean;
  condensedActive: boolean;
  setCondensedPref: (value: boolean) => void;
  offline: boolean;
  serverUrl: string;
  token: string;
  workspaceName: string;
  sessionSignedIn: boolean;
  connect: WorkspaceConnection["connect"];
  setSelectedPageId: Dispatch<SetStateAction<string | null>>;
  pushNav: (url: string, state: Record<string, unknown>) => void;
  setManagerOpen: Dispatch<SetStateAction<boolean>>;
  setWorkspaceName: Dispatch<SetStateAction<string>>;
}

export function AppTopBar(props: AppTopBarProps) {
  const {
    client,
    selectedPageId,
    openPage,
    sidebarOpen,
    setSidebarOpen,
    rightPanelOpen,
    setRightPanelOpen,
    canGoBack,
    canGoForward,
    calendarOpen,
    setCalendarOpen,
    calendarButtonRef,
    firstDayOfWeek,
    undoUi,
    runUndo,
    runRedo,
    historyOpen,
    setHistoryOpen,
    historyButtonRef,
    newPickerOpen,
    setNewPickerOpen,
    newButtonRef,
    setPaletteOpen,
    sectionsLayout,
    setSectionsLayout,
    focusMode,
    setFocusMode,
    toggleFocusMode,
    condensedActive,
    setCondensedPref,
    offline,
    serverUrl,
    token,
    workspaceName,
    sessionSignedIn,
    connect,
    setSelectedPageId,
    pushNav,
    setManagerOpen,
    setWorkspaceName,
  } = props;
  // the New flow's class-pick routing,
  // generalized 2026-10-26: EVERY class pick opens the class-driven
  // QuickCreateModal (the picked class id); the asset pick rides the upload
  // flow. Null = the modal is closed.
  const [quickCreateClassId, setQuickCreateClassId] = useState<string | null>(null);
  const [assetUploadClassId, setAssetUploadClassId] = useState<string | null>(null);
  return (
    <>
      <TopBar
        breadcrumbs={
          selectedPageId !== null ? (
            <Breadcrumbs client={client} nodeId={selectedPageId} onOpenNode={openPage} editable />
          ) : null
        }
        sidebarOpen={sidebarOpen}
        rightPanelOpen={rightPanelOpen}
        canGoBack={canGoBack}
        canGoForward={canGoForward}
        onGoBack={() => window.history.back()}
        onGoForward={() => window.history.forward()}
        calendarOpen={calendarOpen}
        onToggleCalendar={() => setCalendarOpen((open) => !open)}
        calendarButtonRef={calendarButtonRef}
        undoState={undoUi}
        onUndo={runUndo}
        onRedo={runRedo}
        onToggleHistory={() => setHistoryOpen((open) => !open)}
        historyButtonRef={historyButtonRef}
        onToggleSidebar={() => setSidebarOpen((open) => !open)}
        onToggleRightPanel={() => setRightPanelOpen((open) => !open)}
        onNewNode={() => setNewPickerOpen(true)}
        onRequestSearch={() => setPaletteOpen(true)}
        newButtonRef={newButtonRef}
        sectionsLayout={sectionsLayout}
        onToggleLayout={selectedPageId !== null ? () => setSectionsLayout((v) => !v) : undefined}
        focusMode={focusMode}
        onToggleFocusMode={() => setFocusMode(toggleFocusMode())}
        condensedActive={condensedActive}
        onToggleCondensed={
          selectedPageId !== null ? () => setCondensedPref(!condensedActive) : undefined
        }
        workspaceSwitcher={
          offline ? undefined : (
            <WorkspaceSwitcher
              serverUrl={serverUrl}
              credential={token}
              activeWorkspaceId={readStored(STORAGE_KEYS.workspaceId)}
              activeName={workspaceName}
              client={client}
              onSwitch={(id, name) => {
                setSelectedPageId(null);
                void connect(serverUrl, token, id, {
                  isOffline: false,
                  credentialType: sessionSignedIn ? "session" : "apikey",
                  label: name,
                });
              }}
              onManageWorkspaces={() => {
                pushNav("/workspaces", { view: "workspaces" });
                setManagerOpen(true);
              }}
              onRenamed={(id, name) => {
                rememberWorkspaceName(id, name);
                if (id === readStored(STORAGE_KEYS.workspaceId)) setWorkspaceName(name);
              }}
            />
          )
        }
      />
      {newPickerOpen && (
        <NodeSelector
          client={client}
          anchorEl={newButtonRef.current}
          searchMode="classes"
          searchPlaceholder="Search classes…"
          emptyQueryOption={{
            label: "No class",
            onPick: () => {
              setNewPickerOpen(false);
              createNodesWithClasses(client, [], openPage);
            },
          }}
          onClose={() => setNewPickerOpen(false)}
          onAdd={(picked) => {
            // Single-pick contract: one class, one page —
            // "create a person", "create a project". routes the pick, generalized 2026-10-26: EVERY
            // class opens the class-driven create modal (the dynamic
            // properties form), an asset class opens the upload modal
            // (uploading IS creating).
            setNewPickerOpen(false);
            const route = routeNewNodeClass(client, picked.id);
            if (route.kind === "quick-create") {
              setQuickCreateClassId(route.classId);
              return;
            }
            if (route.kind === "asset-upload") {
              setAssetUploadClassId(route.classId);
              return;
            }
            createNodesWithClasses(client, [picked.id], openPage);
          }}
        />
      )}
      {historyOpen && (
        <HistoryMenuPopup
          client={client}
          isOpen
          onClose={() => setHistoryOpen(false)}
          anchorRef={historyButtonRef}
          onOpenNode={(nodeId) => openPage(nodeId)}
        />
      )}
      {calendarOpen && (
        <CalendarPopup
          isOpen
          onClose={() => setCalendarOpen(false)}
          anchorRef={calendarButtonRef}
          firstDayOfWeek={firstDayOfWeek}
          hasNote={(iso) => client.getNodeRaw(dayNodeId(iso)) !== undefined}
          onSelectDay={(iso) => {
            void client.ensureDateChain(iso).then(({ day }) => openPage(day));
            setCalendarOpen(false);
          }}
          onSelectMonth={(year, month) => {
            const iso = `${year}-${String(month).padStart(2, "0")}-01`;
            void client.ensureDateChain(iso).then(({ month: monthId }) => openPage(monthId));
            setCalendarOpen(false);
          }}
          onSelectYear={(year) => {
            void client.ensureDateChain(`${year}-01-01`).then(({ year: yearId }) => openPage(yearId));
            setCalendarOpen(false);
          }}
        />
      )}
      {quickCreateClassId !== null && (
        /* The New flow's class pick: the class-driven create modal (every
           class — the dynamic properties form loads from the class's
           bound properties). */
        <QuickCreateModal
          isOpen
          client={client}
          classId={quickCreateClassId}
          onClose={() => setQuickCreateClassId(null)}
          onCreated={(nodeId) => {
            setQuickCreateClassId(null);
            openPage(nodeId);
          }}
        />
      )}
      {assetUploadClassId !== null && (
        /* The New flow's asset pick: uploading IS creating the asset. */
        <AssetUploadModal
          isOpen
          client={client}
          assetClassId={assetUploadClassId}
          onClose={() => setAssetUploadClassId(null)}
          onUploaded={(assetNodeId) => {
            setAssetUploadClassId(null);
            openPage(assetNodeId);
          }}
        />
      )}
    </>
  );
}
