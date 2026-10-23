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
 * is now THREE columns — context · NodeView · properties (the swap owner
 * 2026-10-23; PageView owns the grid and records the rationale). The context
 * column
 * hosts LocalGraphCard, TocSection, the Activity section (relocated), and
 * CommentsSection. The dedupe check (the layout precondition):
 * the right rail's ReferencesSection and the page's own Backlinks section
 * both rendered getLinkedReferences — the SAME data — so the rail's
 * ReferencesSection is deleted (its lazy contract lived in the now-removed
 * component); the Backlinks section stays the one home in the SectionStack
 * — a normal NodeCollection section since the tab strip's retirement
 * (owner 2026-10-09). One home, no duplication.
 */

import { useRef, useState, type ReactNode } from "react";

import type { WorkerClient } from "@/core/worker-client.js";
import type { BlockTreeNode, ClientNode, WorkspaceClient } from "@/core/workspace-client/index.js";

import { DayPageHeader } from "../features/calendar/DayPageHeader.js";
import { ClassesRow, TagsRow } from "../features/metadata/index.js";
import { AliasNodePicker } from "../features/metadata/AliasNodePicker.js";
import { IconPickerPopup } from "../features/icon-picker/IconPickerPopup.js";
import { BannerCard, CoverCard } from "../features/page-sections/PageBanner.js";
import { PageFooter } from "../features/page-sections/PageFooter.js";
import { BlockRow } from "./BlockRow.js";
import { Icon } from "./Icon.js";
import { AddPill } from "../components/ui/fleet/AddPill.js";
import { Button } from "../components/ui/fleet/Button.js";
import { TextField } from "../components/ui/fleet/TextField.js";
import { nodeDisplayName, displayNameFromClient } from "./dateDisplay.js";

type AnyClient = WorkspaceClient | WorkerClient;

/**
 * NodeTopbar — the panelled main layout's pinned top row, spanning the
 * WHOLE card above the column split (owner 2026-10-09): the context
 * collapse toggle and the classes pills on the left; on the right the
 * host's blocks view switcher, the condensed layer's condense-all reset
 * (the layer TOGGLE lives in the app TopBar + palette — owner directive
 * 2026-10-15, one surface per action), the properties
 * collapse toggle, and the "…" node menu. Each panel toggle sits in the
 * cluster above the column it reveals — the context toggle top-left, the
 * properties toggle top-right (the owner 2026-10-23 swap moved the
 * columns; the toggles followed). The divider
 * border under the row retired (owner 2026-10-13) — the spacing-3 margin
 * below the bar is its whole separation from the columns. Full-width so
 * the bar never rescales when a panel column shows or hides. Focus mode
 * (#12) keeps the bar but hides BOTH panel toggles and the classes pills —
 * the toggles would control panels the mode hides, and the classes are
 * exactly the chrome it suppresses; the view switcher + the node menu stay
 * (the page is still a working surface).
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
  condensedChrome,
  chromeMenu,
  onOpenPage,
  focusMode = false,
  /**
   * The classes-cluster override: the class variant's corner renders the
   * extends relation's ClassPillsList (the cornerPills config) instead of
   * the default instance-of ClassesRow — same override the compact corner
   * branch applies (owner 2026-10-12, the class variant joined the
   * panelled layout).
   */
  classesCorner,
}: {
  client: AnyClient;
  nodeId: string;
  classIds: string[];
  sidePanelCollapsed: boolean;
  onToggleSidePanel: () => void;
  contextPanelCollapsed: boolean;
  /**
   * The context-panel toggle; UNDEFINED hides the button (kept for hosts
   * that render no context column — focus mode hides the column, so the
   * host passes undefined while it is on).
   */
  onToggleContextPanel?: (() => void) | undefined;
  chromeModes: ReactNode;
  /**
   * The condensed layer's chrome (owner 2026-10-15): the layer toggle beside
   * the view switcher + the condense-all reset, composed by the host
   * (PageView). Undefined renders nothing — surfaces without the toggle
   * (embedded feeds, the preview seam) pass none.
   */
  condensedChrome?: ReactNode;
  chromeMenu: ReactNode;
  onOpenPage?: ((pageId: string) => void) | undefined;
  /** Classes-cluster override (the class variant's extends pills). */
  classesCorner?: ReactNode;
  /** Focus mode (#12): hides both panel toggles and the classes pills —
   *  the panels are hidden and the classes are the suppressed chrome; the
   *  view switcher + node menu render untouched. */
  focusMode?: boolean;
}) {
  return (
    <div className="nt-node-topbar">
      {!focusMode && (
        <>
          {onToggleContextPanel !== undefined && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              icon="mdi mdi-information-outline"
              aria-label={contextPanelCollapsed ? "Show context panel" : "Hide context panel"}
              aria-pressed={!contextPanelCollapsed}
              title={contextPanelCollapsed ? "Show context panel" : "Hide context panel"}
              active={!contextPanelCollapsed}
              onClick={onToggleContextPanel}
            />
          )}
          <div className="nt-node-topbar__classes">
            {classesCorner ?? (
              <ClassesRow client={client} nodeId={nodeId} classIds={classIds} onOpenPage={onOpenPage} />
            )}
          </div>
        </>
      )}
      <span className="nt-node-topbar__spacer" aria-hidden="true" />
      <div className="nt-node-topbar__right">
        {chromeModes}
        {condensedChrome}
        {!focusMode && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            icon="mdi mdi-format-list-bulleted"
            aria-label={sidePanelCollapsed ? "Show properties panel" : "Hide properties panel"}
            aria-pressed={!sidePanelCollapsed}
            title={sidePanelCollapsed ? "Show properties panel" : "Hide properties panel"}
            active={!sidePanelCollapsed}
            onClick={onToggleSidePanel}
          />
        )}
        {chromeMenu}
      </div>
    </div>
  );
}

