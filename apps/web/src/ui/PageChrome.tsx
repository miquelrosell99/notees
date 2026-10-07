/**
 * PageChrome — the page chrome leaf pieces (the main-content
 * restructure): the nodeview top bar, the day-aware page header (with the
 * cover card aside), and the footer wrapper. Extracted from PageView so the
 * component stays a chrome composer; the panelled/compact COMPOSITION (the
 * .nt-page-body grid, the .nt-nodeview-body stack, the compact corner)
 * lives in PageView, which owns the three-column composition now.
 * The day-header swap is driven by the variant's `dayIso` (the page
 * variant is data, see components/pageVariant.ts); the shared icon button
 * is the single icon+color edit entry for every node kind. The styles
 * stay in app.css — every class hook is exactly the one PageView rendered
 * before the extraction.
 *
 * The panelled composition
 * is now THREE columns — NodeView · properties · context (PageView owns the
 * grid; the column-collapse choice is recorded there). The context column
 * hosts LocalGraphCard, TocSection, the Activity section (relocated), and
 * CommentsSection. The dedupe check (the layout precondition):
 * the right rail's ReferencesSection and the page's own Backlinks tab both
 * rendered getLinkedReferences — the SAME data — so the rail's
 * ReferencesSection is deleted (its lazy contract lived in the now-removed
 * component); the Backlinks tab stays the one home in the SectionStack,
 * where the tab/filter machinery lands later. One home, no duplication.
 */

import { useRef, useState, type ReactNode } from "react";

import type { WorkerClient } from "@/core/worker-client.js";
import type { BlockTreeNode, ClientNode, WorkspaceClient } from "@/core/workspace-client.js";

import { DayPageHeader } from "./components/DayPageHeader.js";
import { ClassesRow, TagsRow } from "./components/MetadataSection.js";
import { IconPickerPopup } from "./components/IconPickerPopup.js";
import { CoverCard } from "./components/PageBanner.js";
import { PageFooter } from "./components/PageFooter.js";
import { Icon } from "./Icon.js";
import { TitleEditor } from "./TitleEditor.js";
import { displayNameForSettings } from "./dateDisplay.js";

type AnyClient = WorkspaceClient | WorkerClient;

/**
 * NodeTopbar — the panelled main layout's pinned top row (the content
 * column's bar): the two panel collapse toggles (properties left, context
 * right) and the classes pills on the left, the host's chromeRight (the
 * blocks view switcher + the "…" node menu) on the right, over a full-width
 * divider border like the sidebar's.
 */
export function NodeTopbar({
  client,
  nodeId,
  classIds,
  sidePanelCollapsed,
  onToggleSidePanel,
  contextPanelCollapsed,
  onToggleContextPanel,
  chromeRight,
  onOpenPage,
}: {
  client: AnyClient;
  nodeId: string;
  classIds: string[];
  sidePanelCollapsed: boolean;
  onToggleSidePanel: () => void;
  contextPanelCollapsed: boolean;
  onToggleContextPanel: () => void;
  chromeRight: ReactNode;
  onOpenPage?: ((pageId: string) => void) | undefined;
}) {
  return (
    <div className="nt-node-topbar">
      <button
        type="button"
        className="nt-icon-btn"
        aria-label={sidePanelCollapsed ? "Show properties panel" : "Hide properties panel"}
        aria-pressed={!sidePanelCollapsed}
        title={sidePanelCollapsed ? "Show properties panel" : "Hide properties panel"}
        onClick={onToggleSidePanel}
      >
        <Icon path="mdi-page-layout-sidebar-left" size={1} />
      </button>
      <button
        type="button"
        className="nt-icon-btn"
        aria-label={contextPanelCollapsed ? "Show context panel" : "Hide context panel"}
        aria-pressed={!contextPanelCollapsed}
        title={contextPanelCollapsed ? "Show context panel" : "Hide context panel"}
        onClick={onToggleContextPanel}
      >
        <Icon path="mdi-page-layout-sidebar-right" size={1} />
      </button>
      <div className="nt-node-topbar__classes">
        <ClassesRow client={client} nodeId={nodeId} classIds={classIds} onOpenPage={onOpenPage} />
      </div>
      <span className="nt-node-topbar__spacer" aria-hidden="true" />
      {chromeRight !== undefined && (
        <div className="nt-node-topbar__right">{chromeRight}</div>
      )}
    </div>
  );
}

/**
 * PageHeaderChrome — the .page-header-section: the header proper
 * beside the cover card aside. Day pages render the DayPageHeader as the
 * whole title row (driven by the variant's `dayIso`); every other page
 * renders the shared icon button + picker (the SINGLE icon+color edit
 * entry for every node kind — the curated class icon button and the color
 * dot are gone), the editable title (an embedded render gets the static
 * "open page" link instead), and the tags row. Right-click on the icon or
 * the title reports the pointer position through onHeaderMenu — the host
 * owns the node context menu state. Focus mode suppresses everything but
 * the title; the cover aside renders whenever the page can carry a cover.
 */
