/**
 * CardsView — cards mode, the v1 node card 1:1 (owner 2026-10-13; the
 * register read from the v1-archive tag: `KanbanCard.tsx` + `CardItem.css`).
 *
 * ONE card shape on every surface (the flat grid, the grouped board, tree
 * contexts):
 *
 *   - the cover slot (no-cover / top / left / right) with its empty-state
 *     Add-cover affordance. For the horizontal layouts the content is a
 *     two-column grid: the cover spans the row stack in its cell AS A CARD
 *     ELEMENT (matted, rounded sub-card; the image fills the mat absolutely
 *     so a portrait stretches the card no more than its rows), and the row
 *     hairlines extend across the cover column via subgrid — the card reads
 *     as ONE surface (owner 2026-10-13);
 *   - the FIRST row: the containing-page breadcrumbs (a parentless node
 *     renders nothing — the row collapses away);
 *   - the title header: the title IS the page-view title — the same
 *     bullet-less BlockRow (variant="title", read-only): the content stream
 *     renders its inline tokens (class links, mentions), a click opens the
 *     node through the card's OutlinerContext (the page header's trampoline
 *     contract), and a RIGHT-CLICK opens the node's context menu (the v1
 *     context-menu register; the menu button is gone — the selection checkbox
 *     is the card's only hover chrome). Document-chrome nodes carry text-only
 *     titles (the store's flatten invariant), so rich chips ride block
 *     members' cards;
 *   - the classes row, the tags row, and the property rows (in that order —
 *     owner 2026-10-13): their own hairline-separated rows (the dividers are
 *     the owner's refinement; v1's rows were bare). The classes row is the
 *     nodeview bar's interactive class list (NodePills) and the tags row the
 *     page header's TagsRow composition (label hidden) — classes and tags are
 *     ADDABLE from the card (date nodes stay locked, the ClassesRow rule).
 *     The properties section: a row per property, label | value in two
 *     columns (the table-row register) — the container's cardProperties, or
 *     EVERY effective property with a non-empty display text when none are
 *     named (the v1 register);
 *   - the content row: the node's child blocks under a header bar (collapse
 *     chevron + "Content"), ALWAYS resolved (owner 2026-10-13): attached
 *     `children` win (tree contexts); flat collections resolve them from the
 *     client per card. Cards ignore the tree/maxDepth prop family on purpose.
 *     Collapsed by default — the chevron shows the content on demand; the
 *     collapsed body unmounts (no dead rows on a deep subtree).
 *
 * Editing split (owner 2026-10-13): classes and tags are editable on the
 * card; the title, properties, and child blocks stay read-only — the outline
 * mode remains the editing surface for content (the v2 cards grammar).
 *
 * The top-level card set is windowed (the shared useWindowed +
 * ShowMoreButton convention) — the grid renders the loaded window and names
 * the remaining count at its end. Selection-export checkboxes ride the flat
 * node sets (tree contexts stay chrome-less, the established contract).
 *
 * SORT (owner 2026-10-13): the flat grid carries the sort button (the
 * table's mdi-sort control, generalized) — a small panel offering Last
 * edited (the default: `updatedAt`, newest first) and Name A–Z; the resort
 * re-narrows the window. Tree contexts and the grouped board hide the
 * button — the content order and the property columns respectively own
 * their order there.
 */

import { useEffect, useMemo, useState, useContext } from "react";
import { createPortal } from "react-dom";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";

import { parseDateNodeId, rendersWithDocumentChrome, SYSTEM_CLASS_UUIDS } from "@notees/domain";

