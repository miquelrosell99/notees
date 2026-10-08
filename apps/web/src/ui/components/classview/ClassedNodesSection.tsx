/**
 * ClassedNodesSection — the class's instances, the class page's centerpiece
 * (the Capacities database / Tana supertag table): the view toolbar (table
 * by default per the owner rule; outline/cards switchable — the cards mode
 * renders the property board when a bound select property can group) over
 * the editable collection with one column per property binding. Expanded by default; rows open the member (inline
 * blocks resolve to their containing main node) and the row × unassigns the
 * member from THIS class. The toolbar (and the empty state's action button)
 * carry the create affordance — a node classed with this class — visible
 * even on an empty database.
 *
 * The section resolves through useSectionData directly (the Section chrome
 * wrapper stays the lazy contract too, but the transient filter layer needs
 * the hook's post-resolution/pre-windowing step): the FilterBar rides the
 * view toolbar inline (left of the icon-only Add member button and the view
 * switcher — one chrome row), the section's FilterQuery filters the resolved
 * members before the collection's windowing sees them, and the eager
 * member-count badge stays UNFILTERED — an active filter reads "0 of N" in
 * the bar and never hides the section. The query is component state — one
 * instance per class page, lost on reload, nothing persisted.
 */

import { useCallback, useMemo, useState } from "react";

import { rendersWithDocumentChrome } from "@notees/domain";

import type { WorkerClient } from "@/core/worker-client.js";
import type { ClientNode, WorkspaceClient } from "@/core/workspace-client.js";

import { displayNameForSettings } from "../../dateDisplay.js";
import { Icon } from "../../Icon.js";
import { NodeViewSection } from "../NodeViewSection.js";
import { useViewModePreference } from "../../viewPrefs.js";
import { refuseClassRemoval } from "../classRemoval.js";
import { Button } from "../ui/Button.js";
import { FilterBar } from "../FilterBar.js";
import {
  EMPTY_FILTER_QUERY,
  filterQueryToGroup,
  isFilterInactive,
  type FilterQuery,
} from "../filterQuery.js";
import { useSectionData, type SectionRowFilter } from "../useSectionData.js";
import { NodeCollection, ViewToolbar } from "../../views/index.js";
import type { NodeCollectionItem, TableColumn, ViewMode } from "../../views/index.js";

type AnyClient = WorkspaceClient | WorkerClient;

/** The classed-nodes modes, in switcher order (table is the section default). */
const MEMBERS_VIEW_MODES: ViewMode[] = ["outline", "cards", "table"];

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
  onOpenPage,
}: {
  client: AnyClient;
  classId: string;
  onOpenPage?: ((pageId: string) => void) | undefined;
}) {
  const bindings = client.getClassBindings(classId);
  const groupByProperty = groupingBindingFor(client, bindings);
  const modes: ViewMode[] = MEMBERS_VIEW_MODES;
  /**
   * Durable display state per class — device-local, never an
   * op; table stays the default per the owner rule, and a persisted mode
   * the surface no longer offers falls back to the default.
   */
  const [membersMode, setMembersMode] = useViewModePreference(
    `classMembers.${classId}`,
    "table",
    modes,
  );

  /**
   * The transient filter layer: one FilterQuery per class page (component
   * state, lost on reload), applied to the resolved members
   * post-resolution/pre-windowing through the hook. The eager badge below
   * stays UNFILTERED.
   */
  const [memberFilter, setMemberFilter] = useState<FilterQuery>(EMPTY_FILTER_QUERY);
  const memberFilterActive = useMemo<SectionRowFilter<ClientNode> | undefined>(() => {
    if (isFilterInactive(memberFilter)) return undefined;
    const group = filterQueryToGroup(memberFilter);
    return group === null ? undefined : { group, nodeOf: (member) => member };
  }, [memberFilter]);
  const loadMembers = useCallback(() => client.getClassMembers(classId), [client, classId]);
  const [expanded, setExpanded] = useState(true);
  const { rows: members, total } = useSectionData<ClientNode[]>({
    client,
    active: expanded,
    read: loadMembers,
    filter: memberFilterActive,
  });

  /**
   * A member opens directly when it renders with document chrome; an inline
   * block member resolves to its containing main node (nearest ancestor
   * matching the document-chrome predicate).
   */
  const openMember = (member: ClientNode) => {
    if (rendersWithDocumentChrome(member)) {
      onOpenPage?.(member.id);
      return;
    }
    const seen = new Set<string>([member.id]);
    let current = client.getNode(member.parentId ?? "");
    while (current !== undefined && !rendersWithDocumentChrome(current) && !seen.has(current.id)) {
      seen.add(current.id);
      current = current.parentId !== null ? client.getNode(current.parentId) : undefined;
    }
    onOpenPage?.(current !== undefined && rendersWithDocumentChrome(current) ? current.id : member.id);
  };

  /**
   * The class's create affordance: a node classed with THIS class — the
   * section's member route (object.create carries the class assignment,
   * the class.assign pair `unassignAction` tombstones). The expanded
   * section re-runs its query on the write notification, so the new
   * member row appears without a manual refresh.
   */
  const addMember = () => {
    void client.createObject({ presentAsMain: true, classIds: [classId] });
  };

  const memberItems: NodeCollectionItem[] = (members ?? []).map((member) => ({ node: member }));
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
  const unassignAction = (item: NodeCollectionItem) => (
    <button
      type="button"
      className="nt-class-member-remove"
      aria-label={`Remove ${displayNameForSettings(item.node) || item.node.id} from ${displayNameForSettings(client.getNode(classId)!) || "this class"}`}
      title="Remove from class"
      onClick={() => {
        // System/journal classes refuse membership removal.
        if (refuseClassRemoval(classId)) return;
        void client.unassignClass(item.node.id, classId);
      }}
    >
      ×
    </button>
  );

  return (
    <NodeViewSection
      title="Classed nodes"
      icon={<Icon path="mdi-shape-outline" size={0.9} />}
      count={client.getClassMemberCount(classId)}
      className="nt-section"
      expanded={expanded}
      onExpandedChange={setExpanded}
    >
      {/* One chrome row: the transient filter layer rides the toolbar's
          left (inline — its structured panel drops below as an overlay),
          the create affordance + view switcher cluster right. The Add
          member button is icon-only with a hover tooltip. */}
      <ViewToolbar modes={modes} value={membersMode} onChange={setMembersMode}>
        <FilterBar
          client={client}
          layout="inline"
          value={memberFilter}
          onChange={setMemberFilter}
          matchCount={members === null ? null : members.length}
          totalCount={total}
        />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          icon="mdi mdi-plus"
          aria-label="Add member"
          title="Add member"
          onClick={addMember}
        />
      </ViewToolbar>
      {members === null ? null : (
        <NodeCollection
          viewMode={membersMode}
          client={client}
          items={memberItems}
          tableColumns={memberColumns}
          propertiesOf={(id) => client.getEffectiveProperties(id)}
          tableEditable
          groupByProperty={groupByProperty}
          onNodeClick={(id) => {
            const member = client.getNode(id);
            if (member !== undefined) openMember(member);
          }}
          trailingAction={unassignAction}
          emptyTitle="No classed nodes."
          showAddButton
          onAdd={addMember}
          addLabel="Add member"
          hostedViews={{ nodeId: classId, sectionKey: "classed-nodes" }}
        />
      )}
    </NodeViewSection>
  );
}
