/**
 * HubView — the nav hub: the main-view collection behind each NAVIGATION
 * entry (tasks: the bucketed list and the table/cards/… modes, assets
 * gallery, the shared outline
 * hub for pages/classes/whiteboards/inbox). Exported for the hub
 * view-mode tests.
 */

import { useEffect, useState } from "react";

import {
  CARD_PROPERTY_UUIDS,
  SYSTEM_CLASS_UUIDS,
  SYSTEM_PROPERTY_UUIDS,
  rendersWithDocumentChrome,
} from "@notees/domain";
import type { ClientNode } from "@/core/workspace-client/index.js";
import { parentlessBlockResolverOf } from "../renderStateLabel.js";
import { CollectionHub } from "../../features/collection/CollectionHub.js";
import { ensureTaskFamily } from "../../features/classview/taskFamily.js";
// Sections-view registration side effect (the collection barrel's
// self-registration precedent): registers the "sections" view mode — the
// stacked live-query sections — the tasks hub offers as its default.
import "../../features/classview/TaskSections.js";
import { taskTableColumns } from "../../features/classview/taskSections.js";
import {
  CardBuckets,
  cardRowsOf,
  partitionCardsIntoBuckets,
} from "../../features/classview/CardBuckets.js";
import { ensureCardFamily } from "../../features/classview/cardFamily.js";
import { startCardsSession } from "../../features/cards/sessionState.js";
import { getCardsAlgorithm, setCardsAlgorithm } from "../../features/settings/nodePrefs.js";
import { DEFAULT_CARDS_ALGORITHM, type CardsAlgorithm } from "@/core/workspace-client/index.js";
import {
  EMPTY_FILTER_QUERY,
  filterQueryToGroup,
  isFilterInactive,
  quickTextOf,
  type FilterQuery,
} from "../../features/collection/filterQuery.js";
import { todayIsoLocal } from "../../features/calendar/calendarViewUtils.js";
import { titleOf } from "../dateDisplay.js";
import { Icon } from "../Icon.js";
import { createNodeWithClasses } from "../../features/modals/quickCreate.js";
import { requestTitleFocus } from "../titleFocusRequest.js";
import { useTaskCreate } from "../../features/classview/useTaskCreate.js";
import { ClassCreateModal } from "../../features/modals/ClassCreateModal.js";
import { AssetUploadModal } from "../../features/modals/AssetUploadModal.js";
import { Button } from "../../components/ui/kit/Button.js";
import { SelectionButton } from "../../components/ui/kit/SelectionButton.js";
import { NAV_ENTRIES, type NavKey } from "./Sidebar.js";
import type { NodeCollectionItem, TableColumn, ViewMode } from "../../features/collection/index.js";
import type { AnyClient } from "./clients.js";

/** A select schema with options — usable as the cards-board grouping (single or multi). */
function usableGroupingSchema(
  schemas: Array<{ id: string; type: string; multi: boolean; options: Array<{ id: string; label: string }> | null }>,
  id: string,
) {
  const schema = schemas.find((s) => s.id === id);
  return schema !== undefined && schema.type === "select" && schema.options !== null && schema.options.length > 0
    ? schema
    : undefined;
}

/**
 * The tasks-hub cards-board grouping: the task status schema when it exists
 * with options (fixed seed id), else any select property at least one task
 * actually carries (migrated workspaces may hold the status schema under
 * another id). Undefined → the hub's cards mode renders the flat grid
 * (no board without a grouping select).
 */
function taskGroupingProperty(client: AnyClient, members: ClientNode[]): string | undefined {
  const schemas = client.listPropertySchemas();
  const status = usableGroupingSchema(schemas, SYSTEM_PROPERTY_UUIDS.taskStatus);
  if (status !== undefined) return status.id;
  // The shells read: only the schema ids are inspected here — no values.
  for (const member of members) {
    for (const prop of client.getPropertyRowShells(member.id)) {
      if (usableGroupingSchema(schemas, prop.propertySchemaId) !== undefined) {
        return prop.propertySchemaId;
      }
    }
  }
  return undefined;
}