import { Icon } from "../Icon.js";
import { BlockRow } from "../BlockRow.js";
import { displayNameForSettings, displayNameFromClient } from "../dateDisplay.js";
import { OutlinerContext, useOutlinerValue } from "../outliner-context.js";
import { SelectionButton, Checkbox, ImageModal, SortMenuButton, type SortMenuOption } from "../components/ui/index.js";
import { registerView } from "./registry.js";
import { useWindowed } from "./useWindowed.js";
import { useViewChromeTarget } from "./viewChrome.js";import { useLazyInView } from "./useLazyInView.js";
import { ShowMoreButton } from "./ShowMoreButton.js";
import { compareItemsByEditDate, compareItemsByMode } from "./collectionSort.js";
import { propertyDisplayText } from "./propertyDisplay.js";
import { assetImageUrl, cardImageAssetId } from "./assetThumbs.js";
import { isCoverAsset, setNodeCover } from "../components/coverProperty.js";
import { AssetUploadModal } from "../components/modals/AssetUploadModal.js";
import { notificationStore } from "../components/ui/notificationStore.js";
import { Badge } from "../components/ui/Badge.js";
import { Breadcrumbs } from "../components/Breadcrumbs.js";
import { NodeMenuButton } from "../components/NodeMenuButton.js";
import { NodePills } from "../components/NodePills.js";
import { NodeContextMenu } from "../components/NodeContextMenu.js";
import { TagsRow } from "../components/MetadataSection.js";
import { childQuery } from "../components/childQuery.js";
import { useCardLayoutPreference } from "../viewPrefs.js";
import { CardsBoard } from "./CardsBoard.js";
import { useViewSelection, SelectionExportControls } from "./selectionExport.js";
import type { CardLayout, NodeCollectionItem, NodeCollectionProps, SortMode } from "./types.js";
import "./CardsView.css";

function toBlockTree(item: NodeCollectionItem): import("@/core/workspace-client.js").BlockTreeNode {
  return { node: item.node, children: (item.children ?? []).map(toBlockTree) };
}

/**
 * The card cover image: the LIST renders instantly — every card
 * under a cover layout shows its imagery placeholder; the expensive fetch
 * (full bytes → data URL → decode) starts only when the card nears the
 * viewport (useLazyInView), and the loaded image clicks open into the
 * ImageModal lightbox (the AssetImage pattern: download + fullscreen +
 * Esc).
 *
 * The layout prop is the gate, not a cosmetic switch: "no-cover" renders
 * nothing AND skips the lazy fetch (no placeholder, no observation, no
 * bytes) — the card is text-only, as the CoverLayoutToggle advertises.
 *
 * The slot is ALSO the empty-state surface (owner 2026-10-13): under a
 * cover layout the slot renders even when the node has no cover — the
 * "Add cover" affordance (the CoverCard precedent) opens the
 * image-only AssetUploadModal and the uploaded asset node becomes the
 * cover (setNodeCover — the coverAssetId wire field). Asset-classed nodes
 * never hit it: their imagery is their own bytes.
 */
function CardCover({ item, props, layout }: { item: NodeCollectionItem; props: NodeCollectionProps; layout: CardLayout }) {
  const client = props.client;
  const assetId = cardImageAssetId(item.node);
  const [sentinelRef, inView] = useLazyInView<HTMLElement>();
  const [url, setUrl] = useState<string | null>(null);
  const [zoomOpen, setZoomOpen] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const coverEnabled = layout !== "no-cover";

  useEffect(() => {
    let cancelled = false;
    setUrl(null);
    if (!coverEnabled || !inView || assetId === null) return;
    void assetImageUrl(client, assetId).then((resolved) => {
      if (!cancelled) setUrl(resolved);
    });
    return () => {
      cancelled = true;
    };
  }, [coverEnabled, inView, assetId, client]);

  if (!coverEnabled) return null;
  if (assetId === null) {
    return (
      <>
        <button
          type="button"
          className="node-card__cover node-card__cover--empty"
          aria-label={`Add cover image to ${displayNameForSettings(item.node) || "Untitled"}`}
          title="Add cover image"
          onClick={(event) => {
            event.stopPropagation();
            setUploadOpen(true);
          }}
        >
          <Icon path="mdi-image-plus" size={0.9} />
          <span>Add cover</span>
        </button>
        {uploadOpen && (
          <AssetUploadModal
            isOpen
            client={client}
            assetClassId={SYSTEM_CLASS_UUIDS.asset}
            accept="image/jpeg,image/png,image/webp"
            onClose={() => setUploadOpen(false)}
            onUploaded={(assetNodeId) => {
              setUploadOpen(false);
              setNodeCover(client, item.node.id, assetNodeId).catch((err: unknown) => {
                notificationStore.error(
                  "Couldn't set the cover",
                  err instanceof Error ? err.message : String(err),
                );
              });
            }}
          />
        )}
      </>
    );
  }
  if (url === null) {
    // Placeholder keeps the layout slot (same class family, no bytes yet).
    return (
      <div
        ref={sentinelRef as React.RefCallback<HTMLDivElement>}
        className="node-card__cover node-card__cover--pending"
        aria-hidden="true"
      />
    );
  }
  const assetName = client.getAssetInfo(assetId)?.originalName ?? undefined;
  return (
    <>
      <button
        type="button"
        ref={sentinelRef as React.RefCallback<HTMLButtonElement>}
        className="node-card__cover node-card__cover--button"
        title={assetName !== undefined ? `${assetName} (click to view full size)` : "View full size"}
        aria-label={assetName !== undefined ? `View ${assetName} full size` : "View image full size"}
        onClick={(event) => {
          event.stopPropagation();
          setZoomOpen(true);
        }}
      >
        <img src={url} alt="" loading="lazy" decoding="async" draggable="false" />
      </button>
      {zoomOpen && (
        <ImageModal
          isOpen
          onClose={() => setZoomOpen(false)}
          src={url}
          filename={assetName}
          alt={assetName ?? ""}
        />
      )}
    </>
  );
}

