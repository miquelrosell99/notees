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
 *
 * The trailing add-block ghost (owner ruling 2026-10-23 — the ghost is
 * the COLLECTION's chrome, the view mode decides its UI): the host opts
 * in with `ghost`; the parent is the bundle root (`rootId`, or `parent.id`
 * in the focused grammar, where the ghost rides the parent row's children
 * container). The collection renders the mode-appropriate affordance
 * (cards passes the twin GhostCard through the grid's last cell, every
 * other mode trails a GhostRow — prose drops the gutter) and owns the
 * write (create + caret hand-off through the active outliner session).
 * A host-passed `parentTrailing`/`trailingGhost` always wins (the
 * reference subtree's bespoke ghost).
 *
 * The standalone editable-outline bundle (same ruling): `rootId` puts the
 * collection in BODY MODE — it resolves the items through the shared
 * childQuery factory and anchors the bundle (the self-hosted outliner
 * session, the edit-thread walk, the ghost). An editable outline/tree
 * collection without a host OutlinerContext self-hosts one (the FlatRows
 * precedent), and an editable outline collection without a host
 * EditThreadProvider self-hosts the measured edit-thread overlay on the
 * collection container — a bare editable outline renders anywhere,
 * no PageView required. Host-provided contexts always win.
 */

import { Suspense, useContext, useEffect, useRef, useState } from "react";

import { EmptyState, ErrorBoundary, Spinner } from "../../components/ui/fleet/index.js";
import { GhostCard, GhostRow, realizeGhost } from "../../ui/GhostRow.js";
import { EditThreadContext, EditThreadOverlay, EditThreadProvider } from "../../ui/EditThread.js";
import { OutlinerContext, useOutlinerValue } from "../../ui/outliner-context.js";
import { useSectionViews } from "./sectionViews.js";
import { childQuery } from "./childQuery.js";
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
  // The standalone editable-outline bundle (owner rulings 2026-10-23): an
  // editable outline/tree collection WITHOUT a host OutlinerContext
  // self-hosts one (the FlatRows precedent) — a bare editable collection
  // renders anywhere, no PageView required. The edit thread is likewise
  // the collection's chrome: an editable OUTLINE collection without a
  // host EditThreadProvider provides its own and mounts the measured
  // overlay on the collection container (the mode's chrome, like the
  // ghost). When a host provides either context the collection defers.
  const outerOutline = useContext(OutlinerContext);
  const outerThread = useContext(EditThreadContext);
  // Every tree collection self-hosts when no host OutlinerContext exists —
  // BlockRow consumes the context unconditionally (read-only rows too), so
  // the provider is structural, not edit-gated. The FlatRows precedent.
  const selfHostOutline = props.tree === true && outerOutline === null;
  // BODY MODE anchor: rootId names the node whose children are the items
  // (falling back to the first item's id for hosts that still pass items
  // verbatim); the focused grammar anchors at the parent. The self-hosted
  // outliner session roots here — also the query builder's "this page"
  // scope anchor.
  const bundleRootId = props.parent?.id ?? props.rootId ?? props.items?.[0]?.node.id ?? "";
  // Hook-unconditional (used only when selfHostOutline).
  const selfOutline = useOutlinerValue(props.client, bundleRootId, {
    openNode: (id) => props.onNodeClick?.(id),
    openInSidebar: (id) => props.onNodeShiftClick?.(id),
  });
  const threadHostRef = useRef<HTMLDivElement | null>(null);
  const ghostWarnedRef = useRef(false);
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
  // BODY MODE: rootId names the node whose children are the items — the
  // collection resolves them through the shared childQuery factory when the
  // host passes no explicit list.
  const bodyItems =
    props.items ?? (props.rootId !== undefined ? childQuery(props.client, props.rootId) : []);
  const resolvedItems = hosted !== null ? resolution.items : bodyItems;
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
  // The add-block ghost is the collection's chrome (owner ruling
  // 2026-10-23 — the ghost is the collection's, the view mode decides its
  // UI, and the collection owns the write): the host opts in with `ghost`;
  // the parent is the bundle root (rootId plain-tree, parent.id focused).
  // The click creates the empty child and hands the caret to the ACTIVE
  // outliner session (the host's when one provides the context, the
  // self-hosted one otherwise). Cards passes the twin GhostCard through the
  // grid's last cell (the trailingGhost slot), every other mode trails a
  // GhostRow (prose drops the gutter). The focused grammar rides the parent
  // row's children container (parentTrailing) — constructed here unless the
  // host passed its own (the reference subtree's bespoke ghost). A
  // plain-tree `ghost` without `rootId` logs and renders none.
  const activeOutline = outerOutline ?? (selfHostOutline ? selfOutline : null);
  // The ghost parent: the focused block (focused grammar) or `rootId`
  // (plain tree). A plain-tree `ghost` without `rootId` is a host bug —
  // warn once and render none.
  let ghostRootId: string | undefined;
  if (props.ghost === true) {
    if (props.parent !== undefined) ghostRootId = props.parent.id;
    else if (props.rootId !== undefined) ghostRootId = props.rootId;
    else if (!ghostWarnedRef.current) {
      ghostWarnedRef.current = true;
      console.warn("[node-collection] `ghost` without `rootId` renders no ghost");
    }
  }
  const ghostOnRealize =
    ghostRootId === undefined || activeOutline === null
      ? undefined
      : () => {
          void realizeGhost(props.client, activeOutline, ghostRootId).catch((error: unknown) => {
            console.warn(`[outliner] ghost realize (${ghostRootId}) failed:`, error);
          });
        };
  const ghost =
    ghostRootId === undefined || ghostOnRealize === undefined ? undefined : effectiveEntry.id === "cards" ? (
      <GhostCard parentId={ghostRootId} onRealize={ghostOnRealize} />
    ) : (
      <GhostRow
        parentId={ghostRootId}
        prose={effectiveEntry.id === "prose"}
        onRealize={ghostOnRealize}
      />
    );
  // The focused grammar: the child-level ghost defaults to the constructed
  // one (riding the parent row's children container); a host-passed
  // parentTrailing always wins.
  const effectiveParentTrailing =
    props.parentTrailing ?? (props.parent !== undefined ? ghost : undefined);
  const viewProps = {
    ...props,
    items: resolvedItems,
    groups: resolvedGroups,
    ungroupedItems: resolvedUngrouped,
    parentTrailing: effectiveParentTrailing,
    trailingGhost:
      ghost !== undefined && effectiveEntry.id === "cards" && props.parent === undefined
        ? ghost
        : props.trailingGhost,
  };
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
  // The edit thread is the outline mode's chrome: an editable outline
  // collection without a host EditThreadProvider self-hosts one and mounts
  // the measured overlay on the collection container. The walk stops at the
  // bundle root (the page root itself renders bullet-less, so a top-level
  // edit threads from the first real row — exactly the page-body behavior;
  // the focused block renders a real bullet, so the thread starts there).
  const selfThread =
    props.editable === true && effectiveEntry.id === "outline" && outerThread === null;
  const threadRootId = props.parent?.id ?? props.rootId ?? resolvedItems[0]?.node.parentId ?? "";
  const collection = (
    <div
      ref={threadHostRef}
      className={`node-collection node-collection--${effectiveEntry.id} ${
        selfThread ? "nt-edit-thread-host " : ""
      }${props.className ?? ""}`.trim()}
    >
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
        {/* The trailing ghost rides after the content in the plain grammar;
            the focused grammar already mounted it inside the parent row's
            children container (the parentTrailing slot). */}
        {ghost !== undefined && effectiveEntry.id !== "cards" && props.parent === undefined &&
          ghost}
      </ViewChromeContext.Provider>
      {selfThread && (
        <EditThreadOverlay
          client={props.client}
          hostRef={threadHostRef}
          rootId={threadRootId}
        />
      )}
    </div>
  );
  // Provider wrappers (inside-out): the edit thread first, the outliner
  // context outermost — rows consume both.
  let result = collection;
  if (selfThread) result = <EditThreadProvider>{result}</EditThreadProvider>;
  if (selfHostOutline) result = <OutlinerContext.Provider value={selfOutline}>{result}</OutlinerContext.Provider>;
  return result;
}
