/**
 * ClassedNodesSection — the class's instances, the class page's centerpiece
 * (the Capacities database / Tana supertag table): the view toolbar (table
 * by default per the owner rule; outline/cards/kanban when a bound select
 * property can group) over the editable collection with one column per
 * property binding. Expanded by default; rows open the member (inline
 * blocks resolve to their containing main node) and the row × unassigns the
 * member from THIS class.
 */

import { rendersWithDocumentChrome } from "@notees/domain";

import type { WorkerClient } from "@/core/worker-client.js";
import type { ClientNode, WorkspaceClient } from "@/core/workspace-client.js";

import { displayNameForSettings } from "../../dateDisplay.js";
import { Icon } from "../../Icon.js";
import { Section } from "../../Section.js";
import { useViewModePreference } from "../../viewPrefs.js";
import { refuseClassRemoval } from "../classRemoval.js";
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
   * Durable display state per class (§34.27 L1) — device-local, never an
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

  return (
    <Section
      client={client}
      title="Classed nodes"
      icon={<Icon path="mdi-shape-outline" size={0.9} />}
      badge={client.getClassMemberCount(classId)}
      defaultCollapsed={false}
      load={() => client.getClassMembers(classId)}
      emptyText="No classed nodes."
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
              // §34.19: system/journal classes refuse membership removal.
              if (refuseClassRemoval(classId)) return;
              void client.unassignClass(item.node.id, classId);
            }}
          >
            ×
          </button>
        );
        return (
          <>
            <ViewToolbar
              modes={modes}
              value={membersMode}
              onChange={setMembersMode}
            />
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
            />
          </>
        );
      }}
    />
  );
}