/**
 * One node card — the flat grid's card AND the grouped board's card body
 * (the v1 NodeCard register, read-only adaptation; see the file header).
 * Child blocks: attached `children` win (tree contexts); a flat collection
 * resolves them from the client — cards ALWAYS show content, ignoring the
 * tree/maxDepth prop family (owner 2026-10-13).
 */
export function NodeCard({
  item,
  props,
  coverLayout = "no-cover",
  selection,
}: {
  item: NodeCollectionItem;
  props: NodeCollectionProps;
  coverLayout?: CardLayout;
  /**
   * selection export: when present, a checkbox rides the card's top
   * corner and the card highlights while checked. Absent = no selection
   * chrome (tree cards, surfaces that opt out).
   */
  selection?: { checked: boolean; onToggle: () => void } | undefined;
}) {
  const { client, onNodeClick, cardProperties, propertiesOf } = props;
  const label = displayNameForSettings(item.node) || "Untitled";
  const resolveName = (id: string) => displayNameFromClient(client, id);
  const openNode = (id: string) => onNodeClick?.(id);
  /** The title's right-click menu (owner 2026-10-13) — position-only state. */
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  /**
   * The body set: the item's attached children when the container built a
   * tree, else the client's live child blocks (comments cut — the childQuery
   * contract). The memo keys on the item identity: a selection toggle or a
   * chrome re-render does not re-walk the tree, a section re-resolution
   * (fresh item) does.
   */
  const childItems = useMemo(
    () => item.children ?? childQuery(client, item.node.id),
    [item, client],
  );
  /** The body collapse — display state, COLLAPSED by default (the v1 register; the owner refinement 2026-10-13). */
  const [bodyCollapsed, setBodyCollapsed] = useState(true);
  /**
   * The classes/tags rows are editable (owner 2026-10-13 — the nodeview
   * bar's elements), except on date nodes: parent-locked and class-locked
   * (SCHEMA.md "Datetime"), the ClassesRow lock rule.
   */
  const metadataLocked = parseDateNodeId(item.node.id) !== null;
  /**
   * The property rows. Scoped (the container names cardProperties — the
   * classed-nodes section passes its bound columns): EVERY named schema rides
   * in order, and a bound-but-unset property (no authored value, no default —
   * the effective read emits no row for it) still shows as an EMPTY field
   * (owner 2026-10-13: the class's full column set on every member card, like
   * the table). Unscoped (the v1 default): every effective property with a
   * non-empty display text.
   */
  const properties = propertiesOf?.(item.node.id) ?? [];
  const cardRows: Array<{ key: string; name: string; text: string }> =
    cardProperties !== undefined
      ? cardProperties.map((schemaId) => {
          const prop = properties.find((p) => p.propertySchemaId === schemaId);
          if (prop === undefined) {
            const schema = client.listPropertySchemas().find((s) => s.id === schemaId);
            return { key: schemaId, name: schema?.name ?? "Property", text: "" };
          }
          return {
            key: schemaId,
            name: prop.schema?.name ?? "Property",
            text: propertyDisplayText(client, prop),
          };
        })
      : properties
          .filter((prop) => propertyDisplayText(client, prop) !== "")
          .map((prop) => ({
            key: prop.propertySchemaId,
            name: prop.schema?.name ?? "Property",
            text: propertyDisplayText(client, prop),
          }));
  return (
    <article
      className={`node-card node-card--${coverLayout}${
        selection?.checked === true ? " node-card--selected" : ""
      }`}
      data-node-id={item.node.id}
    >
      {selection !== undefined && (
        <span className="node-card__select" onPointerDown={(event) => event.stopPropagation()}>
          <Checkbox
            size="sm"
            checked={selection.checked}
            aria-label={`Select ${label}`}
            onChange={selection.onToggle}
          />
        </span>
      )}
      {item.node.classIds.includes(SYSTEM_CLASS_UUIDS.asset) &&
        isCoverAsset(client, item.node.id) && (
        <span className="node-card__cover-badge" title="This asset is used as a page cover">
          <Badge variant="neutral" size="sm">Cover</Badge>
        </span>
      )}
      <div className="node-card__content">
        {/* The cover rides INSIDE the content (owner 2026-10-13): for the
            left/right layouts the content is a two-column grid — the cover is
            a matted card element in its cell, beside the LEAD stack (this
            wrapper: breadcrumbs → title → classes → tags); the properties
            section and the content row then span BOTH columns. For the top
            layout the cover is simply the full-width first row, before the
            breadcrumbs. */}
        <CardCover item={item} props={props} layout={coverLayout} />
        <div className="node-card__lead">
          {/* The FIRST row: the containing-page breadcrumbs — the chain walks
              the parents, so a parentless node renders nothing and the row
              collapses away on its own. Read-only on the card (owner reversal
              2026-10-13): navigation context, parent edits stay in the top
              bar. */}
          <div className="node-card__breadcrumbs">
            <Breadcrumbs
              client={client}
              nodeId={item.node.id}
              onOpenNode={openNode}
              editable={false}
            />
          </div>
          <div className="node-card__header">
            {/* The title IS the page-view title — the same bullet-less BlockRow
                (variant="title", read-only): the content stream renders its
                inline tokens (class links, mentions), a click opens the node
                through the card's OutlinerContext (the page header's
                trampoline contract). Right-click opens the node's context
                menu (owner 2026-10-13 — the menu button is gone; the selection
                checkbox is the card's only hover chrome). */}
            <div
              className="node-card__title"
              onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
                setMenu({ x: event.clientX, y: event.clientY });
              }}
            >
              <BlockRow
                variant="title"
                tree={{ node: item.node, children: [] }}
                client={client}
                resolveName={resolveName}
                readOnly
              />
            </div>
          </div>
          {menu !== null && (
            <NodeContextMenu
              state={{ x: menu.x, y: menu.y, node: item.node, isPage: rendersWithDocumentChrome(item.node) }}
              client={client}
              onClose={() => setMenu(null)}
              onOpenNode={(id: string) => {
                setMenu(null);
                openNode(id);
              }}
            />
          )}
          {/* Classes row — the nodeview bar's class list itself (NodePills,
              owner 2026-10-13): the picker, × removal (the journal-class lock
              rides inside), and drag reorder — classes are addable straight
              from the card. Date nodes stay locked (the ClassesRow rule), and
              a locked empty row renders nothing. */}
          {(item.node.classIds.length > 0 || !metadataLocked) && (
            <div className="node-card__metadata-row node-card__classes-row">
              <NodePills
                client={client}
                nodeId={item.node.id}
                classIds={item.node.classIds}
                readOnly={metadataLocked}
                onOpenPage={openNode}
              />
            </div>
          )}
          {/* Tags row — the page header's TagsRow composition, label hidden:
              add/remove/menu ride, tags are addable straight from the card.
              Same lock rule as the classes row. */}
          {(item.node.tagIds.length > 0 || !metadataLocked) && (
            <div className="node-card__metadata-row node-card__tags-row">
              <TagsRow
              client={client}
              nodeId={item.node.id}
              tagIds={item.node.tagIds}
              onOpenPage={openNode}
              readOnly={metadataLocked}
            />
          </div>
        )}
        </div>
        {/* The properties section: a row per property, label | value in two
            columns (the table-row register), hairline-separated rows. Spans
            BOTH columns beside a horizontal cover (owner 2026-10-13). */}
        {cardRows.length > 0 && (
          <dl className="node-card__properties">
            {cardRows.map((row) => (
              <div className="node-card__property" key={row.key}>
                <dt>{row.name}</dt>
                <dd>{row.text}</dd>
              </div>
            ))}
          </dl>
        )}
        {/* The content row: a header row (the collapse chevron + the label)
            rides over the child blocks (owner 2026-10-13) — collapsed by
            default, the chevron shows the content on demand. Cards always
            resolve the children (the tree/maxDepth prop family is ignored). */}
        {childItems.length > 0 && (
          <div className="node-card__content-row">
            <div className="node-card__content-row-header">
              <button
                type="button"
                className="node-card__collapse-btn node-card__collapse-btn--has-children"
                title={bodyCollapsed ? "Expand" : "Collapse"}
                aria-label={bodyCollapsed ? `Expand ${label}` : `Collapse ${label}`}
                aria-expanded={!bodyCollapsed}
                onClick={() => setBodyCollapsed((value) => !value)}
              >
                <Icon path={bodyCollapsed ? "mdi-chevron-right" : "mdi-chevron-down"} size={0.8} />
              </button>
              <span className="node-card__content-row-label">Content</span>
            </div>
            {!bodyCollapsed && (
              <div className="node-card__body">
                <SortableContext
                  items={childItems.map((child) => child.node.id)}
                  strategy={verticalListSortingStrategy}
                >
                  <div className="nt-block-tree nt-block-tree--readonly">
                    {childItems.map((child) => (
                      <BlockRow
                        key={child.node.id}
                        tree={toBlockTree(child)}
                        client={client}
                        resolveName={resolveName}
                        readOnly
                        hideBacklinks={props.hideBacklinkCount}
                      />
                    ))}
                  </div>
                </SortableContext>
              </div>
            )}
          </div>
        )}
      </div>
    </article>
  );
}

