/**
 * CardsView — cards mode.
 *
 * - TREE (child blocks): each FIRST-LEVEL block becomes a card titled by its
 *   own content; its child blocks render inside the card (read-only rows).
 *   Clicking a card's title opens the block; the outline mode remains the
 *   editing surface in this slice.
 *
 * - FLAT (tasks/assets/…): one card per node — icon + title + type + the
 *   cardProperties row (resolved per node through propertiesOf).
 *
 * §34.70: the top-level card set is windowed in both shapes (the shared
 * useWindowed + ShowMoreButton convention) — the grid renders the loaded
 * window and names the remaining count at its end.
 */

import { useEffect, useState } from "react";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";

import { rendersWithDocumentChrome, SYSTEM_CLASS_UUIDS } from "@notees/domain";

import { Icon } from "../Icon.js";
import { BlockRow } from "../BlockRow.js";
import { nodeIcon } from "../iconFor.js";
import { displayNameForSettings, displayNameFromClient } from "../dateDisplay.js";
import { renderStateLabel } from "../renderStateLabel.js";
import { SelectionButton, Checkbox, ImageModal } from "../components/ui/index.js";
import { registerView } from "./registry.js";
import { useWindowed } from "./useWindowed.js";
import { useLazyInView } from "./useLazyInView.js";
import { ShowMoreButton } from "./ShowMoreButton.js";
import { propertyDisplayText } from "./propertyDisplay.js";
import { assetImageUrl, cardImageAssetId } from "./assetThumbs.js";
import { isCoverAsset } from "../components/coverProperty.js";
import { Badge } from "../components/ui/Badge.js";
import { useCardLayoutPreference } from "../viewPrefs.js";
import { useViewSelection, SelectionExportControls } from "./selectionExport.js";
import type { CardLayout, NodeCollectionItem, NodeCollectionProps } from "./types.js";
import "./CardsView.css";

function toBlockTree(item: NodeCollectionItem): import("@/core/workspace-client.js").BlockTreeNode {
  return { node: item.node, children: (item.children ?? []).map(toBlockTree) };
}

function hasChildren(items: NodeCollectionItem[]): boolean {
  return items.some((item) => (item.children?.length ?? 0) > 0);
}

function TreeCards({ items, props }: { items: NodeCollectionItem[]; props: NodeCollectionProps }) {
  const { client, onNodeClick, onNodeShiftClick } = props;
  const resolveName = (id: string) => displayNameFromClient(client, id);
  const open = (item: NodeCollectionItem) => (event: { shiftKey: boolean }) => {
    if (event.shiftKey) onNodeShiftClick?.(item.node.id);
    else onNodeClick?.(item.node.id);
  };
  // §34.70: the top-level card set is the windowed collection (a card's own
  // children render whole inside it — they are the block's page, not the set).
  const { visible, remaining, showMore } = useWindowed(items, {
    enabled: props.windowed ?? true,
  });
  return (
    <div className="cards-grid">
      {visible.map((item) => {
        const title = displayNameForSettings(item.node);
        return (
          <article className="node-card" key={item.node.id} data-node-id={item.node.id}>
            <button
              type="button"
              className="node-card__title"
              title={title}
              onClick={open(item)}
            >
              {title === "" ? <span className="node-card__untitled">Untitled block</span> : title}
            </button>
            {(item.children?.length ?? 0) > 0 && (
              <SortableContext
                items={(item.children ?? []).map((child) => child.node.id)}
                strategy={verticalListSortingStrategy}
              >
                <div className="nt-block-tree nt-block-tree--readonly node-card__body">
                  {(item.children ?? []).map((child) => (
                    <BlockRow key={child.node.id} tree={toBlockTree(child)} client={client} resolveName={resolveName} readOnly />
                  ))}
                </div>
              </SortableContext>
            )}
          </article>
        );
      })}
      <ShowMoreButton remaining={remaining} onShowMore={showMore} />
    </div>
  );
}

