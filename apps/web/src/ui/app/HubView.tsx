/**
 * HubView — the nav hub: the main-view collection behind each NAVIGATION
 * entry (tasks bucket + table/cards, assets gallery, the shared outline
 * hub for pages/classes/whiteboards/inbox). Exported for the hub
 * view-mode tests.
 */

import { useEffect, useState } from "react";

import { SYSTEM_CLASS_UUIDS, SYSTEM_PROPERTY_UUIDS } from "@notees/domain";
import type { ClientNode } from "@/core/workspace-client/index.js";
import { CollectionHub } from "../../features/collection/CollectionHub.js";
import { ensureTaskFamily } from "../../features/classview/taskFamily.js";
import { TaskBuckets } from "../../features/classview/TaskBuckets.js";
import { createNodesWithClasses } from "../../features/templates/createNodesWithClasses.js";
import { ClassCreateModal } from "../../features/modals/ClassCreateModal.js";
import { AssetUploadModal } from "../../features/modals/AssetUploadModal.js";
import { Button } from "../../components/ui/fleet/Button.js";
import { NAV_ENTRIES, type NavKey } from "./Sidebar.js";
import type { TableColumn, ViewMode } from "../../features/collection/index.js";
import type { AnyClient } from "./clients.js";

/** Task property columns, in display order (schemas may not exist yet —
 *  the task family is authored on demand, so missing schemas drop out). */
const TASK_PROPERTY_COLUMNS: Array<{ id: string; fallback: string }> = [
  { id: SYSTEM_PROPERTY_UUIDS.taskStatus, fallback: "Status" },
  { id: SYSTEM_PROPERTY_UUIDS.taskPriority, fallback: "Priority" },
  { id: SYSTEM_PROPERTY_UUIDS.taskScheduled, fallback: "Scheduled" },
  { id: SYSTEM_PROPERTY_UUIDS.taskDeadline, fallback: "Deadline" },
];

function taskTableColumns(client: AnyClient): TableColumn[] {
  const schemas = client.listPropertySchemas();
  return [
    { id: "name", kind: "name", label: "Name", sortable: true },
    ...TASK_PROPERTY_COLUMNS.filter((col) => schemas.some((s) => s.id === col.id)).map((col) => ({
      id: col.id,
      kind: "property" as const,
      label: schemas.find((s) => s.id === col.id)?.name ?? col.fallback,
      propertySchemaId: col.id,
      sortable: true,
    })),
    { id: "created", kind: "created", label: "Created", sortable: true },
  ];
}

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
  for (const member of members) {
    for (const prop of client.getEffectiveProperties(member.id)) {
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
  // Author the six task property schemas + bindings on first
  // tasks-hub open (idempotent no-op once present); before this, a fresh
  // workspace silently dropped the Scheduled/Deadline columns.
  useEffect(() => {
    if (nav === "tasks") void ensureTaskFamily(client).catch(() => {});
  }, [client, nav]);
  const classes = client.listClasses();
  const assetClassId = classes.find((cls) => cls.name === "asset")?.id ?? SYSTEM_CLASS_UUIDS.asset;
  // #14 — the Classes hub hosts the class-creation modal (blank + system
  // deploy); the header button opens it, and a created class opens.
  const [classCreateOpen, setClassCreateOpen] = useState(false);
  // The Assets hub's creation path IS the upload modal: the header
  // button opens it, and the uploaded asset node opens.
  const [assetUploadOpen, setAssetUploadOpen] = useState(false);
  // Top-level pages: subpages render in their parent's Pages zone, so the
  // workspace-level hubs list roots only; the asset class stays excluded.
  const pages = client.roots().filter((page) => !page.classIds.includes(assetClassId));
  const dateClassIds: string[] = [
    SYSTEM_CLASS_UUIDS.day,
    SYSTEM_CLASS_UUIDS.month,
    SYSTEM_CLASS_UUIDS.year,
  ];
  const journalPages = pages.filter((page) => page.classIds.some((c) => dateClassIds.includes(c)));
  const whiteboardPages = pages.filter((page) => page.classIds.includes(SYSTEM_CLASS_UUIDS.whiteboard));
  const taskPages = pages.filter((page) => page.classIds.includes(SYSTEM_CLASS_UUIDS.task));
  const sectionIds = new Set([...journalPages, ...whiteboardPages, ...taskPages].map((p) => p.id));
  const entry = NAV_ENTRIES.find((e) => e.key === nav);

  if (nav === "tasks") {
    // Any node classed task — pages AND blocks (owner rule), table default.
    const members = client.getClassMembers(SYSTEM_CLASS_UUIDS.task);
    // The cards board groups by the status property; the cards mode renders
    // it when a usable select schema exists (task family is authored on demand).
    const groupByProperty = taskGroupingProperty(client, members);
    const modes: ViewMode[] = ["outline", "cards", "table"];
    return (
      <div className="nt-hub-tasks">
        {/* ONE bar for the whole hub: CollectionHub's SurfaceTopBar carries
            the title/count/switcher (owner 2026-10-22 — the hub-surface
            restructure); the bucketed surface (Overdue/Today/Upcoming/
            Unscheduled/Completed) prepends the collection inside the shared
            scrolling body, device-collapse and all. */}
        <CollectionHub
          client={client}
          icon={entry?.icon ?? "mdi-format-list-checks"}
          title={entry?.label ?? "Tasks"}
          items={members.map((node) => ({ node }))}
          modes={modes}
          defaultMode="table"
          persistKey="hub.tasks"
          tableColumns={taskTableColumns(client)}
          defaultSort={{ key: "edited", direction: "desc" }}
          tableEditable
          groupByProperty={groupByProperty}
          editable
          emptyTitle="No tasks yet"
          prepend={<TaskBuckets client={client} onOpenNode={onOpenNode} />}
          onOpenNode={onOpenNode}
          onOpenInSidebar={onOpenInSidebar}
        />
      </div>
    );
  }

  if (nav === "assets") {
    // Any node classed asset, cards by default with a cover-top cover
    // fallback (owner rule — asset cards read as an image gallery). The
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
          modes={["cards", "table"]}
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
          : pages.filter((page) => !sectionIds.has(page.id));
  // The shared hub's header creation button: each mode's idiom — Classes
  // opens the class-creation modal; Pages writes one main page (the palette's
  // New-page write); Whiteboards reuses the "New" flow's write with the
  // whiteboard system class picked. The created node opens.
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
    ) : nav === "pages" ? (
      <Button
        size="sm"
        variant="ghost"
        icon="mdiNotePlusOutline"
        onClick={() => {
          void client
            .createObject({ isEmbedded: false, name: "Untitled" })
            .then((id) => onOpenNode(id))
            .catch((error: unknown) => {
              console.warn("[new-node] creation failed:", error);
            });
        }}
      >
        New page
      </Button>
    ) : nav === "whiteboards" ? (
      <Button
        size="sm"
        variant="ghost"
        icon="mdiPresentation"
        onClick={() =>
          createNodesWithClasses(client, [SYSTEM_CLASS_UUIDS.whiteboard], onOpenNode)
        }
      >
        New whiteboard
      </Button>
    ) : undefined;
  return (
    <>
      <CollectionHub
        client={client}
        icon={entry?.icon ?? "mdi-book-open-page-variant"}
        title={entry?.label ?? "Pages"}
        items={items.map((node) => ({ node }))}
        modes={["outline"]}
        defaultMode="outline"
        persistKey={`hub.${nav}`}
        emptyTitle="Nothing here yet."
        headerActions={headerAction}
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