const COVER_LAYOUT_OPTIONS: Array<{ value: CardLayout; icon: string; label: string }> = [
  { value: "no-cover", icon: "mdi-card-outline", label: "No cover" },
  { value: "cover-left", icon: "mdi-dock-left", label: "Cover left" },
  { value: "cover-right", icon: "mdi-dock-right", label: "Cover right" },
  { value: "cover-top", icon: "mdi-dock-top", label: "Cover top" },
];

/** The cover-layout picker (the four original layouts); the choice persists per device. */
export function CoverLayoutToggle({ value, onChange }: { value: CardLayout; onChange: (layout: CardLayout) => void }) {
  return (
    <SelectionButton
      options={COVER_LAYOUT_OPTIONS}
      value={value}
      onChange={(val) => onChange(val as CardLayout)}
      size="sm"
      maxVisibleOptions={4}
      aria-label="Card layout"
      className="cover-layout-toggle"
    />
  );
}

/** The flat cards body's sort vocabulary (the sort-button panel options). */
const CARDS_SORT_OPTIONS: SortMenuOption[] = [
  { value: "edit-date", label: "Last edited", hint: "Newest first" },
  { value: "alphabetical", label: "Name A–Z" },
];

/** The flat cards body — the window hook lives here (component-scoped). */
function FlatCards({
  items,
  props,
  coverLayout,
  onCoverLayout,
  selection,
}: {
  items: NodeCollectionItem[];
  props: NodeCollectionProps;
  coverLayout: CardLayout;
  onCoverLayout: (layout: CardLayout) => void;
  selection: ReturnType<typeof useViewSelection>;
}) {
  /**
   * The sort-button state (session-local; `defaultSortMode` only names the
   * starting mode). The flat grid sorts; a tree context keeps the content
   * order and hides the button (the outline view's editable-surface
   * ruling's twin), as does the grouped board (the property columns own
   * the order there — the drops write it).
   *
   * The default stays LIVE, the outline/table precedent: a container
   * default CHANGE re-seeds the mode while the user has chosen none (the
   * ranked quick search rides this — a section passes "position" while the
   * search ranks its pool); a user pick latches `chosen`.
   */
  const defaultMode: SortMode =
    props.defaultSortMode === "alphabetical" || props.defaultSortMode === "position"
      ? props.defaultSortMode
      : "edit-date";
  const [sortState, setSortState] = useState<{ mode: SortMode; chosen: boolean }>({
    mode: defaultMode,
    chosen: false,
  });
  if (sortState.mode !== defaultMode && !sortState.chosen) {
    setSortState({ mode: defaultMode, chosen: false });
  }
  const sortMode = sortState.mode;
  const setSortChoice = (mode: SortMode) => setSortState({ mode, chosen: true });
  const sortable = props.tree !== true;
  const sortedItems = useMemo(() => {
    if (!sortable || sortMode === "position") return items;
    const resolveClassName = (classId: string) => props.client.getDisplayName(classId);
    return [...items].sort(
      sortMode === "alphabetical"
        ? compareItemsByMode("alphabetical", resolveClassName)
        : compareItemsByEditDate(resolveClassName),
    );
  }, [items, sortable, sortMode, props.client]);
  // the card set is windowed; selection rides the loaded cards
  // (exports scope to the picked ids, never to the window). The window
  // re-narrows on every resort.
  const { visible, remaining, showMore } = useWindowed(sortedItems, {
    enabled: props.windowed ?? true,
    resetKey: sortMode,
  });
  const selectable = (props.selectable ?? true) && props.tree !== true;
  /**
   * The card bodies render read-only BlockRows on EVERY cards surface (the
   * v1 card always shows content) — the grid hosts its own OutlinerContext
   * (the FlatRows precedent): the enclosing page/class view is the
   * navigation fallback, the shell hubs have none of their own.
   */
  const outer = useContext(OutlinerContext);
  const outliner = useOutlinerValue(props.client, visible[0]?.node.id ?? "", {
    openNode: (id) => (props.onNodeClick ?? outer?.openNode ?? (() => {}))(id),
    openInSidebar: (id) => (props.onNodeShiftClick ?? outer?.openInSidebar ?? (() => {}))(id),
  });
  // Hosted collections: the toolbar portals into the tab bar's right-hand
  // cluster (owner 2026-10-12); un-hosted it rides the body top.
  const chromeTarget = useViewChromeTarget();
  const toolbar = (
    <div className="cards-toolbar">
      <SelectionExportControls client={props.client} selection={selection} />
      {sortable && (
        <SortMenuButton value={sortMode} options={CARDS_SORT_OPTIONS} onChange={(mode) => setSortChoice(mode as SortMode)} />
      )}
      <CoverLayoutToggle value={coverLayout} onChange={onCoverLayout} />
    </div>
  );
  return (
    <div>
      {chromeTarget !== null ? createPortal(toolbar, chromeTarget) : toolbar}
      <OutlinerContext.Provider value={outliner}>
        <div className="cards-grid">
          {visible.map((item) => (
            <NodeCard
              key={item.node.id}
              item={item}
              props={props}
              coverLayout={coverLayout}
              selection={
                selectable
                  ? {
                      checked: selection.isSelected(item.node.id),
                      onToggle: () => selection.toggle(item.node.id),
                    }
                  : undefined
              }
            />
          ))}
          <ShowMoreButton remaining={remaining} onShowMore={showMore} />
        </div>
      </OutlinerContext.Provider>
    </div>
  );
}

