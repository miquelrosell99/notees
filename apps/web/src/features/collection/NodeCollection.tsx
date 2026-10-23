/**
 * NodeCollection — the view dispatcher. Resolves the registry entry for the
 * requested mode and renders its component inside a mode-classed container
 * (`node-collection node-collection--{mode}`, the established convention)
 * with a
 * Suspense boundary and (when the entry opts in) the kit ErrorBoundary. The
 * empty collection renders the kit EmptyState when the container offers a
 * title; otherwise, when the collection is hosted (custom tabs) or the
 * container passes `emptyText`, the subtle `nt-section-empty` line renders in
 * the selected tab's body — the tabs and the "+" affordance stay visible on
 * an empty section — naming the container's empty on the default tab and
 * "No matching rows." on a custom tab refined to empty; with neither,
 * nothing. The create affordance (the view contract's `showAddButton` +
 * `onAdd`) rides the empty state's action slot — the button renders only
 * when BOTH the flag and the callback are set.
 *
 * Hosted views (the `hostedViews` prop): the collection gains the
 * custom-tabs chrome (SectionViewTabs) — the default tab renders exactly
 * today's behavior (permanent, first), custom tabs refine the items/groups
 * (and the ungrouped top-level rows) with their stored query_ast
 * (sectionViewResolve), and a custom tab's
 * view_mode overrides the requested mode when the registry knows it.
 * The ACTIVE tab's displayed row count rides its name as a small badge
 * (owner ruling 2026-10-21 — the count moved off the filter panel's foot;
 * computed here post-refinement, so the badge names the open tab's rows).
 * A collection WITHOUT hosted tabs has no tab row — its section host names
 * the count in the section-header badge instead (owner refinement
 * 2026-10-23: the count is named exactly once per section, on the tab when
 * tabs exist, on the header when they don't).
 * `tabBarTrailing` rides the tab bar's far right (owner 2026-10-12) — the
 * host section's filter/view chrome joins the tabs' row; it renders ONLY
 * in the hosted tab bar (a non-hosted collection has no tab row). The
 * view's own per-view toolbar (table columns/sort/more, cards cover/selection)
 * portals into a slot mounted BEFORE the trailing chrome — the cluster ends
 * with the FilterBar so its wrapped structured panel never moves the row.
 *
 *  The focused-block view (the `parent` prop, owner 2026-10-20 — the v1
 *  "show parents" NodeCollection prop, generalized): the collection shows
 *  the focused block above/around its children and EACH VIEW MODE decides
 *  the display — outline renders it as the root block row (the items
 *  nested inside, the zoom grammar); prose renders it as an editable
 *  top-level header (the title-variant row); cards/table ignore it (no
 *  defined parent display yet — the focused view falls back to outline
 *  for them at the callsite). `parentTrailing` carries the "+ Add block"
 *  ghost at the child indent level.
 */

import { Suspense, useEffect, useState } from "react";

import { EmptyState, ErrorBoundary, Spinner } from "../../components/ui/fleet/index.js";
import { useSectionViews } from "./sectionViews.js";
import { getViewDefinition } from "./registry.js";
import { SECTION_DEFAULT_TAB, SectionViewTabs } from "./SectionViewTabs.js";
import { useSectionViewResolution } from "./sectionViewResolve.js";
import type { NodeCollectionProps, ViewMode } from "./types.js";
import { ViewChromeContext } from "./viewChrome.js";

