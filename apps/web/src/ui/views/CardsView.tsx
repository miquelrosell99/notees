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

import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";

import { Icon } from "../Icon.js";
import { BlockRow } from "../BlockRow.js";
import { classIconMap, nodeIcon } from "../iconFor.js";
import { displayNameForSettings, displayNameFromClient } from "../dateDisplay.js";
import { registerView } from "./registry.js";
import { propertyDisplayText } from "./propertyDisplay.js";
import type { NodeCollectionItem, NodeCollectionProps } from "./types.js";
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

/** One flat node card — also the kanban board's card body. */
export function NodeCard({ item, props }: { item: NodeCollectionItem; props: NodeCollectionProps }) {
  const { client, onNodeClick, onNodeShiftClick, cardProperties, propertiesOf } = props;
  const icon = nodeIcon(item.node, classIconMap(client.listClasses()));
  const label = displayNameForSettings(item.node) || "Untitled";
  const properties = propertiesOf?.(item.node.id) ?? [];
  const cardRows = (cardProperties ?? [])
    .map((schemaId) => properties.find((p) => p.propertySchemaId === schemaId))
    .filter((prop) => prop !== undefined && propertyDisplayText(client, prop) !== "");
  return (
    <article className="node-card" data-node-id={item.node.id}>
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
        {item.node.nodeType !== "page" && <span className="node-card__type">{item.node.nodeType}</span>}
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
    </article>
  );
}

export function CardsView(props: NodeCollectionProps) {
  const { items, tree = undefined } = props;
  if (items.length === 0) return null;
  if (tree === true || hasChildren(items)) return <TreeCards items={items} props={props} />;
  return (
    <div className="cards-grid">
      {items.map((item) => (
        <NodeCard key={item.node.id} item={item} props={props} />
      ))}
    </div>
  );
}

registerView({
  id: "cards",
  label: "Cards",
  icon: "mdi-view-grid-outline",
  component: CardsView,
  capabilities: { sorting: true, cardLayout: false },
});
