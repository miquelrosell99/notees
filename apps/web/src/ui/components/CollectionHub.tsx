/**
 * CollectionHub — the hub shell behind a sidebar entry: header (icon,
 * title, count, view switcher) over a NodeCollection of the hub's nodes.
 * View mode persists per hub device-locally when `persistKey` is given
 * (never an op); without a key it stays session-local. The
 * pages/classes hubs ride the outline mode; tasks defaults to table; assets
 * to cards with a cover-top cover fallback (owner rules).
 */

import { useEffect, useState, type ReactNode } from "react";

import { Icon } from "../Icon.js";
import { useViewModePreference } from "../viewPrefs.js";
import { NodeCollection, ViewToolbar } from "../views/index.js";
import type { NodeCollectionItem, TableColumn, ViewMode } from "../views/index.js";
import type { AnyClient, CardLayout } from "../views/types.js";

export interface CollectionHubProps {
  client: AnyClient;
  icon: string;
  title: string;
  items: NodeCollectionItem[];
  /** Available modes in switcher order. */
  modes: ViewMode[];
  defaultMode: ViewMode;
  /**
   * The hub's persistence identity (e.g. the nav key "tasks"): the chosen
   * mode survives reloads under `viewMode.hub.<persistKey>`. Omitted = the
   * title is the identity (ad-hoc hubs persist too, keyed by title).
   */
  persistKey?: string | undefined;
  tableColumns?: TableColumn[] | undefined;
  cardProperties?: string[] | undefined;
  /**
   * Cards: the cover layout this hub's cards fall back to when the device
   * has no persisted cover choice yet (the Assets hub passes "cover-top").
   */
  defaultCoverLayout?: CardLayout | undefined;
  tableEditable?: boolean | undefined;
  /** Cards board: the select property whose options seed the board columns. */
  groupByProperty?: string | undefined;
  emptyTitle?: string | undefined;
  /** Right-aligned header extras (#14's "New class" button et al.). */
  headerActions?: ReactNode;
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
  persistKey,
  tableColumns,
  cardProperties,
  defaultCoverLayout,
  tableEditable = false,
  groupByProperty,
  emptyTitle,
  headerActions,
  onOpenNode,
  onOpenInSidebar,
}: CollectionHubProps) {
  const [, setVersion] = useState(0);
  useEffect(() => client.subscribe(() => setVersion((v) => v + 1)), [client]);
  const [mode, setMode] = useViewModePreference(
    persistKey ?? `session.${title}`,
    defaultMode,
    modes,
  );
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
        {headerActions !== undefined && <span className="nt-hub-actions">{headerActions}</span>}
      </header>
      <NodeCollection
        viewMode={mode}
        client={client}
        items={items}
        tableColumns={tableColumns}
        cardProperties={cardProperties}
        defaultCoverLayout={defaultCoverLayout}
        propertiesOf={(id) => client.getEffectiveProperties(id)}
        tableEditable={tableEditable}
        groupByProperty={groupByProperty}
        emptyTitle={emptyTitle}
        onNodeClick={onOpenNode}
        onNodeShiftClick={onOpenInSidebar}
      />
    </div>
  );
}
