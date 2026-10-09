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
 * the right rail's ReferencesSection and the page's own Backlinks section
 * both rendered getLinkedReferences — the SAME data — so the rail's
 * ReferencesSection is deleted (its lazy contract lived in the now-removed
 * component); the Backlinks section stays the one home in the SectionStack
 * — a normal NodeCollection section since the tab strip's retirement
 * (owner 2026-10-09). One home, no duplication.
 */

import { useRef, useState, type ReactNode } from "react";

import type { WorkerClient } from "@/core/worker-client.js";
import type { BlockTreeNode, ClientNode, WorkspaceClient } from "@/core/workspace-client.js";

import { DayPageHeader } from "./components/DayPageHeader.js";
import { ClassesRow, TagsRow } from "./components/MetadataSection.js";
import { AliasNodePicker } from "./components/AliasNodePicker.js";
import { IconPickerPopup } from "./components/IconPickerPopup.js";
import { BannerCard, CoverCard } from "./components/PageBanner.js";
import { PageFooter } from "./components/PageFooter.js";
import { BlockRow } from "./BlockRow.js";
import { Icon } from "./Icon.js";
import { Button } from "./components/ui/Button.js";
import { TextField } from "./components/ui/TextField.js";
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
 * renders the shared title BlockRow (the shared row machinery over the page
 * node itself — an embedded render gets the static "open page" link
 * instead), and the tags row. Right-click on the icon or the title reports
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
              <Button
                variant="ghost"
                size="sm"
                icon="mdi mdi-emoticon-outline"
                onClick={(event) =>
                  setIconPickerAnchor((anchor) =>
                    anchor === null ? event.currentTarget : null,
                  )
                }
              >
                Add icon
              </Button>
            )}
            {description === null && (
              <Button
                variant="ghost"
                size="sm"
                icon="mdi mdi-text-short"
                onClick={() => setDescriptionEditing(true)}
              >
                Add description
              </Button>
            )}
            {!hasAliases && (
              <Button
                variant="ghost"
                size="sm"
                icon="mdi mdi-file-multiple-outline"
                ref={aliasButtonRef}
                aria-expanded={aliasPickerOpen}
                onClick={() => setAliasPickerOpen(true)}
              >
                Add aliases
              </Button>
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
              <DayPageHeader iso={dayIso} title={displayNameForSettings(page)} />
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
