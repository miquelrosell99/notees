/**
 * ClassedNodesSection — the class's instances, the class page's centerpiece
 * (the Capacities database / Tana supertag table): the view toolbar (table
 * by default per the owner rule; outline/cards/kanban when a bound select
 * property can group) over the editable collection with one column per
 * property binding. Expanded by default; rows open the member (inline
 * blocks resolve to their containing main node) and the row × unassigns the
 * member from THIS class. The toolbar (and the empty state's action button)
 * carry the create affordance — a node classed with this class — visible
 * even on an empty database.
 */

import { rendersWithDocumentChrome } from "@notees/domain";

import type { WorkerClient } from "@/core/worker-client.js";
import type { ClientNode, WorkspaceClient } from "@/core/workspace-client.js";

import { displayNameForSettings } from "../../dateDisplay.js";
import { Icon } from "../../Icon.js";
import { Section } from "../../Section.js";
import { useViewModePreference } from "../../viewPrefs.js";
import { refuseClassRemoval } from "../classRemoval.js";
import { Button } from "../ui/Button.js";
import { NodeCollection, ViewToolbar } from "../../views/index.js";
import type { NodeCollectionItem, TableColumn, ViewMode } from "../../views/index.js";

type AnyClient = WorkspaceClient | WorkerClient;

/** The classed-nodes modes, in switcher order (table is the section default). */
const MEMBERS_VIEW_MODES: ViewMode[] = ["outline", "cards", "table"];

/** The first bound select property with options — the kanban grouping (single or multi). */
function kanbanBindingFor(
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
  const kanbanProperty = kanbanBindingFor(client, bindings);
  const modes: ViewMode[] =
    kanbanProperty !== undefined
      ? ["outline", "cards", "kanban", "table"]
      : MEMBERS_VIEW_MODES;
  /**
   * Durable display state per class — device-local, never an
   * op; table stays the default per the owner rule, and a persisted mode
   * the switcher no longer offers (kanban without a grouping select) falls
   * back to the default.
   */
  const [membersMode, setMembersMode] = useViewModePreference(
    `classMembers.${classId}`,
    "table",
    modes,
  );

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

  return (
    <Section
      client={client}
      title="Classed nodes"
      icon={<Icon path="mdi-shape-outline" size={0.9} />}
      badge={client.getClassMemberCount(classId)}
      defaultCollapsed={false}
      load={() => client.getClassMembers(classId)}
      emptyText="No classed nodes."
      // The container owns its empty state: the view toolbar (with the
      // create affordance) and the kit EmptyState's action must render on
      // an empty database, not the bare emptyText line.
      renderWhenEmpty
      renderResults={(members) => {
        const memberItems: NodeCollectionItem[] = members.map((member) => ({ node: member }));
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
          <>
            {/* The toolbar carries the create affordance left of the
                switcher — visible on an empty database too. */}
            <ViewToolbar modes={modes} value={membersMode} onChange={setMembersMode}>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                icon="mdi mdi-plus"
                onClick={addMember}
              >
                Add member
              </Button>
            </ViewToolbar>
            <NodeCollection
              viewMode={membersMode}
              client={client}
              items={memberItems}
              tableColumns={memberColumns}
              propertiesOf={(id) => client.getEffectiveProperties(id)}
              tableEditable
              kanbanProperty={kanbanProperty}
              onNodeClick={(id) => {
                const member = client.getNode(id);
                if (member !== undefined) openMember(member);
              }}
              trailingAction={unassignAction}
              emptyTitle="No classed nodes."
              showAddButton
              onAdd={addMember}
              addLabel="Add member"
            />
          </>
        );
      }}
    />
  );
}
