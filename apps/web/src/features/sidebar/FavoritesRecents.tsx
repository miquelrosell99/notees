/**
 * FavoritesRecents — the sidebar's Favorites and Recents sections (the
 * lists feature, extracted from Sidebar.tsx owner 2026-10-21).
 *
 * Both sections are cross-device UI state — the server per-user prefs store
 * is the authority, device-local cache offline (see features/settings/
 * nodePrefs.ts). This component owns everything the two lists need: the
 * nodePrefs hook, the live-label re-render subscription, the drag-sortable
 * Favorites rows, the row context menu (SidebarItemMenu), the
 * confirmation-gated Delete, and the shared row markup.
 *
 * Row labels are PLAIN TEXT (owner ruling 2026-10-21): the row is chrome,
 * not content — the label is plainTitleOf (the shared chrome-label
 * derivation: nodeDisplayName + class chips resolved + markdown links
 * reduced to their labels), so mentions, class chips and marks fold into
 * their captured text, markdown links reduce to
 * their label (no hrefs in a row), and nothing inside the label is
 * individually clickable or styled. The row is one
 * button: click opens the node, Shift+click peeks it in the right sidebar,
 * right-click opens the row menu.
 *
 * `sidebarSection` — the collapsible section shell (header + list) — is
 * exported for the shell's Navigation section too; the section styles live
 * in ui/app/Sidebar.css (the nav rows and the list rows share them).
 */

import { useEffect, useState } from "react";

import { SYSTEM_CLASS_UUIDS } from "@notees/domain";

import type { WorkerClient } from "@/core/worker-client.js";
import type { ClientNode, WorkspaceClient } from "@/core/workspace-client/index.js";

import { plainTitleOf } from "../../ui/dateDisplay.js";
import { Icon } from "../../ui/Icon.js";
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

import { nodeIcon } from "../../ui/iconFor.js";
import { untitledLabelOf } from "../../ui/renderStateLabel.js";
import { useNodePrefs, toggleNodeFavorite, reorderNodeFavorites, removeSyncedRecent } from "../settings/nodePrefs.js";
import { SidebarItemMenu, type SidebarItemMenuState } from "../node-menu/SidebarItemMenu.js";
import { ConfirmationModal } from "../../components/ui/fleet/ConfirmationModal.js";
import { readStoredJson, removeRecent, STORAGE_KEYS } from "./recentPages.js";

export type AnyClient = WorkspaceClient | WorkerClient;

/**
 * SortableFavoriteRow — the drag-sortable favorites row (owner 2026-10-12):
 * useSortable owns the <li> (ref, lift transform, pointer/keyboard
 * listeners). The PointerSensor's distance constraint keeps plain clicks
 * (open / star) intact — a drag needs a real 6px travel. The row body is the
 * SAME markup every sidebar row renders (the li wrapper alone is this
 * component's).
 */
function SortableFavoriteRow({
  node,
  onRowMenu,
  children,
}: {
  node: ClientNode;
  onRowMenu: (event: React.MouseEvent<HTMLLIElement>, node: ClientNode) => void;
  children: React.ReactNode;
}) {
  const { listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: node.id,
  });
  // NOTE: dnd-kit's `attributes` are deliberately NOT spread — they stamp
  // role="button" + a tab stop on the li, shadowing the row's real button
  // for assistive tech and queries. Pointer listeners alone drive the drag.
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      {...listeners}
      className={isDragging ? "nt-side-row nt-side-row--dragging" : "nt-side-row"}
      onContextMenu={(event) => onRowMenu(event, node)}
    >
      {children}
    </li>
  );
}

