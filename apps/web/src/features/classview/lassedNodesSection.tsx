/**
 * ClassedNodesSection — the class's instances, the class page's centerpiece
 * (the Capacities database / Tana supertag table), composing through the
 * CollectionSection skin: the chrome, the lazy contract, the transient
 * filter layer, the hosted tabs, and the hosted toolbar cluster (quick
 * search first → the view-chrome slot → the mode switcher) all ride the
 * skin. What the section owns stays: the availability-gated mode switcher
 * (the eager member read gates it — the resolved rows live in the skin),
 * the live sort defaults (pure alphabetical while the pool is the section's
 * own order; while the quick search ranks the pool the ranked order IS the
 * display order — membership AND order — so the defaults yield until the
 * user picks a sort), the per-class device-local mode preference, the
 * table's per-binding columns, the member-open semantics (inline blocks
 * resolve to their containing main node), and the row × unassigning the
 * member from THIS class. The create affordance — a node classed with this
 * class — rides the section header's trailing action, visible even on an
 * empty database (the section renders even empty; the count rides the
 * hosted tab bar's active-tab badge, never the header). The query is
 * component state — one instance per class page, lost on reload, nothing
 * persisted.
 */

import { useState } from "react";

import { rendersWithDocumentChrome } from "@notees/domain";

import type { WorkerClient } from "@/core/worker-client.js";
import type { ClientNode, WorkspaceClient } from "@/core/workspace-client/index.js";

import { titleOfNode } from "../../ui/dateDisplay.js";
import { parentlessBlockResolverOf } from "../../ui/renderStateLabel.js";
import { Icon } from "../../ui/Icon.js";
import { useViewModePreference } from "../../ui/viewPrefs.js";
import { refuseClassRemoval, removeClassDissolvingLinks } from "../metadata/classRemoval.js";
import {
  EMPTY_FILTER_QUERY,
  draftOrFactoryAst,
  quickTextOf,
  type FilterQuery,
} from "../collection/filterQuery.js";
import { ViewSwitcher, useAvailableViewModes } from "../collection/index.js";
import { CollectionSection } from "../collection/CollectionSection.js";
import { SECTION_DEFAULT_TAB } from "../collection/NodeCollectionTabs.js";
import type { NodeCollectionItem, TableColumn, ViewMode } from "../collection/index.js";

type AnyClient = WorkspaceClient | WorkerClient;

/** The classed-nodes modes, in switcher order (table is the section default). */
const MEMBERS_VIEW_MODES: ViewMode[] = ["outline", "cards", "table", "pivot", "graph", "gantt", "calendar"];

/** The first bound select property with options — the cards-board grouping (single or multi). */
function groupingBindingFor(
  client: AnyClient,
  bindings: Array<{ propertySchemaId: string }>,
): string | undefined {
  const schemas = client.listPropertySchemas();
  const binding = bindings.find((b) => {
    const schema = schemas.find((s) => s.id === b.propertySchemaId);
    return (
      schema !== undefined &&
      schema.type === "select" &&
      schema.options !== null &&
      schema.options.length > 0
    );
  });
  return binding?.propertySchemaId;
}

