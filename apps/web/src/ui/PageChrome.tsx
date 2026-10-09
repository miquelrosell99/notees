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
import { BannerCard, CoverCard } from "./components/PageBanner.js";
import { AliasesButton } from "./components/AliasesButton.js";
import { PageFooter } from "./components/PageFooter.js";
import { BlockRow } from "./BlockRow.js";
import { Icon } from "./Icon.js";
import { Button } from "./components/ui/Button.js";
import { displayNameForSettings, displayNameFromClient } from "./dateDisplay.js";

type AnyClient = WorkspaceClient | WorkerClient;

/**
 * NodeTopbar — the panelled main layout's pinned top row, spanning the
 * WHOLE card above the column split (owner 2026-10-09): the properties
 * collapse toggle and the classes pills on the left; on the right the
 * host's blocks view switcher, the context collapse toggle, and the "…"
 * node menu — in that order, over a full-width divider border like the
 * sidebar's. Full-width so the bar never rescales when a panel column
 * shows or hides; each panel toggle sits directly above the column it
 * reveals.
 */
export function NodeTopbar({
  client,
  nodeId,
  classIds,
  sidePanelCollapsed,
  onToggleSidePanel,
  contextPanelCollapsed,
  onToggleContextPanel,
  chromeModes,
  chromeMenu,
  onOpenPage,
}: {
  client: AnyClient;
  nodeId: string;
  classIds: string[];
  sidePanelCollapsed: boolean;
  onToggleSidePanel: () => void;
  contextPanelCollapsed: boolean;
  onToggleContextPanel: () => void;
  chromeModes: ReactNode;
  chromeMenu: ReactNode;
  onOpenPage?: ((pageId: string) => void) | undefined;
}) {
  return (
    <div className="nt-node-topbar">
      <Button
        type="button"
        variant="outline"
        size="sm"
        icon="mdi mdi-format-list-bulleted"
        aria-label={sidePanelCollapsed ? "Show properties panel" : "Hide properties panel"}
        aria-pressed={!sidePanelCollapsed}
        title={sidePanelCollapsed ? "Show properties panel" : "Hide properties panel"}
        active={!sidePanelCollapsed}
        onClick={onToggleSidePanel}
      />
      <div className="nt-node-topbar__classes">
        <ClassesRow client={client} nodeId={nodeId} classIds={classIds} onOpenPage={onOpenPage} />
      </div>
      <span className="nt-node-topbar__spacer" aria-hidden="true" />
      <div className="nt-node-topbar__right">
        {chromeModes}
        <Button
          type="button"
          variant="outline"
          size="sm"
          icon="mdi mdi-information-outline"
          aria-label={contextPanelCollapsed ? "Show context panel" : "Hide context panel"}
          aria-pressed={!contextPanelCollapsed}
          title={contextPanelCollapsed ? "Show context panel" : "Hide context panel"}
          active={!contextPanelCollapsed}
          onClick={onToggleContextPanel}
        />
        {chromeMenu}
      </div>
    </div>
  );
}

/**
 * PageHeaderChrome — the .page-header-section: the header proper
 * beside the cover card aside. Day pages render the DayPageHeader as the
 * whole title row (driven by the variant's `dayIso`); every other page
 * renders the shared icon button + picker (the SINGLE icon+color edit
 * entry for every node kind — the curated class icon button and the color
 * dot are gone), the bullet-less title BlockRow (the shared row machinery
 * over the page node itself — an embedded render gets the static
 * "open page" link instead), and the tags row. Right-click on the icon or
 * the title reports the pointer position through onHeaderMenu — the host
 * owns the node context menu state. Focus mode suppresses everything but
 * the title; the cover aside renders whenever the page can carry a cover.
 * The full-width banner (the `bannerAssetId` wire field) renders above the
 * whole header section whenever the page can carry one; the title row
 * carries the aliases affordance (every page whose alias-terminal is this
 * page, listed + added from the ALIASED node's own row).
 */