export function CardsView(props: NodeCollectionProps) {
  const { client, items = [], groupByProperty } = props;
  // The cover layout persists device-locally — one preference
  // per device shared by every cards surface; never an op.
  // A surface may only shape the unset fallback (defaultCoverLayout);
  // a persisted choice wins everywhere.
  const [coverLayout, setCoverLayout] = useCardLayoutPreference(props.defaultCoverLayout ?? "no-cover");
  // selection export — flat node sets only (tree contexts stay chrome-less).
  const selection = useViewSelection();
  if (items.length === 0) return null;
  // The grouped board IS cards mode with a property-dimension groupBy: the
  // container passes a usable select schema → the same cards render as board
  // columns with between-column drops; otherwise the flat grid. ONE card
  // shape serves both (and tree contexts) — the card resolves its own
  // children, so the tree/hasChildren dispatch is gone.
  const grouping =
    groupByProperty !== undefined
      ? client.listPropertySchemas().find((s) => s.id === groupByProperty)
      : undefined;
  if (grouping !== undefined && grouping.options !== null && grouping.options.length > 0) {
    return <CardsBoard props={props} />;
  }
  return (
    <FlatCards
      items={items}
      props={props}
      coverLayout={coverLayout}
      onCoverLayout={setCoverLayout}
      selection={selection}
    />
  );
}

registerView({
  id: "cards",
  label: "Cards",
  icon: "mdi-view-grid-outline",
  component: CardsView,
  capabilities: { sorting: true, cardLayout: true, groupBy: true },
});
