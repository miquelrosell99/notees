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
 */

import { useEffect, useState } from "react";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";

import { rendersWithDocumentChrome } from "@notees/domain";

import { Icon } from "../Icon.js";
import { BlockRow } from "../BlockRow.js";
import { classIconMap, nodeIcon } from "../iconFor.js";
import { displayNameForSettings, displayNameFromClient } from "../dateDisplay.js";
import { renderStateLabel } from "../renderStateLabel.js";
import { SelectionButton } from "../components/ui/index.js";
import { registerView } from "./registry.js";
import { propertyDisplayText } from "./propertyDisplay.js";
import { assetImageUrl, cardImageAssetId } from "./assetThumbs.js";
import { COVER_CLASS_ID } from "../components/coverProperty.js";
import { Badge } from "../components/ui/Badge.js";
import { useCardLayoutPreference } from "../viewPrefs.js";
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
  return (
    <div className="cards-grid">
      {items.map((item) => {
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
    </div>
  );
}

/** The cover image (resolved asynchronously; null = text-only card). */
function CardCover({ item, props, layout }: { item: NodeCollectionItem; props: NodeCollectionProps; layout: CardLayout }) {
  const [url, setUrl] = useState<string | null>(null);
  const assetId = cardImageAssetId(item.node, props.propertiesOf?.(item.node.id));
  useEffect(() => {
    let cancelled = false;
    setUrl(null);
    if (assetId === null) return;
    void assetImageUrl(props.client, assetId).then((resolved) => {
      if (!cancelled) setUrl(resolved);
    });
    return () => {
      cancelled = true;
    };
  }, [assetId, props.client]);
  if (url === null) return null;
  return <img className="node-card__cover" src={url} alt="" />;
}

/** One flat node card — also the kanban board's card body. */
export function NodeCard({
  item,
  props,
  coverLayout = "no-cover",
}: {
  item: NodeCollectionItem;
  props: NodeCollectionProps;
  coverLayout?: CardLayout;
}) {
  const { client, onNodeClick, onNodeShiftClick, cardProperties, propertiesOf } = props;
  const icon = nodeIcon(item.node, classIconMap(client.listClasses()));
  const label = displayNameForSettings(item.node) || "Untitled";
  const properties = propertiesOf?.(item.node.id) ?? [];
  const cardRows = (cardProperties ?? [])
    .map((schemaId) => properties.find((p) => p.propertySchemaId === schemaId))
    .filter((prop) => prop !== undefined && propertyDisplayText(client, prop) !== "");
  return (
    <article className={`node-card node-card--${coverLayout}`} data-node-id={item.node.id}>
      {item.node.classIds.includes(COVER_CLASS_ID) && (
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

export function CardsView(props: NodeCollectionProps) {
  const { items, tree = undefined } = props;
  // The cover layout persists device-locally (§34.27 L1) — one preference
  // per device shared by every cards/kanban surface; never an op.
  const [coverLayout, setCoverLayout] = useCardLayoutPreference("no-cover");
  if (items.length === 0) return null;
  if (tree === true || hasChildren(items)) return <TreeCards items={items} props={props} />;
  return (
    <div>
      <div className="cards-toolbar">
        <CoverLayoutToggle value={coverLayout} onChange={setCoverLayout} />
      </div>
      <div className="cards-grid">
        {items.map((item) => (
          <NodeCard key={item.node.id} item={item} props={props} coverLayout={coverLayout} />
        ))}
      </div>
    </div>
  );
}

registerView({
  id: "cards",
  label: "Cards",
  icon: "mdi-view-grid-outline",
  component: CardsView,
  capabilities: { sorting: true, cardLayout: true },
});
