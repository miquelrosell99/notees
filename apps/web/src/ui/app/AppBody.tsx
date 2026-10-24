/**
 * AppBody — the shell's body region: the ONE workspace drag session host
 * stack (NodeLinkMenuHost → NodeHoverPreviewHost → WorkspaceDndHost →
 * FloatingEditorHost) wrapping the Sidebar, the PageCard content routing
 * (node view / search / settings / hubs), and the right rail's peeked-page
 * cards. Pure composition: every behavior arrives via props from App.
 */

import type { Dispatch, RefObject, SetStateAction } from "react";

import { parseDateNodeId } from "@notees/domain";

import type { ClientNode, SyncStatusSnapshot } from "@/core/workspace-client/index.js";
import type { AccountUser } from "@/core/auth-api.js";
import type { AnyClient } from "./clients.js";
import type { ShareTarget } from "../../features/node-menu/NodeMenuButton.js";
import type { NavKey } from "./Sidebar.js";
import { pathForNav } from "./routing.js";
import { Sidebar } from "./Sidebar.js";
import { NodeLinkMenuHost } from "../../features/node-menu/NodeLinkContextMenu.js";
import { FloatingEditorHost } from "../../features/block-editor/FloatingEditor.js";
import { NodeHoverPreviewHost } from "../../features/node-menu/NodeHoverPreview.js";
import { WorkspaceDndHost } from "../useWorkspaceDnd.js";
import { PageCard } from "../../features/page-sections/PageCard.js";
import { NodeView } from "../NodeView.js";
import { SearchPage } from "../SearchPage.js";
import { SettingsPage, type SettingsSection } from "../../features/settings/SettingsPage.js";
import { JournalsView } from "../../features/calendar/JournalsView.js";
import { CalendarView } from "../../features/calendar/CalendarView.js";
import { QueriesHub } from "../../features/collection/QueriesHub.js";
import { GraphView } from "../../features/collection/graph/GraphView.js";
import { TrashHub } from "../../features/trash/TrashHub.js";
import { ArchivedHub } from "../../features/archived/ArchivedHub.js";
import { SharesHub } from "../../features/sharing/SharesHub.js";
import { NodeCardFrame } from "../../features/collection/NodeCardFrame.js";
import { todayIsoLocal } from "../../features/calendar/calendarViewUtils.js";
import { Button } from "../../components/ui/fleet/Button.js";
import { HubView } from "./HubView.js";
import { DayStepper } from "../../features/calendar/DayPageHeader.js";

export interface AppBodyProps {
  client: AnyClient;
  clientRef: RefObject<AnyClient | null>;
  user: AccountUser | null;
  offline: boolean;
  sessionSignedIn: boolean;
  syncStatus: SyncStatusSnapshot;
  setSyncDetailsOpen: Dispatch<SetStateAction<boolean>>;
  setAdminSettingsOpen: Dispatch<SetStateAction<boolean>>;
  selectedPageId: string | null;
  activeNav: NavKey;
  setActiveNav: Dispatch<SetStateAction<NavKey>>;
  setSettingsSection: Dispatch<SetStateAction<SettingsSection | null>>;
  setSearchOpen: Dispatch<SetStateAction<boolean>>;
  setSelectedPageId: Dispatch<SetStateAction<string | null>>;
  pushNav: (url: string, state: Record<string, unknown>) => void;
  openPage: (nodeId: string) => void;
  openPageAt: (nodeId: string) => void;
  openInSidebar: (nodeId: string) => void;
  openSettingsSection: (section: SettingsSection) => void;
  handleNodeDeleted: (node: ClientNode) => void;
  handleSignOut: () => Promise<void>;
  handleForgetServer: () => void;
  handleConnectServer: (url: string) => void;
  searchOpen: boolean;
  settingsSection: SettingsSection | null;
  serverUrl: string;
  token: string;
  shareTarget: ShareTarget | undefined;
  sectionsLayout: boolean;
  setPresentingId: Dispatch<SetStateAction<string | null>>;
  reorderSidebarCard: (activeId: string, targetId: string, position: "before" | "after") => void;
  rightPanelOpen: boolean;
  setRightPanelOpen: Dispatch<SetStateAction<boolean>>;
  /** Focus mode hides every side panel (owner ruling 2026-10-24). */
  focusMode: boolean;
  sidebarCards: string[];
  setSidebarCards: Dispatch<SetStateAction<string[]>>;
  closeSidebarCard: (nodeId: string) => void;
}