/**
 * The card cover image (§34.75): the LIST renders instantly — every card
 * under a cover layout shows its imagery placeholder; the expensive fetch
 * (full bytes → data URL → decode) starts only when the card nears the
 * viewport (useLazyInView), and the loaded image clicks open into the
 * ImageModal lightbox (the v1 AssetImage pattern: download + fullscreen +
 * Esc).
 *
 * The layout prop is the gate, not a cosmetic switch: "no-cover" renders
 * nothing AND skips the lazy fetch (no placeholder, no observation, no
 * bytes) — the card is text-only, as the CoverLayoutToggle advertises.
 */
function CardCover({ item, props, layout }: { item: NodeCollectionItem; props: NodeCollectionProps; layout: CardLayout }) {
  const client = props.client;
  const assetId = cardImageAssetId(item.node, props.propertiesOf?.(item.node.id));
  const [sentinelRef, inView] = useLazyInView<HTMLElement>();
  const [url, setUrl] = useState<string | null>(null);
  const [zoomOpen, setZoomOpen] = useState(false);
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

  if (!coverEnabled || assetId === null) return null;
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

/** One flat node card — also the kanban board's card body. */
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
   * §34.69 selection export: when present, a checkbox rides the card's top
   * corner and the card highlights while checked. Absent = no selection
   * chrome (tree cards, surfaces that opt out).
   */
  selection?: { checked: boolean; onToggle: () => void } | undefined;
}) {
  const { client, onNodeClick, onNodeShiftClick, cardProperties, propertiesOf } = props;
  const icon = nodeIcon(item.node, client.effectiveClassIcons());
  const label = displayNameForSettings(item.node) || "Untitled";
  const properties = propertiesOf?.(item.node.id) ?? [];
  const cardRows = (cardProperties ?? [])
    .map((schemaId) => properties.find((p) => p.propertySchemaId === schemaId))
    .filter((prop) => prop !== undefined && propertyDisplayText(client, prop) !== "");
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
      <CardCover item={item} props={props} layout={coverLayout} />
      <div className="node-card__content">
        <button
          type="button"
          className="node-card__head"
          title={label}
          onClick={(event) => {
            if (event.shiftKey) onNodeShiftClick?.(item.node.id);
            else onNodeClick?.(item.node.id);
          }}
        >
          {icon !== null && <Icon path={icon} size={1} className="node-card__icon" />}
          <span className="node-card__label">{label}</span>
          {!rendersWithDocumentChrome(item.node) && (
            <span className="node-card__type">{renderStateLabel(item.node)}</span>
          )}
        </button>
        {cardRows.length > 0 && (
          <dl className="node-card__properties">
            {cardRows.map((prop) => (
              <div className="node-card__property" key={prop!.propertySchemaId}>
                <dt>{prop!.schema?.name ?? "Property"}</dt>
                <dd>{propertyDisplayText(client, prop)}</dd>
              </div>
            ))}
          </dl>
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

/** The cover-layout picker (the four v1 layouts); the choice persists per device. */
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
  // §34.70: the card set is windowed; selection rides the loaded cards
  // (exports scope to the picked ids, never to the window).
  const { visible, remaining, showMore } = useWindowed(items, {
    enabled: props.windowed ?? true,
  });
  const selectable = props.selectable ?? true;
  return (
    <div>
      <div className="cards-toolbar">
        <SelectionExportControls client={props.client} selection={selection} />
        <CoverLayoutToggle value={coverLayout} onChange={onCoverLayout} />
      </div>
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
    </div>
  );
}

export function CardsView(props: NodeCollectionProps) {
  const { items = [], tree = undefined } = props;
  // The cover layout persists device-locally (§34.27 L1) — one preference
  // per device shared by every cards/kanban surface; never an op.
  const [coverLayout, setCoverLayout] = useCardLayoutPreference("no-cover");
  // §34.69 selection export — flat collections only (tree cards are block
  // contexts, not a node-set export surface).
  const selection = useViewSelection();
  if (items.length === 0) return null;
  if (tree === true || hasChildren(items)) return <TreeCards items={items} props={props} />;
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
  capabilities: { sorting: true, cardLayout: true },
});
