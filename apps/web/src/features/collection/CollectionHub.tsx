/**
 * CollectionHub — the hub shell behind a sidebar entry: the shared
 * SurfaceTopBar chrome (icon, title, count, view switcher, header actions)
 * pinned above a NodeCollection of the hub's nodes. View mode persists per
 * hub device-locally when `persistKey` is given (never an op); without a
 * key it stays session-local. The pages/classes hubs ride the outline
 * mode; tasks defaults to table; assets to cards with a cover-top cover
 * fallback (owner rules). The outline (list) mode renders the full
 * block-row surface — inline-editable when `editable` is set (the tasks
 * hub), read-only-inert otherwise (the content click does nothing; the
 * bullet opens the node).
 *
 * The surface shape (owner 2026-10-22): the root is full-bleed in the main
 * content card (the PageCard.css hub-surface exception) — the bar pins at
 * the card's top and the body scrolls at the CARD's right border, the
 * collection's measure riding the capped content column inside.
 */

import { useEffect, useState, type ReactNode } from "react";

import { useViewModePreference } from "../../ui/viewPrefs.js";
import { NodeCollection, ViewToolbar } from "./index.js";
import type { NodeCollectionItem, SortSpec, TableColumn, ViewMode } from "./index.js";
import type { AnyClient, CoverLayout } from "./types.js";
import { SurfaceTopBar } from "../../components/ui/fleet/SurfaceTopBar.js";
import "./CollectionHub.css";

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
  /**
   * Cards: the cover layout this hub's cards fall back to when the device
   * has no persisted cover choice yet (the Assets hub passes "cover-top").
   */
  defaultCoverLayout?: CoverLayout | undefined;
  tableEditable?: boolean | undefined;
  /**
   * Table mode's sort default (owner 2026-10-13 — the hubs' tables open on
   * Edited, newest first); other modes ignore it. Unset = the container's
   * row order (the view default is no sort — containers own their table
   * defaults).
   */
  defaultSort?: SortSpec | undefined;
  /** Cards board: the select property whose options seed the board columns. */
  groupByProperty?: string | undefined;
  /**
   * The outline (list) mode is an inline-editing surface: rows edit in
   * place (content, property icon buttons), children render recursively.
   * Off (default) renders the same rows read-only-inert — the content
   * click does nothing and the bullet opens the node.
   */
  editable?: boolean | undefined;
  emptyTitle?: string | undefined;
  /** Right-aligned header extras (#14's "New class" button et al.). */
  headerActions?: ReactNode;
  /**
   * Content rendered inside the scrolling body ABOVE the collection (the
   * tasks hub's bucketed surface rides this — owner 2026-10-22); the whole
   * block scrolls with the collection at the card border.
   */
  prepend?: ReactNode | undefined;
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
  defaultCoverLayout,
  tableEditable = false,
  defaultSort,
  groupByProperty,
  editable = false,
  emptyTitle,
  headerActions,
  prepend,
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
      <SurfaceTopBar
        icon={icon}
        title={title}
        count={items.length}
        actions={
          <>
            {modes.length > 1 && <ViewToolbar modes={modes} value={mode} onChange={setMode} />}
            {headerActions}
          </>
        }
      />
      <div className="nt-hub__body">
        <div className="nt-hub__content">
          {prepend}
          <NodeCollection
            viewMode={mode}
            client={client}
            items={items}
            tableColumns={tableColumns}
            defaultCoverLayout={defaultCoverLayout}
            propertiesOf={(id) => client.getEffectiveProperties(id)}
            tableEditable={tableEditable}
            {...(defaultSort !== undefined ? { defaultSort } : {})}
            groupByProperty={groupByProperty}
            emptyTitle={emptyTitle}
            editable={editable}
            onNodeClick={onOpenNode}
            onNodeShiftClick={onOpenInSidebar}
          />
        </div>
      </div>
    </div>
  );
}
