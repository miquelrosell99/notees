/**
 * CollectionHub — the hub shell behind a sidebar entry: the shared
 * SurfaceTopBar chrome (icon, title, count, view switcher, header actions)
 * pinned above a NodeCollection of the hub's nodes. View mode persists per
 * hub device-locally when `persistKey` is given (never an op); without a
 * key it stays session-local. The offered modes pass the registry's
 * availability gate against what the collection can feed — a gated mode
 * never rides the switcher and a persisted mode that gates out falls back
 * to the default (a dead switch never resurrects). The pages/classes hubs
 * ride the outline
 * mode, opening on the Dates first sort (the hub passes `defaultSortMode`;
 * unset = the container's row order). Tasks defaults to table; assets to
 * cards with a cover-top cover
 * fallback. The outline (list) mode renders the full
 * block-row surface — inline-editable when `editable` is set (the tasks
 * hub), read-only-inert otherwise (the content click does nothing; the
 * bullet opens the node).
 *
 * The surface shape: the root is full-bleed in the main
 * content card (the PageCard.css hub-surface exception) — the bar pins at
 * the card's top and the body scrolls at the CARD's right border, the
 * collection's measure riding the capped content column inside.
 */

import { useEffect, useState, type ReactNode } from "react";

import { useViewModePreference } from "../../ui/viewPrefs.js";
import { NodeCollection, ViewToolbar, useAvailableViewModes } from "./index.js";
import type { NodeCollectionItem, SortMode, SortSpec, TableColumn, ViewMode } from "./index.js";
import type { AnyClient, CoverLayout } from "./types.js";
import { SurfaceTopBar } from "../../components/ui/kit/SurfaceTopBar.js";
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
   * List mode's sort default (the mode the sort button opens on — Dates
   * first for the shell hubs); unset = the container's row order (position).
   * The table/cards modes ignore it (the table sorts per column, the cards
   * per its own vocabulary).
   */
  defaultSortMode?: SortMode | undefined;
  /**
   * Cards: the cover layout this hub's cards fall back to when the device
   * has no persisted cover choice yet (the Assets hub passes "cover-top").
   */
  defaultCoverLayout?: CoverLayout | undefined;
  tableEditable?: boolean | undefined;
  /**
   * Table mode's sort default; other modes ignore it. Unset = the container's
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
  /**
   * The collection's item set is flat but structurally nested: the views
   * derive parent/child structure from the item set at render time (the
   * Pages hub — its query is all page nodes). Unset = every item renders
   * as its own row regardless of parentage (the backlinks ruling).
   */
  nestUnderParents?: boolean | undefined;
  /**
   * List mode scopes its recursive children to the main-children zone
   * (subpages only — the getChildPages read): page listings (the shell
   * hubs) expand their subpage tree and never a page's inline body blocks.
   */
  pagesOnly?: boolean | undefined;
  /**
   * List mode hides the per-row properties chrome (value-display icon
   * buttons + the collapsed "Properties N" section): listing surfaces
   * answer "which nodes", not "what metadata".
   */
  hideProperties?: boolean | undefined;
  /** List mode hides the per-row tags row (identity chrome only). */
  hideTags?: boolean | undefined;
  emptyTitle?: string | undefined;
  /** Right-aligned header extras (#14's "New class" button et al.). */
  headerActions?: ReactNode;
  /**
   * Content rendered inside the scrolling body ABOVE the collection (the
   * tasks hub's bucketed surface rides this); the whole
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
  defaultSortMode,
  defaultCoverLayout,
  tableEditable = false,
  defaultSort,
  groupByProperty,
  editable = false,
  pagesOnly = false,
  nestUnderParents = false,
  hideProperties = false,
  hideTags = false,
  emptyTitle,
  headerActions,
  prepend,
  onOpenNode,
  onOpenInSidebar,
}: CollectionHubProps) {
  const [, setVersion] = useState(0);
  useEffect(() => client.subscribe(() => setVersion((v) => v + 1)), [client]);
  // Availability gating: the modes the collection can actually feed ride
  // the switcher AND the persisted-mode sanitize — a gated mode never
  // renders and a persisted mode that gates out falls back to the default
  // (a dead switch never resurrects).
  const availableModes = useAvailableViewModes(client, items, modes);
  const [mode, setMode] = useViewModePreference(
    persistKey ?? `session.${title}`,
    defaultMode,
    availableModes,
  );
  return (
    <div className="nt-hub">
      <SurfaceTopBar
        icon={icon}
        title={title}
        count={items.length}
        actions={
          <>
            {availableModes.length > 1 && <ViewToolbar modes={availableModes} value={mode} onChange={setMode} />}
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
            {...(defaultSortMode !== undefined ? { defaultSortMode } : {})}
            groupByProperty={groupByProperty}
            emptyTitle={emptyTitle}
            editable={editable}
            {...(pagesOnly ? { pagesOnly: true } : {})}
        {...(nestUnderParents ? { nestUnderParents: true } : {})}
        {...(hideProperties ? { hideProperties: true } : {})}
        {...(hideTags ? { hideTags: true } : {})}
            onNodeClick={onOpenNode}
            onNodeShiftClick={onOpenInSidebar}
          />
        </div>
      </div>
    </div>
  );
}