export function NodeCollection({
  viewMode,
  hostedViews,
  tabBarTrailing,
  ...props
}: NodeCollectionProps & { viewMode: ViewMode }) {
  const entry = getViewDefinition(viewMode);
  // The hosted-views state always lives in the same hook order: without the
  // prop the hook no-ops (null client) and the tab bar never renders.
  const hosted = hostedViews ?? null;
  const views = useSectionViews(
    hosted !== null ? props.client : null,
    hosted?.nodeId ?? "",
    hosted?.sectionKey ?? "linked-references",
  );
  const [internalTab, setInternalTab] = useState<string>(SECTION_DEFAULT_TAB);
  // The hosted tab is OPTIONALLY CONTROLLED (owner ruling 2026-10-21 — the
  // "Save as tab" flow lives in the host section, which owns the tab state
  // and selects the freshly saved view): both props set → controlled;
  // otherwise the internal useState stands (every other call site).
  const controlledTab = hosted?.selected !== undefined && hosted?.onSelectTab !== undefined;
  const tab = controlledTab ? hosted!.selected! : internalTab;
  const setTab = controlledTab ? hosted!.onSelectTab! : setInternalTab;
  // The hosted view-chrome slot (ref-callback state) — declared with the
  // other hooks, above the entry guard's early return.
  const [chromeSlot, setChromeSlot] = useState<HTMLSpanElement | null>(null);
  const selectedView =
    hosted !== null && tab !== SECTION_DEFAULT_TAB
      ? views.views.find((view) => view.id === tab)
      : undefined;
  // A view deleted elsewhere (reset from another surface) drops the tab
  // back to the permanent default.
  useEffect(() => {
    if (hosted === null) return;
    if (tab !== SECTION_DEFAULT_TAB && views.loaded && selectedView === undefined) {
      setTab(SECTION_DEFAULT_TAB);
    }
  }, [hosted, tab, views.loaded, selectedView]);

  const resolution = useSectionViewResolution(
    props.client,
    props.items ?? [],
    props.groups,
    props.ungroupedItems,
    selectedView,
  );
  // A custom tab may pin a display mode (null = the container's own mode).
  const pinnedMode =
    selectedView?.viewMode !== undefined &&
    selectedView.viewMode !== null &&
    getViewDefinition(selectedView.viewMode) !== undefined
      ? (selectedView.viewMode as ViewMode)
      : undefined;
  const effectiveMode = pinnedMode ?? viewMode;

  if (entry === undefined) {
    return <div className="node-collection node-collection--missing">Unknown view: {viewMode}</div>;
  }
  const effectiveEntry = pinnedMode !== undefined ? (getViewDefinition(pinnedMode) ?? entry) : entry;
  const View = effectiveEntry.component;
  const resolvedItems = hosted !== null ? resolution.items : (props.items ?? []);
  const resolvedGroups = hosted !== null ? resolution.groups : props.groups;
  const resolvedUngrouped = hosted !== null ? resolution.ungrouped : props.ungroupedItems;
  // The active tab's displayed row count — the badge riding its tab name
  // (owner ruling 2026-10-21): grouped rendering shows the groups' rows plus
  // the ungrouped ones, flat rendering the item list.
  const tabRowCount =
    resolvedGroups !== undefined
      ? resolvedGroups.reduce((sum, group) => sum + group.items.length, 0) +
        (resolvedUngrouped?.length ?? 0)
      : resolvedItems.length;
  const viewProps = { ...props, items: resolvedItems, groups: resolvedGroups, ungroupedItems: resolvedUngrouped };
  const showAdd = props.showAddButton === true && props.onAdd !== undefined;
  // A custom tab refined to empty answers for itself; the default tab (or an
  // unrefined collection) names the container's empty line.
  const emptyLine =
    hosted !== null && selectedView !== undefined
      ? "No matching rows."
      : (props.emptyText ?? "No matching rows.");
  const body =
    resolution.error !== null && hosted !== null ? (
      <div className="nt-error" role="alert">
        {resolution.error}
      </div>
    ) : viewProps.items.length === 0 &&
      effectiveEntry.id !== "graph" &&
      props.emptyTitle !== undefined ? (
      <EmptyState
        title={props.emptyTitle}
        description={props.emptyHint}
        {...(showAdd ? { actionLabel: props.addLabel ?? "Add", onAction: props.onAdd } : {})}
      />
    ) : viewProps.items.length === 0 &&
      effectiveEntry.id !== "graph" &&
      (hosted !== null || props.emptyText !== undefined) ? (
      <div className="nt-section-empty">{emptyLine}</div>
    ) : (
      <Suspense fallback={<Spinner />}>
        <View {...viewProps} />
      </Suspense>
    );
  const content =
    effectiveEntry.capabilities.errorBoundary === true ? <ErrorBoundary>{body}</ErrorBoundary> : body;
  return (
    <div className={`node-collection node-collection--${effectiveEntry.id} ${props.className ?? ""}`.trim()}>
      {hosted !== null && (
        <SectionViewTabs
          client={props.client}
          nodeId={hosted.nodeId}
          sectionKey={hosted.sectionKey}
          selected={selectedView !== undefined ? tab : SECTION_DEFAULT_TAB}
          onSelect={setTab}
          activeCount={tabRowCount}
          trailing={
            <>
              <span className="node-collection__view-chrome" ref={setChromeSlot} />
              {tabBarTrailing}
            </>
          }
        />
      )}
      <ViewChromeContext.Provider value={hosted !== null ? chromeSlot : null}>
        {content}
      </ViewChromeContext.Provider>
    </div>
  );
}