const HUB_ASSET_COLUMNS: TableColumn[] = [
  { id: "name", kind: "name", label: "Name", sortable: true },
  { id: "classes", kind: "classes", label: "Classes", sortable: false },
  { id: "created", kind: "created", label: "Created", sortable: true },
];

/** Nav hub: the main-view collection behind each NAVIGATION entry.
 *  Exported for the hub view-mode tests. */
export function HubView({
  client,
  nav,
  onOpenNode,
  onOpenInSidebar,
}: {
  client: AnyClient;
  nav: NavKey;
  onOpenNode: (nodeId: string) => void;
  onOpenInSidebar?: ((nodeId: string) => void) | undefined;
}) {
  const [, setVersion] = useState(0);
  useEffect(() => client.subscribe(() => setVersion((v) => v + 1)), [client]);
  /** The tasks-hub create flow (shared with the global Ctrl/Cmd+Shift+N chord). */
  const { offerTaskCreate, taskCreateModal } = useTaskCreate({ client, onOpenNode });
  // Author the six task property schemas + bindings on first
  // tasks-hub open (idempotent no-op once present); before this, a fresh
  // workspace silently dropped the Scheduled/Deadline columns.
  useEffect(() => {
    if (nav === "tasks") void ensureTaskFamily(client).catch(() => {});
  }, [client, nav]);
  // The card family's six SRS schemas + bindings self-heal on Cards-hub
  // entry (the tasks-hub pattern; idempotent no-op once present).
  useEffect(() => {
    if (nav === "cards") void ensureCardFamily(client).catch(() => {});
  }, [client, nav]);

  // --- Cards-hub transient state (hooks ride above the nav branches) ------
  //
  // The filtered subset: the hub's FilterQuery lives in CollectionHub now
  // (the shared lifted toolbar — the hub applies it to the collection), and
  // the hub reports the filtered set upward: the bucket strip and the
  // Review actions ride it. Null until the first report — the filter
  // starts inactive, so the subset is every card member.
  const [cardsSubset, setCardsSubset] = useState<{
    query: FilterQuery;
    ids: string[];
  } | null>(null);
  // The scheduler pref (Task 7 seam) — the header toggle mirrors it
  // optimistically; the boot read converges the initial label.
  const [cardsAlgorithm, setCardsAlgorithmState] = useState<CardsAlgorithm>(
    DEFAULT_CARDS_ALGORITHM,
  );
  useEffect(() => {
    let cancelled = false;
    void getCardsAlgorithm().then((algorithm) => {
      if (!cancelled) setCardsAlgorithmState(algorithm);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  const classes = client.listClasses();
  const assetClassId = classes.find((cls) => cls.name === "asset")?.id ?? SYSTEM_CLASS_UUIDS.asset;
  // #14 — the Classes hub hosts the class-creation modal (blank + system
  // deploy); the header button opens it, and a created class opens.
  const [classCreateOpen, setClassCreateOpen] = useState(false);
  // The Assets hub's creation path IS the upload modal: the header
  // button opens it, and the uploaded asset node opens.
  const [assetUploadOpen, setAssetUploadOpen] = useState(false);
  // The section pages (Journal, Whiteboards, Tasks) carve the hub sections
  // out of the pages pool. The section SET reads the all-pages list — the
  // journal's month/day chain nodes are parented, so a roots-only read
  // would exclude just the year; the Pages hub's all-pages query filters
  // every section page out. The Whiteboards hub's item set stays roots-based
  // (a subpage classed whiteboard rides its parent's Pages zone, not the
  // Whiteboards hub). The Block role rides the parentlessRole rule —
  // block-role parentless nodes (assets included) stay out of the pages hub.
  const allPages = client.listPageSummaries();
  const pages = client
    .roots()
    .filter((page) => rendersWithDocumentChrome(page, undefined, parentlessBlockResolverOf(client)));
  const dateClassIds: string[] = [
    SYSTEM_CLASS_UUIDS.day,
    SYSTEM_CLASS_UUIDS.month,
    SYSTEM_CLASS_UUIDS.year,
  ];
  const whiteboardPages = pages.filter((page) => page.classIds.includes(SYSTEM_CLASS_UUIDS.whiteboard));
  // The section set reads the all-pages list: parented section pages (the
  // journal's month/day chain nodes, a subpage classed whiteboard/task)
  // belong to their section, never to the Pages/Inbox pool. The Whiteboards
  // hub's own item set above stays roots-based by ruling.
  const sectionIds = new Set(
    allPages
      .filter(
        (page) =>
          page.classIds.some((c) => dateClassIds.includes(c)) ||
          page.classIds.includes(SYSTEM_CLASS_UUIDS.whiteboard) ||
          page.classIds.includes(SYSTEM_CLASS_UUIDS.task),
      )
      .map((p) => p.id),
  );
  const entry = NAV_ENTRIES.find((e) => e.key === nav);

  if (nav === "tasks") {
    // Any node classed task — pages AND blocks, table default.
    const members = client.getClassMembers(SYSTEM_CLASS_UUIDS.task);
    // New-task flow (the calendar's Tasks section retired
    // with the day view; the hub owns creation now): the shared
    // useTaskCreate hook — a class with bound templates opens the picker; a
    // class without creates directly. The new task is unscheduled (the
    // Unscheduled bucket is its honest home; the date pill schedules it).
    const newTaskAction = (
      <Button size="sm" variant="ghost" icon="mdi-plus" aria-label="New task" onClick={() => void offerTaskCreate()}>
        New
      </Button>
    );
    // The cards board groups by the status property; the cards mode renders
    // it when a usable select schema exists (task family is authored on demand).
    const groupByProperty = taskGroupingProperty(client, members);
    // ONE bar for the whole hub: CollectionHub's SurfaceTopBar carries the
    // title/count/switcher; the body renders exactly ONE surface — the
    // registered "sections" view (the stacked live-query sections: Overdue /
    // Today / Upcoming / Unscheduled / Completed / Review) as the default
    // mode, or the mode the user selected (the register's either/or ruling).
    const modes: Array<ViewMode | string> = ["sections", "outline", "cards", "table", "pivot", "graph", "gantt", "calendar"];
    return (
      <div className="nt-hub-tasks">
        <CollectionHub
          client={client}
          icon={entry?.icon ?? "mdi-format-list-checks"}
          title={entry?.label ?? "Tasks"}
          items={members.map((node) => ({ node }))}
          modes={modes}
          defaultMode="sections"
          persistKey="hub.tasks"
          // A subtask (a task-classed child of a task) nests under its parent
          // in the outline and rides parent-before-child in unset table
          // order; the buckets/kanban surface is flat by design.
          nestUnderParents
          tableColumns={taskTableColumns(client)}
          defaultSort={{ key: "edited", direction: "desc" }}
          tableEditable
          groupByProperty={groupByProperty}
          {...(groupByProperty !== undefined
            ? { defaultGroupBy: { kind: "property" as const, schemaId: groupByProperty } }
            : {})}
          editable
          emptyTitle="No tasks yet"
          headerActions={newTaskAction}
          onOpenNode={onOpenNode}
          onOpenInSidebar={onOpenInSidebar}
        />
        {taskCreateModal}
      </div>
    );
  }

  if (nav === "cards") {
    // Any node classed card — pages AND blocks, table default. The hub
    // owns the family ensure (above), the due/fresh/later buckets, and the
    // Review actions that hand a session off to the /cards/review surface
    // (Task 10). The transient query-builder subset is the shared hub
    // toolbar's now — CollectionHub applies the FilterQuery to the
    // collection and reports the filtered set upward (state above), and
    // the buckets/review ride the report.
    const members = client.getClassMembers(SYSTEM_CLASS_UUIDS.card);
    const memberIds = members.map((member) => member.id);
    // The subset: default (no report yet — the filter starts inactive) =
    // every member.
    const subsetIds = cardsSubset?.ids ?? memberIds;
    const subsetQuery = cardsSubset?.query ?? EMPTY_FILTER_QUERY;
    const subsetText = quickTextOf(subsetQuery);
    const cardBuckets = partitionCardsIntoBuckets(
      cardRowsOf(client, CARD_PROPERTY_UUIDS.cardDue, subsetIds),
      todayIsoLocal(),
    );
    // The session payload names the subset for the review surface's header.
    const cardFilterSummary = !isFilterInactive(subsetQuery)
      ? `Filtered (${[subsetText !== "" ? `text "${subsetText}"` : null, filterQueryToGroup(subsetQuery) !== null ? "structured filter" : null]
          .filter((part) => part !== null)
          .join(" + ")})`
      : "All cards";
    const newCardAction = (
      <Button
        size="sm"
        variant="ghost"
        icon="mdi-plus"
        aria-label="New card"
        onClick={() => {
          void (async () => {
            const id = await client.createObject({
              isEmbedded: false,
              classIds: [SYSTEM_CLASS_UUIDS.card],
            });
            onOpenNode(id);
          })().catch(() => {});
        }}
      >
        New
      </Button>
    );
    const reviewNowAction = (
      <Button
        size="sm"
        variant="ghost"
        icon="mdi-play"
        aria-label="Review now"
        disabled={subsetIds.length === 0}
        onClick={() => startCardsSession(subsetIds, cardFilterSummary)}
      >
        Review
      </Button>
    );
    const algorithmAction = (
      <SelectionButton
        options={[
          { value: "fsrs", icon: "mdi-cards-playing", label: "FSRS (default)" },
          { value: "sm2", icon: "mdi-cards-playing-outline", label: "SM-2" },
        ]}
        value={cardsAlgorithm}
        onChange={(value) => {
          setCardsAlgorithm(value as CardsAlgorithm);
          setCardsAlgorithmState(value as CardsAlgorithm);
        }}
        size="sm"
        aria-label="Scheduling algorithm"
      />
    );
    // The per-row Review action: a single-card session over the row's node.
    const cardReviewAction = (item: NodeCollectionItem) => (
      <button
        type="button"
        className="nt-hub-cards__review"
        aria-label={`Review ${titleOf(client, item.node.id, { read: "fallback", empty: "untitled" }) ?? "untitled"}`}
        title="Review this card"
        onClick={(event) => {
          event.stopPropagation();
          startCardsSession([item.node.id], "Single card");
        }}
      >
        <Icon path="mdi-play" size={0.7} />
      </button>
    );
    return (
      <div className="nt-hub-cards">
        {/* ONE bar for the whole hub (the tasks precedent): the shared
            lifted toolbar rides the SurfaceTopBar; the bucket strip
            prepends the collection inside the shared scrolling body; the
            header carries the scheduler toggle + the Review/New actions. */}
        <CollectionHub
          client={client}
          icon={entry?.icon ?? "mdi-cards-playing-outline"}
          title={entry?.label ?? "Cards"}
          items={members.map((node) => ({ node }))}
          modes={["table", "cards", "outline"]}
          defaultMode="table"
          persistKey="hub.cards"
          defaultSort={{ key: "edited", direction: "desc" }}
          tableEditable
          editable
          emptyTitle="No cards yet"
          onFilterChange={(query, filteredItems) =>
            setCardsSubset({ query, ids: filteredItems.map((item) => item.node.id) })
          }
          prepend={
            <CardBuckets
              buckets={cardBuckets}
              onReview={(ids) => startCardsSession(ids, cardFilterSummary)}
            />
          }
          headerActions={
            <>
              {algorithmAction}
              {reviewNowAction}
              {newCardAction}
            </>
          }
          trailingAction={cardReviewAction}
          onOpenNode={onOpenNode}
          onOpenInSidebar={onOpenInSidebar}
        />
      </div>
    );
  }

  if (nav === "assets") {
    // Any node classed asset, cards by default with a cover-top cover
    // fallback (asset cards read as an image gallery). The
    // header's "New asset" button opens the upload modal — uploading IS
    // creating here: the modal's CAS path mints the asset-classed node.
    const members = client
      .getClassMembers(assetClassId)
      .map((node) => ({ node }));
    const newAssetAction = (
      <Button
        size="sm"
        variant="ghost"
        icon="mdiFileUpload"
        onClick={() => setAssetUploadOpen(true)}
      >
        New asset
      </Button>
    );
    return (
      <>
        <CollectionHub
          client={client}
          icon={entry?.icon ?? "mdi-folder-multiple-image"}
          title={entry?.label ?? "Assets"}
          items={members}
          modes={["cards", "table", "pivot", "graph", "gantt", "calendar"]}
          defaultMode="cards"
          defaultCoverLayout="cover-top"
          persistKey="hub.assets"
          tableColumns={HUB_ASSET_COLUMNS}
          defaultSort={{ key: "edited", direction: "desc" }}
          emptyTitle="No assets yet"
          headerActions={newAssetAction}
          onOpenNode={onOpenNode}
          onOpenInSidebar={onOpenInSidebar}
        />
        {assetUploadOpen && (
          <AssetUploadModal
            isOpen
            client={client}
            assetClassId={assetClassId}
            onClose={() => setAssetUploadOpen(false)}
            onUploaded={(assetNodeId) => {
              setAssetUploadOpen(false);
              onOpenNode(assetNodeId);
            }}
          />
        )}
      </>
    );
  }

  const items =
    nav === "classes"
      ? classes
      : nav === "whiteboards"
        ? whiteboardPages
        : nav === "inbox"
          ? pages.filter((page) => !sectionIds.has(page.id) && page.classIds.length === 0)
          : nav === "pages"
            ? // The Pages hub's query is ALL page nodes — root or not. Child
              // pages are first-class items in every mode; only the outline
              // renders the parent/child structure (nestUnderParents —
              // display-time nesting derived from the item set).
              client.listPages().filter((page) => !sectionIds.has(page.id))
            : pages.filter((page) => !sectionIds.has(page.id));
  // The shared hub's header creation button: each mode's idiom — Classes
  // opens the class-creation modal; Whiteboards rides the create-first write
  // with the whiteboard system class picked (the new node opens with its
  // title editor auto-entered). Pages (and Inbox) carry none: plain-page
  // creation is the top bar's "New" flow, the palette's New-page command,
  // and Ctrl/Cmd+N — one canonical entry point, not a per-surface duplicate.
  const headerAction =
    nav === "classes" ? (
      <Button
        size="sm"
        variant="ghost"
        icon="mdiShapePlus"
        onClick={() => setClassCreateOpen(true)}
      >
        New class
      </Button>
    ) : nav === "whiteboards" ? (
      <Button
        size="sm"
        variant="ghost"
        icon="mdiPresentation"
        onClick={() => {
          void createNodeWithClasses(client, [SYSTEM_CLASS_UUIDS.whiteboard]).then((id) => {
            requestTitleFocus(id);
            onOpenNode(id);
          });
        }}
      >
        New whiteboard
      </Button>
    ) : undefined;
  // The page listings (Pages, Whiteboards, Inbox) scope their recursive
  // outline children to the main-children zone — a shown page expands its
  // subpage tree, never its inline body blocks — and strip the per-row
  // properties/tags chrome so the list answers "which pages", not "what
  // metadata" (the class pills stay: identity, not metadata). The Classes
  // hub keeps the default (it lists class nodes, not pages).
  const pagesOnly = nav !== "classes";
  const cleanRows = nav !== "classes";
  return (
    <>
      <CollectionHub
        client={client}
        icon={entry?.icon ?? "mdi-book-open-page-variant"}
        title={entry?.label ?? "Pages"}
        items={items.map((node) => ({ node }))}
        modes={
          nav === "pages"
            ? ["outline", "table", "cards", "pivot", "graph", "gantt", "calendar"]
            : ["outline", "pivot", "graph", "gantt", "calendar"]
        }
        defaultMode="outline"
        defaultSortMode="dates-first"
        persistKey={`hub.${nav}`}
        emptyTitle="Nothing here yet."
        headerActions={headerAction}
        {...(pagesOnly ? { pagesOnly: true } : {})}
        {...(nav === "pages" ? { nestUnderParents: true } : {})}
        {...(cleanRows ? { hideProperties: true, hideTags: true } : {})}
        onOpenNode={onOpenNode}
        onOpenInSidebar={onOpenInSidebar}
      />
      {classCreateOpen && (
        <ClassCreateModal
          isOpen
          client={client}
          onClose={() => setClassCreateOpen(false)}
          onCreated={(id) => onOpenNode(id)}
        />
      )}
    </>
  );
}
