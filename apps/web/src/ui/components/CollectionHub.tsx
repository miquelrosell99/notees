/**
 * CollectionHub — the hub shell behind a sidebar entry: header (icon,
 * title, count, view switcher) over a NodeCollection of the hub's nodes.
 * View mode is session-local state (reset on reload). Hubs with a single
 * mode render no switcher. The pages/classes hubs ride the outline mode;
 * tasks defaults to table; assets to cards (owner rules).
 */

import { useEffect, useState } from "react";

import { Icon } from "../Icon.js";
import { NodeCollection, ViewToolbar } from "../views/index.js";
import type { NodeCollectionItem, TableColumn, ViewMode } from "../views/index.js";
import type { AnyClient } from "../views/types.js";

export interface CollectionHubProps {
  client: AnyClient;
  icon: string;
  title: string;
  items: NodeCollectionItem[];
  /** Available modes in switcher order. */
  modes: ViewMode[];
  defaultMode: ViewMode;
  tableColumns?: TableColumn[] | undefined;
  cardProperties?: string[] | undefined;
  tableEditable?: boolean | undefined;
  /** Kanban: the select property whose options seed the board columns. */
  kanbanProperty?: string | undefined;
  emptyTitle?: string | undefined;
  onOpenNode: (nodeId: string) => void;
  onOpenInSidebar?: ((nodeId: string) => void) | undefined;
}

export function CollectionHub({
  client,
  icon,
  title,
  items,
  modes,
  defaultMode,
  tableColumns,
  cardProperties,
  tableEditable = false,
  kanbanProperty,
  emptyTitle,
  onOpenNode,
  onOpenInSidebar,
}: CollectionHubProps) {
  const [, setVersion] = useState(0);
  useEffect(() => client.subscribe(() => setVersion((v) => v + 1)), [client]);
  const [mode, setMode] = useState<ViewMode>(defaultMode);
  return (
    <div className="nt-hub">
      <header className="nt-hub-header">
        <Icon path={icon} size={1.2} className="nt-hub-icon" />
        <h1 className="nt-hub-title">{title}</h1>
        <span className="nt-hub-count">{items.length}</span>
        {modes.length > 1 && (
          <span className="nt-hub-switcher">
            <ViewToolbar modes={modes} value={mode} onChange={setMode} />
          </span>
        )}
      </header>
      <NodeCollection
        viewMode={mode}
        client={client}
        items={items}
        tableColumns={tableColumns}
        cardProperties={cardProperties}
        propertiesOf={(id) => client.getEffectiveProperties(id)}
        tableEditable={tableEditable}
        kanbanProperty={kanbanProperty}
        emptyTitle={emptyTitle}
        onNodeClick={onOpenNode}
        onNodeShiftClick={onOpenInSidebar}
      />
    </div>
  );
}