/**
 * PageHeaderChrome — the .page-header-section: the header proper
 * beside the cover card aside. Day pages render the DayPageHeader as the
 * whole title row (driven by the variant's `dayIso`); every other page
 * renders the shared title BlockRow (the shared row machinery over the page
 * node itself — an embedded render gets a plain heading title plus an
 * explicit "Open page" button instead), and the tags row. Right-click on the icon or the title reports
 * the pointer position through onHeaderMenu — the host owns the node context
 * menu state. Focus mode suppresses everything but the title; the cover
 * aside renders whenever the page can carry a cover. The full-width banner
 * (the `bannerAssetId` wire field) renders above the whole header section
 * whenever the page can carry one.
 *
 * The Capacities action row (owner 2026-10-09) rides ABOVE the title on the
 * main surface: "Add icon" opens the shared icon+color picker (anchored at
 * the row button, or at the icon element when one is defined), "Add
 * description" swaps in the subtitle editor, "Add aliases" opens the shared
 * backward-write alias picker. The icon element renders ONLY when an icon is
 * DEFINED (own or a class-contributed one — no generic-default fallback, no
 * hover placeholder); the description subtitle hides the same way when
 * empty, and edits inline (Enter/blur commits, Esc cancels, empty clears).
 * Every action RETIRES once its gap is filled (owner 2026-10-09): Add icon
 * hides when an icon is defined, Add description when a subtitle exists,
 * Add aliases when the page has an alias — all three set, the whole row is
 * gone. Day pages skip the row and the subtitle (the DayPageHeader contract).
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
  onHeaderMenu,
}: {
  client: AnyClient;
  page: ClientNode;
  embedded: boolean;
  focusMode: boolean;
  /**
   * Preview surface (the hover preview's NodeView): the header renders —
   * icon, title, tags — but never edits: no icon picker, the title row is
   * read-only (a click navigates), the tags machinery and the context menu
   * stay shut. A trampoline, not an editor.
   */
  preview?: boolean;
  /** Day precision of the page's id, null for every non-date page. */
  dayIso: string | null;
  /** The DEFINED icon (own or a class-contributed one) — null hides the
   * icon element entirely (no generic-default fallback, no placeholder). */
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
  /** Opens the page's node context menu at the pointer position. */
  onHeaderMenu: (x: number, y: number) => void;
}) {
  const pageId = page.id;
  /**
   * Icon picker popup anchor + open state: the element that opened it (the
   * page icon when one is defined, else the action row's "Add icon" button).
   */
  const [iconPickerAnchor, setIconPickerAnchor] = useState<HTMLElement | null>(null);
  /** Alias picker popup (the action row's "Add aliases" button). */
  const aliasButtonRef = useRef<HTMLButtonElement | null>(null);
  const [aliasPickerOpen, setAliasPickerOpen] = useState(false);
  /** Description subtitle editor (the "Add description" action / click-edit). */
  const [descriptionEditing, setDescriptionEditing] = useState(false);
  const description =
    page.description !== null && page.description.trim() !== "" ? page.description : null;

  const commitDescription = (value: string): void => {
    const trimmed = value.trim();
    void client.updateObject(pageId, { description: trimmed === "" ? null : trimmed });
    setDescriptionEditing(false);
  };

  /** The Capacities action row + the subtitle ride the main surface only. */
  const chromeActions = !embedded && !focusMode && !preview && dayIso === null;
  /**
   * Each action fills a gap and retires once filled: the icon action hides
   * when an icon is defined (the icon element becomes the picker entry), the
   * description action when a subtitle exists, the aliases action when the
   * page has at least one alias (the metadata panel's row is the entry then).
   * All three set → the whole row disappears.
   */
  const hasAliases = client.aliasNodesOf(pageId).length > 0;
  /** The row itself hides once every gap is filled — an empty row is chrome
   * for nothing. */
  const showActionsRow = headerIcon === null || description === null || !hasAliases;

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
        {/* The Capacities action row: the page's quiet affordances above the
            title. Every action fills a gap and retires once filled — "Add
            icon" opens the shared icon+color picker (anchored at the row
            button; the icon element takes over as the entry once defined),
            "Add description" swaps in the subtitle editor, "Add aliases"
            opens the shared backward-write alias picker. */}
        {chromeActions && showActionsRow && (
          <div className="page-header-actions">
            {headerIcon === null && (
              <AddPill
                label="Add icon"
                icon="mdi mdi-shape-plus-outline"
                onClick={(element) =>
                  setIconPickerAnchor((anchor) =>
                    anchor === null ? element : null,
                  )
                }
              />
            )}
            {description === null && (
              <AddPill
                label="Add description"
                icon="mdi mdi-text-short"
                onClick={() => setDescriptionEditing(true)}
              />
            )}
            {!hasAliases && (
              <AddPill
                label="Add aliases"
                icon="mdi mdi-link-variant-plus"
                ref={aliasButtonRef}
                aria-expanded={aliasPickerOpen}
                onClick={() => setAliasPickerOpen(true)}
              />
            )}
          </div>
        )}
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
              <DayPageHeader iso={dayIso} title={nodeDisplayName(page)} />
            </span>
          ) : (
            <>
            {!focusMode && headerIcon !== null && (
                  <span
                    className="page-icon-btn"
                    title="Page icon (click: change icon)"
                    onClick={(event) => {
                      if (!embedded && !preview) {
                        setIconPickerAnchor((anchor) =>
                          anchor === null ? event.currentTarget : null,
                        );
                      }
                    }}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      if (!preview) onHeaderMenu(event.clientX, event.clientY);
                    }}
                  >
                    <Icon path={headerIcon} size={1.4} className="page-icon-large" />
                  </span>
            )}
            {/* The whole title row is the click-to-edit target, like a block
                row: the CSS stretches .nt-page-title-wrap over the row's free
                width, so .nt-title-content's click handler covers the words
                AND the empty space beside them (the icon keeps its picker
                click). Right-click anywhere on the title (not just the icon)
                opens the page's node context menu — the browser menu is never
                the honest surface for a node. The preview surface suppresses
                the menu (no machinery in a trampoline). */}
            <span
              className="nt-page-title-wrap"
              onContextMenu={(event) => {
                event.preventDefault();
                if (!preview) onHeaderMenu(event.clientX, event.clientY);
              }}
            >
            {embedded ? (
              /* The feed title is a plain heading, not a link:
                 navigation rides the explicit "Open page" ghost
                 button beside it (owner 2026-10-22 — the headline
                 hover overlay read as noise; the button reveals on
                 title-row hover, JournalsView.css, and stays always
                 visible for touch + keyboard focus). */
              <span className="nt-page-title-embed">
                <span className="nt-page-title-embed__text">
                  {nodeDisplayName(page)}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  icon="mdi-arrow-right"
                  aria-label="Open page"
                  title="Open page"
                  className="nt-page-title-embed__open"
                  onClick={() => onOpenPage?.(pageId)}
                />
              </span>
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
              </>
          )}
        </div>
        {/* The page subtitle (the `description` wire node field): renders
            only when non-empty; a click swaps in the editor (Enter/blur
            commits, Esc cancels, an empty commit clears the field). */}
        {chromeActions && description !== null && !descriptionEditing && (
          <p
            className="page-header-description"
            title="Description (click: edit)"
            onClick={() => setDescriptionEditing(true)}
          >
            {description}
          </p>
        )}
        {chromeActions && descriptionEditing && (
          <TextField
            autoFocus
            size="sm"
            className="page-header-description-input"
            defaultValue={description ?? ""}
            placeholder="Add a description…"
            aria-label="Page description"
            onKeyDown={(event) => {
              if (event.key === "Enter") commitDescription(event.currentTarget.value);
              if (event.key === "Escape") setDescriptionEditing(false);
            }}
            onBlur={(event) => commitDescription(event.currentTarget.value)}
          />
        )}
        {iconPickerAnchor !== null && !focusMode && (
          <IconPickerPopup
            value={page.icon ?? undefined}
            anchorEl={iconPickerAnchor}
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
            onClose={() => setIconPickerAnchor(null)}
          />
        )}
        {aliasPickerOpen && (
          <AliasNodePicker
            client={client}
            nodeId={pageId}
            anchorEl={aliasButtonRef.current}
            onClose={() => setAliasPickerOpen(false)}
          />
        )}
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
 * PageFooterChrome — the word-count + Created/Updated day-page stamps
 * (PageFooter). Where it rides depends on the layout (owner 2026-10-09):
 * the panelled main layout hosts it as the CONTEXT column's bottom
 * section (the card-bottom bar retired); compact layouts keep it at the
 * card bottom. Null for embedded renders and focus mode: the chrome steps
 * aside, the body stays.
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