export function AppBody(props: AppBodyProps) {
  const {
    client,
    clientRef,
    user,
    offline,
    sessionSignedIn,
    syncStatus,
    setSyncDetailsOpen,
    setAdminSettingsOpen,
    selectedPageId,
    activeNav,
    setActiveNav,
    setSettingsSection,
    setSearchOpen,
    setSelectedPageId,
    pushNav,
    openPage,
    openPageAt,
    openInSidebar,
    openSettingsSection,
    handleNodeDeleted,
    handleSignOut,
    handleForgetServer,
    handleConnectServer,
    searchOpen,
    settingsSection,
    serverUrl,
    token,
    shareTarget,
    sectionsLayout,
    setPresentingId,
    reorderSidebarCard,
    rightPanelOpen,
    setRightPanelOpen,
    focusMode,
    sidebarCards,
    setSidebarCards,
    closeSidebarCard,
  } = props;
  return (
    <div className="nt-body">
      <NodeLinkMenuHost
        client={client}
        openNode={openPage}
        openInSidebar={openInSidebar}
      >
      <NodeHoverPreviewHost client={client} openNode={openPage}>
      {/* The ONE workspace drag session: the host wraps the FloatingEditorHost
          (which wraps the regions), so the main content card, the right
          rail's workspace cards, and the floating editor windows (portals
          keep the React context) all join the same drag — useWorkspaceDnd.ts.
          The rail's card reorder rides the same session: the host reports
          the gesture, the App owns the stack + its device-local order. */}
      <WorkspaceDndHost onRailCardReorder={reorderSidebarCard}>
      <FloatingEditorHost client={client} openNode={openPage}>
      <Sidebar
        client={client}
        user={user}
        offline={offline}
        showSettings={sessionSignedIn && user !== null && !offline}
        onOpenSettings={() => openSettingsSection("appearance")}
        syncStatus={syncStatus}
        onOpenSyncDetails={() => setSyncDetailsOpen(true)}
        onOpenAdminSettings={
          sessionSignedIn && user !== null && !offline && user.isAdmin
            ? () => setAdminSettingsOpen(true)
            : undefined
        }
        selectedPageId={selectedPageId}
        activeNav={activeNav}
        onSelectNav={(key) => {
          // Today is a page, not a hub (owner 2026-10-06 — the sidebar
          // entry before Journal): ensure the chain and open the day page.
          if (key === "today") {
            const live = clientRef.current;
            // The journal toggle gates Today-page management (owner ruling
            // 2026-10-22): while it is off the Today writer stays silent —
            // no chain auto-creation. The sidebar hides the entry too; this
            // guard covers palette/deep-link routes.
            if (live !== null && live.isFeatureEnabled("journal")) {
              void live.ensureDateChain(todayIsoLocal()).then(({ day }) => openPage(day));
            }
            return;
          }
          setSettingsSection(null);
          setSearchOpen(false);
          setActiveNav(key);
          setSelectedPageId(null);
          pushNav(pathForNav(key), { node: null, nav: key });
        }}
        onOpenPage={openPage}
        onSignOut={() => void handleSignOut()}
        onOpenInSidebar={openInSidebar}
      />
      <PageCard
        accent={
          selectedPageId !== null
            ? (() => {
                const current = client.getNode(selectedPageId);
                return current === undefined ? null : client.effectiveNodeColor(current);
              })()
            : null
        }
      >
        {selectedPageId !== null ? (() => {
          // Day pages ride ONE bar (owner 2026-10-24 pass 5 — the chrome
          // ruling): the DayStepper (‹ bordered Today ›) is INJECTED into
          // NodeView's own SurfaceTopBar (topBarActionsExtra) instead of a
          // second bar stacked above the page; the target day page is
          // materialized on demand (the ensureDateChain pattern). The
          // .day-page-surface wrapper stays for the full-bleed flex fill
          // only — it carries no chrome of its own.
          const parsedDay =
            selectedPageId === null
              ? null
              : (() => {
                  const parsed = parseDateNodeId(selectedPageId);
                  return parsed !== null && parsed.precision === "day"
                    ? `${parsed.year}-${String(parsed.month).padStart(2, "0")}-${String(parsed.day).padStart(2, "0")}`
                    : null;
                })();
          const pageView = (
            <NodeView
              client={client}
              nodeId={selectedPageId}
              onOpenNode={openPage}
              onOpenNodeRaw={openPageAt}
              onOpenInSidebar={openInSidebar}
              onDeleted={handleNodeDeleted}
              onPresent={(id) => setPresentingId(id)}
              cornerMenu
              shareTarget={shareTarget}
              sectionsLayout={sectionsLayout}
              topBarActionsExtra={
                parsedDay !== null ? (
                  <DayStepper
                    iso={parsedDay}
                    onNavigateDay={(iso) => {
                      void client
                        .ensureDateChain(iso)
                        .then(({ day }) => openPage(day))
                        .catch(() => {});
                    }}
                  />
                ) : undefined
              }
            />
          );
          // The day page rides the .day-page-surface full-bleed wrapper (the
          // flex fill beneath the card's 13xl cap); its stepper is IN the
          // NodeView's own bar (topBarActionsExtra above) — the wrapper
          // carries no chrome of its own (one bar per surface).
          return parsedDay !== null ? (
            <div className="day-page-surface">{pageView}</div>
          ) : (
            pageView
          );
        })() : searchOpen ? (
          <SearchPage
            client={client}
            onOpenNode={openPage}
            initialQuery={new URLSearchParams(window.location.search).get("q") ?? ""}
          />
        ) : settingsSection !== null && user !== null ? (
          <SettingsPage
            section={settingsSection}
            onNavigate={openSettingsSection}
            serverUrl={serverUrl}
            token={token}
            user={user}
            onSignOut={() => void handleSignOut()}
            syncConnected={syncStatus.status !== "error"}
            onForgetServer={() => handleForgetServer()}
            onConnectServer={(url) => handleConnectServer(url)}
          />
        ) : activeNav === "journal" ? (
          <JournalsView client={client} onOpenPage={openPage} />
        ) : activeNav === "calendar" ? (
          <CalendarView client={client} onOpenPage={openPage} />
        ) : activeNav === "queries" ? (
          <QueriesHub client={client} onOpenNode={openPage} onOpenInSidebar={openInSidebar} />
        ) : activeNav === "graph" ? (
          /* The graph hub renders edge-to-edge in the main content card —
             the canvas is the card's sole content (the whiteboard-surface
             treatment; the card frame itself stays). */
          <div className="nt-graph-surface">
            <GraphView client={client} onNodeClick={openPage} />
          </div>
        ) : activeNav === "trash" ? (
          /* The Trash hub: browse / restore / permanently delete trashed
             subtrees (the data path always existed — this is the v1
             sidebar surface restored for the web). Reached from the
             account popup since 2026-10-19. */
          <TrashHub client={client} onOpenNode={openPage} />
        ) : activeNav === "archived" ? (
          /* The Archived hub (owner ruling 2026-10-22, the classes-gallery
             batch): the archival side of the liveness bit — archived nodes
             (no trash row) with unarchive / delete actions. Reached from
             the account popup, beside Trash. Owns /archived + the tab
             title through the nav register. */
          <ArchivedHub client={client} onOpenNode={openPage} />
        ) : activeNav === "shares" ? (
          /* The Shares hub (owner 2026-10-19): the v1 SharesUnifiedView's
             Shared-Out tab over the v2 public-link share register —
             reached from the account popup. */
          <SharesHub
            client={client}
            serverUrl={serverUrl}
            credential={token}
            onOpenNode={openPage}
          />
        ) : (
          <HubView client={client} nav={activeNav} onOpenNode={openPage} onOpenInSidebar={openInSidebar} />
        )}
      </PageCard>
      {rightPanelOpen && !focusMode && (
        /* Focus mode hides every side panel (owner ruling 2026-10-24). */
        <aside className="nt-right-card" aria-label="Right sidebar">
          {/* The cards-only rail: the node-relevant widgets
              (graph/TOC/Activity/Comments) relocated into the page chrome's
              context column; this rail hosts workspace cards exclusively —
              the generic frame around NodeView. Fixed-height surfaced panel
              (owner 2026-10-14): it stretches the body height regardless
              of the card count and scrolls internally when the stack
              outgrows it. */}
          {sidebarCards.length > 0 && (
            <div className="nt-right-card__bar">
              <span className="nt-right-card__bar-label">Peeked pages</span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setSidebarCards([]);
                  setRightPanelOpen(false);
                }}
              >
                Clear all
              </Button>
            </div>
          )}
          {sidebarCards.map((cardId) => (
            <NodeCardFrame
              key={cardId}
              client={client}
              nodeId={cardId}
              onOpenNode={openPage}
              onOpenNodeRaw={openPageAt}
              onClose={() => closeSidebarCard(cardId)}
            />
          ))}
        </aside>
      )}
      </FloatingEditorHost>
      </WorkspaceDndHost>
      </NodeHoverPreviewHost>
      </NodeLinkMenuHost>
    </div>
  );
}