export function PageHeaderChrome({
  client,
  page,
  embedded,
  focusMode,
  preview = false,
  dayIso,
  headerIcon,
  bannerPossible,
  bannerAssetId,
  onBannerUploadRequest,
  coverPossible,
  coverAssetId,
  onOpenPage,
  onOpenPageRaw,
  onHeaderMenu,
}: {
  client: AnyClient;
  page: ClientNode;
  embedded: boolean;
  focusMode: boolean;
  /**
   * Preview surface (the hover preview's NodeView): the header renders —
   * icon, title, tags — but never edits: no icon picker, the title row is
   * read-only (a click navigates), the aliases/tags machinery and the
   * context menu stay shut. A trampoline, not an editor.
   */
  preview?: boolean;
  /** Day precision of the page's id, null for every non-date page. */
  dayIso: string | null;
  /** The effective icon (own or its classes'), null = the placeholder. */
  headerIcon: string | null;
  /** The page can carry the banner wire field (set or empty). */
  bannerPossible: boolean;
  /** The banner's asset node id (the wire field), null when unset. */
  bannerAssetId: string | null;
  /** The host-owned banner upload modal opener (the banner's Add/Change). */
  onBannerUploadRequest: () => void;
  coverPossible: boolean;
  coverAssetId: string | null;
  onOpenPage?: ((pageId: string) => void) | undefined;
  /**
   * The RAW page open (no alias redirect): the aliases UI's NAVIGATE opens
   * an alias node's OWN view through this. Defaults to onOpenPage.
   */
  onOpenPageRaw?: ((pageId: string) => void) | undefined;
  /** Opens the page's node context menu at the pointer position. */
  onHeaderMenu: (x: number, y: number) => void;
}) {
  const pageId = page.id;
  /** Icon picker popup anchor + open state (clicking the page icon). */
  const pageIconRef = useRef<HTMLElement | null>(null);
  const [iconPickerOpen, setIconPickerOpen] = useState(false);

  return (
    <>
      {bannerPossible && !focusMode && (
        <BannerCard
          client={client}
          pageId={pageId}
          assetId={bannerAssetId}
          onUploadRequest={onBannerUploadRequest}
        />
      )}
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
                if (!preview) onHeaderMenu(event.clientX, event.clientY);
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
                      if (!embedded && !preview) setIconPickerOpen((open) => !open);
                    }}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      if (!preview) onHeaderMenu(event.clientX, event.clientY);
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
                honest surface for a node. The preview surface suppresses
                the menu (no machinery in a trampoline). */}
            <span
              className="nt-page-title-wrap"
              onContextMenu={(event) => {
                event.preventDefault();
                if (!preview) onHeaderMenu(event.clientX, event.clientY);
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
              /* The title is a bullet-less BlockRow over the page node itself
                 (no children — the body tree stays the separate collection
                 below): display renders the content's inline tokens (links,
                 mentions), a click swaps in the full block editor. The
                 preview surface passes readOnly — the click navigates to the
                 full view instead (the trampoline contract). */
              <BlockRow
                variant="title"
                tree={{ node: page, children: [] }}
                client={client}
                resolveName={(id) => displayNameFromClient(client, id)}
                readOnly={preview}
              />
            )}
            </span>
            {/* The aliases affordance: every page whose alias-terminal is
                this page, listed + added from the ALIASED node's own title
                row (null chrome for embedded/focus/preview renders). */}
            {!embedded && !focusMode && !preview && (
              <AliasesButton
                client={client}
                nodeId={pageId}
                onOpenPageRaw={(id) => (onOpenPageRaw ?? onOpenPage)?.(id)}
              />
            )}
              </>
          )}
        </div>
        {/* Tags: navigational chips on the preview surface; the add/remove
            machinery (the picker + the unassign ×) stays main-surface-only. */}
        {!embedded && !focusMode && !preview && (
          <TagsRow client={client} nodeId={pageId} tagIds={page.tagIds} onOpenPage={onOpenPage} />
        )}
      </header>
      {coverPossible && !focusMode && (
        <aside className="page-header-section__cover">
          <CoverCard client={client} pageId={pageId} assetId={coverAssetId} />
        </aside>
      )}
    </div>
    </>
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