export function PageHeaderChrome({
  client,
  page,
  embedded,
  focusMode,
  dayIso,
  headerIcon,
  coverPossible,
  coverAssetId,
  onOpenPage,
  onHeaderMenu,
}: {
  client: AnyClient;
  page: ClientNode;
  embedded: boolean;
  focusMode: boolean;
  /** Day precision of the page's id, null for every non-date page. */
  dayIso: string | null;
  /** The effective icon (own or its classes'), null = the placeholder. */
  headerIcon: string | null;
  coverPossible: boolean;
  coverAssetId: string | null;
  onOpenPage?: ((pageId: string) => void) | undefined;
  /** Opens the page's node context menu at the pointer position. */
  onHeaderMenu: (x: number, y: number) => void;
}) {
  const pageId = page.id;
  /** Icon picker popup anchor + open state (clicking the page icon). */
  const pageIconRef = useRef<HTMLElement | null>(null);
  const [iconPickerOpen, setIconPickerOpen] = useState(false);

  return (
    <div className="page-header-section">
      <header className="nt-page-header">
        <div className="page-header__title-row">
          {dayIso !== null && !embedded ? (
            /* Day pages: the header IS the date header — weekday + Today
               flags above the (dateFormat-aware) title, the ISO week flag
               after it. Right-click keeps the node context menu. */
            <span
              className="nt-page-title-wrap"
              onContextMenu={(event) => {
                event.preventDefault();
                onHeaderMenu(event.clientX, event.clientY);
              }}
            >
              <DayPageHeader iso={dayIso} title={displayNameForSettings(page)} />
            </span>
          ) : (
            <>
            {!focusMode &&
              (
                <>
                  <span
                    className="page-icon-btn"
                    title="Page icon (click: change icon)"
                    ref={pageIconRef}
                    onClick={() => {
                      if (!embedded) setIconPickerOpen((open) => !open);
                    }}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      onHeaderMenu(event.clientX, event.clientY);
                    }}
                  >
                    {headerIcon !== null ? (
                      <Icon path={headerIcon} size={1.4} className="page-icon-large" />
                    ) : (
                      <span className="page-icon-placeholder">◈</span>
                    )}
                  </span>
                  {iconPickerOpen && (
                    <IconPickerPopup
                      value={page.icon ?? undefined}
                      anchorEl={pageIconRef.current}
                      color={page.color}
                      onSelect={(iconValue) => {
                        // "" clears (Icon treats empty as no icon).
                        void client.updateObject(pageId, { icon: iconValue });
                      }}
                      onColorChange={(color) => {
                        // The single icon+color entry: null = "No
                        // color" (object.update color:null clears).
                        void client.updateObject(pageId, { color });
                      }}
                      onClose={() => setIconPickerOpen(false)}
                    />
                  )}
                </>
              )}
            {/* Right-click anywhere on the title (not just the icon) opens the
                page's node context menu — the browser menu is never the
                honest surface for a node. */}
            <span
              className="nt-page-title-wrap"
              onContextMenu={(event) => {
                event.preventDefault();
                onHeaderMenu(event.clientX, event.clientY);
              }}
            >
            {embedded ? (
              <button
                type="button"
                className="nt-page-title-link"
                title="Open page"
                onClick={() => onOpenPage?.(pageId)}
              >
                {displayNameForSettings(page)}
              </button>
            ) : (
              <TitleEditor page={page} />
            )}
            </span>
              </>
          )}
        </div>
        {!embedded && !focusMode && (
          <TagsRow client={client} nodeId={pageId} tagIds={page.tagIds} onOpenPage={onOpenPage} />
        )}
      </header>
      {coverPossible && !focusMode && (
        <aside className="page-header-section__cover">
          <CoverCard client={client} pageId={pageId} assetId={coverAssetId} />
        </aside>
      )}
    </div>
  );
}

/**
 * PageFooterChrome — the card-bottom wrapper: the word count + the
 * Created/Updated day-page stamps (PageFooter — the
 * defined bottom divider of the node view). Null for embedded renders and
 * focus mode: the chrome steps aside, the body stays.
 */
export function PageFooterChrome({
  client,
  page,
  tree,
  onOpenNode,
  embedded,
  focusMode,
}: {
  client: AnyClient;
  page: ClientNode;
  tree: BlockTreeNode[];
  onOpenNode: ((nodeId: string) => void) | undefined;
  embedded: boolean;
  focusMode: boolean;
}) {
  if (embedded || focusMode) return null;
  return <PageFooter client={client} page={page} tree={tree} onOpenNode={onOpenNode} />;
}