export function FavoritesRecents({
  client,
  selectedPageId,
  onOpenPage,
  onOpenInSidebar,
  collapsedSections,
  onToggleCollapse,
}: {
  client: AnyClient;
  selectedPageId: string | null;
  onOpenPage: (nodeId: string) => void;
  onOpenInSidebar?: ((nodeId: string) => void) | undefined;
  /** The shell owns the collapse map (its Navigation section reads it too). */
  collapsedSections: Record<string, boolean>;
  onToggleCollapse: (title: string) => void;
}) {
  /**
   * Favorites + recents: the shared nodePrefs store — server-side
   * per-user prefs when online, device-local cache offline. The hook
   * subsumes the legacy notees:favorites/notees:recents refresh effect (it
   * listens itself, and every legacy writer's broadcast re-renders us).
   */
  const nodePrefs = useNodePrefs(client);
  const favorites = nodePrefs.favorites;
  const recents = nodePrefs.recents;
  /**
   * Live labels: favorites/recents rows render node content read at render
   * time, so a rename (any client notification) must re-render the lists —
   * the bump re-reads them below.
   */
  const [, setVersion] = useState(0);
  useEffect(() => client.subscribe(() => setVersion((v) => v + 1)), [client]);
  /** Right-click menu over a Favorites/Recents row. */
  const [rowMenu, setRowMenu] = useState<SidebarItemMenuState | null>(null);
  /** Delete confirmation target (lives here so it survives the menu closing). */
  const [deleteTarget, setDeleteTarget] = useState<ClientNode | null>(null);

  const openRow = (id: string): void => {
    // Recents recording lives in App.openPage (the single navigation funnel —
    // breadcrumbs, links and sidebar rows alike); see recentPages.ts.
    onOpenPage(id);
  };

  const toggleFavorite = (id: string): void => {
    // Server-synced through the nodePrefs store (optimistic local write +
    // upward push when online).
    toggleNodeFavorite(client, id);
  };

  // Asset-class nodes are library objects, not pages — out of every list.
  const classes = client.listClasses();
  const assetClassId =
    classes.find((cls) => cls.name === "asset")?.id ?? SYSTEM_CLASS_UUIDS.asset;
  const pages = client.listPages().filter((page) => !page.classIds.includes(assetClassId));
  const byId = new Map<string, ClientNode>([...pages, ...classes].map((node) => [node.id, node]));
  const iconsByClass = client.effectiveClassIcons();
  const rowIconFor = (node: ClientNode): string | null => nodeIcon(node, iconsByClass);
  const favoritePages = favorites
    .map((id) => byId.get(id))
    .filter((node): node is ClientNode => node !== undefined);
  const recentPages = recents
    .map((id) => byId.get(id))
    .filter((node): node is ClientNode => node !== undefined)
    .slice(0, 12);

  /**
   * Row label: PLAIN TEXT (owner ruling 2026-10-21) — plainTitleOf, the
   * shared chrome-label derivation: mentions fold to their captured text,
   * class chips to the class's current name, marks to their words; markdown
   * link spans reduce to their label (the href never reaches a row). The
   * label carries no interactive or styled elements, so the row is one
   * button. Date pages keep the setting-aware display name through the same
   * helper's date branch; empty content falls back to the untitled label.
   */
  const renderRowLabel = (node: ClientNode) => {
    // The plain-text chrome label (owner ruling 2026-10-21): mentions, class
    // chips and marks fold into their words, markdown links reduce to their
    // label, nothing inside the label is clickable or styled — the row is
    // one button. Date pages keep the setting-aware name via the same
    // derivation; empty content falls back to the untitled label. The node
    // is re-read fresh per row (the scope-classed getNode): the listPages
    // pool feeding `byId` is a structure-classed cached read, so a pooled
    // row's own contentAst can be stale after a rename — the title never
    // renders from the pool.
    const fresh = client.getNode(node.id);
    const text = plainTitleOf(fresh ?? node, (classId) => client.getDisplayName(classId));
    return (
      <span className="nt-side-item-label">{text === "" ? untitledLabelOf(node) : text}</span>
    );
  };

  /**
   * Row body — the item button + the star toggle, shared by every sidebar
   * row shape (plain, drag-sortable): the li wrapper alone differs.
   */
  const rowBody = (node: ClientNode, icon?: string | null) => (
    <>
      <button
        type="button"
        className={node.id === selectedPageId ? "nt-side-item nt-side-item-active" : "nt-side-item"}
        onClick={(event) => {
          if (event.shiftKey) {
            onOpenInSidebar?.(node.id);
            return;
          }
          openRow(node.id);
        }}
      >
        {icon !== null && icon !== undefined && (
          <Icon path={icon} size={1} className="nt-side-item-icon" />
        )}
        {renderRowLabel(node)}
        {node.isClass && (
          <span className="nt-side-item-flag" title="Class">
            class
          </span>
        )}
      </button>
      <button
        type="button"
        className="nt-side-star"
        title={favorites.includes(node.id) ? "Remove from favorites" : "Add to favorites"}
        onClick={() => toggleFavorite(node.id)}
      >
        <Icon path={favorites.includes(node.id) ? "mdi-star" : "mdi-star-outline"} size={0.9} />
      </button>
    </>
  );

  /** The row menu claims right-clicks on the row itself. */
  const handleRowContextMenu = (
    event: React.MouseEvent<HTMLLIElement>,
    node: ClientNode,
    list: "favorites" | "recents",
  ) => {
    event.preventDefault();
    setRowMenu({ x: event.clientX, y: event.clientY, node, list });
  };

  const renderRow = (node: ClientNode, icon?: string | null, list?: "favorites" | "recents") => (
    <li
      key={node.id}
      className="nt-side-row"
      onContextMenu={(event) => {
        if (list !== undefined) handleRowContextMenu(event, node, list);
      }}
    >
      {rowBody(node, icon)}
    </li>
  );

  /**
   * Favorites drag sort (owner 2026-10-12): dnd-kit's vertical list sort
   * over the favorites rows; the committed order writes through the
   * nodePrefs store (optimistic + server push — the same channel the star
   * toggle uses).
   */
  const favoriteSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );
  const handleFavoriteDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (over === null || active.id === over.id) return;
    const ordered = arrayMove(
      favoritePages.map((node) => node.id),
      favoritePages.findIndex((node) => node.id === String(active.id)),
      favoritePages.findIndex((node) => node.id === String(over.id)),
    );
    reorderNodeFavorites(client, ordered);
  };

  return (
    <>
      {sidebarSection(
        "Favorites",
        favoritePages.map((node) => (
          <SortableFavoriteRow
            key={node.id}
            node={node}
            onRowMenu={(event, rowNode) => handleRowContextMenu(event, rowNode, "favorites")}
          >
            {rowBody(node, rowIconFor(node))}
          </SortableFavoriteRow>
        )),
        {
          icon: "mdi-star-outline",
          // Always rendered — empty says so plainly (owner 2026-10-12).
          empty: "No favorites yet",
          // The same row UI as Recents (icons via rowIconFor) plus drag
          // sort: the DnD context wraps the list.
          listWrapper: (list) => (
            <DndContext
              sensors={favoriteSensors}
              collisionDetection={closestCenter}
              onDragEnd={handleFavoriteDragEnd}
            >
              <SortableContext
                items={favoritePages.map((node) => node.id)}
                strategy={verticalListSortingStrategy}
              >
                {list}
              </SortableContext>
            </DndContext>
          ),
        },
        collapsedSections,
        onToggleCollapse,
      )}
      {sidebarSection(
        "Recents",
        recentPages.map((node) => renderRow(node, rowIconFor(node), "recents")),
        { scrollable: true },
        collapsedSections,
        onToggleCollapse,
      )}
      {rowMenu !== null && (
        <SidebarItemMenu
          state={rowMenu}
          isFavorited={favorites.includes(rowMenu.node.id)}
          onClose={() => setRowMenu(null)}
          onOpen={(id) => {
            setRowMenu(null);
            openRow(id);
          }}
          onOpenInSidebar={onOpenInSidebar}
          onToggleFavorite={(id) => {
            toggleFavorite(id);
          }}
          onRemoveFromRecents={(id) => {
            removeSyncedRecent(client, id);
          }}
          onRequestDelete={() => {
            setDeleteTarget(rowMenu.node);
            setRowMenu(null);
          }}
        />
      )}
      {deleteTarget !== null && (
        <ConfirmationModal
          isOpen
          variant="danger"
          title="Delete node?"
          message={`"${deleteTarget.id}" and its subtree will be moved to the trash.`}
          confirmLabel="Delete"
          onConfirm={() => {
            const target = deleteTarget;
            setDeleteTarget(null);
            void client.deleteObject(target.id).then(() => {
              // The store notification re-renders the lists (deleted nodes
              // drop out of byId); purge stale list entries too.
              removeRecent(target.id);
              if (readStoredJson(STORAGE_KEYS.favorites).includes(target.id)) {
                toggleFavorite(target.id);
              }
            });
          }}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </>
  );
}

/**
 * The collapsible sidebar section shell (header + list) — shared by the
 * Favorites/Recents lists and the shell's Navigation section. Owned here so
 * both render through one markup; the styles live in ui/app/Sidebar.css.
 */
export function sidebarSection(
  title: string,
  rows: React.ReactNode[],
  options: {
    icon?: string;
    defaultCollapsed?: boolean;
    collapsible?: boolean;
    /** The section's list absorbs the free nav height and scrolls alone —
     * every other sidebar region stays pinned. */
    scrollable?: boolean;
    /** Always-render placeholder when the section is empty (Favorites
     * uses it — owner 2026-10-12); without it an empty section hides. */
    empty?: string;
    /** Wraps the <ul> (the favorites drag-sort's DndContext/SortableContext). */
    listWrapper?: ((list: React.ReactNode) => React.ReactNode) | undefined;
  } = {},
  collapsedSections: Record<string, boolean> = {},
  onToggleCollapse?: (title: string) => void,
) {
  const body =
    rows.length > 0
      ? rows
      : options.empty !== undefined
        ? [<li key="__empty" className="nt-side-empty">{options.empty}</li>]
        : null;
  if (body === null) return null;
  const collapsible = options.collapsible !== false;
  const collapsed = collapsible && collapsedSections[title] === true;
  return (
    <section
      className={options.scrollable ? "nt-side-section nt-side-section--scroll" : "nt-side-section"}
    >
      {collapsible ? (
        <button
          type="button"
          className="nt-side-header nt-side-header-toggle"
          aria-expanded={!collapsed}
          onClick={() => onToggleCollapse?.(title)}
        >
          <Icon
            path={collapsed ? "mdi-chevron-right" : "mdi-chevron-down"}
            size={0.8}
            className="nt-side-header-chevron"
          />
          {options.icon !== undefined && (
            <Icon path={options.icon} size={0.8} className="nt-side-header-icon" />
          )}
          <span>{title}</span>
        </button>
      ) : (
        <h3 className="nt-side-header">
          {options.icon !== undefined && (
            <Icon path={options.icon} size={0.8} className="nt-side-header-icon" />
          )}
          <span>{title}</span>
        </h3>
      )}
      {!collapsed &&
        (options.listWrapper !== undefined ? (
          options.listWrapper(<ul className="nt-side-list">{body}</ul>)
        ) : (
          <ul className="nt-side-list">{body}</ul>
        ))}
    </section>
  );
}