export function ClassedNodesSection({
  client,
  classId,
  /** The peek-card surface: start collapsed (the card is a glance). */
  sectionsStartCollapsed = false,
  onOpenPage,
}: {
  client: AnyClient;
  classId: string;
  onOpenPage?: ((pageId: string) => void) | undefined;
  /** The peek-card surface: start collapsed (the card is a glance). */
  sectionsStartCollapsed?: boolean | undefined;
}) {
  const bindings = client.getClassBindings(classId);
  const groupByProperty = groupingBindingFor(client, bindings);
  const modes: ViewMode[] = MEMBERS_VIEW_MODES;

  /**
   * The host's own FilterQuery COPY: the skin owns the transient state and
   * reports it here — the host derives the live sort defaults and the new
   * tab's starter AST (`createAst`) from the copy.
   */
  const [memberFilter, setMemberFilter] = useState<FilterQuery>(EMPTY_FILTER_QUERY);
  /**
   * The hosted tab state, lifted: "Save as tab"
   * persists the structured draft as a section view and must SELECT the new
   * tab — the tab state lives here, handed to the collection as a controlled
   * hostedViews (which also auto-wires the skin's toolbar Save-as-tab).
   */
  const [tab, setTab] = useState<string>(SECTION_DEFAULT_TAB);
  /**
   * The sort defaults are LIVE: pure alphabetical while
   * the pool is the section's own order — but while the quick search ranks
   * the pool, the ranked order IS the display order (the search ruling:
   * membership AND order), so the defaults yield to "no sort" until the
   * user picks a sort explicitly (the views' chosen-flag reseed).
   */
  const quickTextActive = quickTextOf(memberFilter) !== "";

  // Availability gating rides the same seam as the hubs: the switcher and
  // the persisted-mode sanitize see only the modes the member set feeds
  // (a gated mode never renders; a persisted mode that gates out falls
  // back to the table default — a dead switch never resurrects). The
  // resolved rows live in the skin, so the gate reads the eager materialized
  // member list — the same read the resolution runs, re-read per render.
  const eagerMembers: NodeCollectionItem[] = client.getClassMembers(classId).map((member) => ({ node: member }));
  const availableModes = useAvailableViewModes(client, eagerMembers, modes);
  /**
   * Durable display state per class — device-local, never an
   * op; table stays the default per the owner rule, and a persisted mode
   * the surface no longer offers falls back to the default.
   */
  const [membersMode, setMembersMode] = useViewModePreference(
    `classMembers.${classId}`,
    "table",
    availableModes,
  );
  const memberColumns: TableColumn[] = [
    { id: "name", kind: "name", label: "Name", sortable: true },
    ...bindings.map((binding) => ({
      id: binding.propertySchemaId,
      kind: "property" as const,
      label: binding.name,
      propertySchemaId: binding.propertySchemaId,
      sortable: true,
    })),
    { id: "created", kind: "created", label: "Created", sortable: true },
  ];

  /**
   * A member opens directly when it renders with document chrome; an inline
   * block member resolves to its containing main node (nearest ancestor
   * matching the document-chrome predicate).
   */
  const openMember = (member: ClientNode) => {
    const parentlessBlock = parentlessBlockResolverOf(client);
    const parentNode = member.parentId !== null ? client.getNode(member.parentId) : undefined;
    if (rendersWithDocumentChrome(member, parentNode, parentlessBlock)) {
      onOpenPage?.(member.id);
      return;
    }
    // Ancestor walk with the parent-page condition: a bit under a non-page
    // parent is inert, so the walk continues past it to the real page.
    const seen = new Set<string>([member.id]);
    let current = parentNode;
    let currentParent =
      current !== undefined && current.parentId !== null ? client.getNode(current.parentId) : undefined;
    while (
      current !== undefined &&
      !rendersWithDocumentChrome(current, currentParent, parentlessBlock) &&
      !seen.has(current.id)
    ) {
      seen.add(current.id);
      current = currentParent;
      currentParent =
        current !== undefined && current.parentId !== null ? client.getNode(current.parentId) : undefined;
    }
    onOpenPage?.(
      current !== undefined && rendersWithDocumentChrome(current, currentParent, parentlessBlock)
        ? current.id
        : member.id,
    );
  };

  /**
   * The class's create affordance: a node classed with THIS class — the
   * section's member route (object.create carries the class assignment,
   * the class.assign pair `unassignAction` tombstones). The expanded
   * section re-runs its query on the write notification, so the new
   * member row appears without a manual refresh.
   */
  const addMember = () => {
    void client.createObject({ isEmbedded: false, classIds: [classId] });
  };

  const unassignAction = (item: NodeCollectionItem) => (
    <button
      type="button"
      className="nt-class-member-remove"
      aria-label={`Remove ${titleOfNode(item.node) || item.node.id} from ${titleOfNode(client.getNode(classId)!) || "this class"}`}
      title="Remove from class"
      onClick={() => {
        // System/journal classes refuse membership removal.
        if (refuseClassRemoval(classId)) return;
        void removeClassDissolvingLinks(client, item.node.id, classId);
      }}
    >
      <Icon path="mdi-close" size={0.7} />
    </button>
  );

  return (
    <CollectionSection
      client={client}
      title="Classed nodes"
      icon={<Icon path="mdi-shape-outline" size={0.9} />}
      className="nt-section"
      defaultCollapsed={sectionsStartCollapsed}
      filterable
      action={{ icon: "mdi-plus", label: "Add member", onClick: addMember }}
      viewMode={membersMode}
      read={() => client.getClassMembers(classId).map((member) => ({ node: member }))}
      onFilterChange={setMemberFilter}
      collection={{
        showBreadcrumbs: false,
        tableColumns: memberColumns,
        propertiesOf: (id) => client.getEffectiveProperties(id),
        tableEditable: true,
        groupByProperty,
        defaultSortMode: quickTextActive ? "position" : "alphabetical",
        defaultSort: quickTextActive ? undefined : { key: "name", direction: "asc" },
        onNodeClick: (id) => {
          const member = client.getNode(id);
          // The worker-client's cachedRead serves undefined on a key's
          // first-ever read (the value lands a macrotask later) — a row
          // the table rendered exists, so a miss is a read-cache artifact,
          // not a missing node: open the id directly instead of dropping
          // the click (the first-click-no-op found by the live probe
          // 2026-10-20).
          if (member === undefined) {
            onOpenPage?.(id);
            return;
          }
          openMember(member);
        },
        trailingAction: unassignAction,
        emptyTitle: "No classed nodes.",
        hostedViews: {
          nodeId: classId,
          sectionKey: "classed-nodes",
          createAst: () => draftOrFactoryAst(memberFilter),
          selected: tab,
          onSelectTab: setTab,
        },
        // The mode switcher rides the cluster's far right — the owner's
        // register: the toolbar (quick search first), then the view-chrome
        // slot, then this.
        toolbarContent: (
          <ViewSwitcher modes={availableModes} value={membersMode} onChange={setMembersMode} />
        ),
      }}
    />
  );
}
