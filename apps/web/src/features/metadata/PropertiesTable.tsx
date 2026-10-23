import { useState } from "react";

import { type DatePrecision, isReadonlyProperty } from "@notees/domain";

import type { EffectiveProperty } from "@/core/workspace-client/index.js";

import { ContextMenu } from "../../components/ui/fleet/ContextMenu.js";
import { AliasedNodeRow } from "./AliasedNodeRow.js";
import { PropertyView } from "./PropertyView.js";
import { PropertyHistoryModal } from "./PropertyHistoryModal.js";
import type { AnyClient } from "./shared.js";
import { AddPropertyRow } from "./AddPropertyRow.js";
import { propertyGroupsOf } from "./propertyGroups.js";
import { GroupedPropertyRow } from "./GroupedPropertyRow.js";
import { ScalarPropertyValue } from "./ScalarPropertyValue.js";
import { PropertySettingsModal } from "./PropertySettingsModal.js";

/**
 * PropertiesTable — the property rows and the add affordance, shared by the
 * Metadata section (blocks) and the Properties section (pages).
 *
 * Property interactions: clicking a property LABEL opens the
 * property's configuration (PropertySettingsModal); right-clicking it opens
 * the context menu (Open property / Empty property / Remove from node).
 * Both ride event delegation on the list — the label spans carry
 * `data-property-schema-id`.
 */
export function PropertiesTable({
  client,
  nodeId,
  onOpenPage,
  omitDisplayPositions,
  /** Read-only projection: values render statically; no add/label menus. */
  readOnly = false,
}: {
  client: AnyClient;
  nodeId: string;
  onOpenPage?: ((pageId: string) => void) | undefined;
  /** Schema display positions (bullet/inline) the host surfaces
   *  itself — filter out. */
  omitDisplayPositions?: ReadonlyArray<"bullet" | "inline"> | undefined;
  readOnly?: boolean | undefined;
}) {
  const { rows, rendered, emptyObjectBindings } = propertyGroupsOf(client, nodeId, omitDisplayPositions);
  const labelOf = (row: EffectiveProperty): string => row.schema?.name ?? row.propertySchemaId;
  const [settingsFor, setSettingsFor] = useState<string | null>(null);
  const [viewFor, setViewFor] = useState<string | null>(null);
  const [historyFor, setHistoryFor] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ schemaId: string; x: number; y: number } | null>(null);

  const schemaIdFromEvent = (event: React.SyntheticEvent): string | null => {
    const target = event.target as HTMLElement;
    const label = target.closest<HTMLElement>("[data-property-schema-id]");
    return label?.dataset.propertySchemaId ?? null;
  };

  const isBound = (schemaId: string): boolean => {
    const node = client.getNode(nodeId);
    for (const classId of node?.classIds ?? []) {
      if (client.getClassBindings(classId).some((b) => b.propertySchemaId === schemaId)) return true;
    }
    return false;
  };
  // Readonly-ness derives from the system property list (owner ruling
  // 2026-10-21 — the render contract retired from the wire/store).
  const isReadonly = (schemaId: string): boolean => isReadonlyProperty(schemaId);
  const emptyProperty = (schemaId: string) => {
    for (const row of rows) {
      if (row.propertySchemaId === schemaId && row.source === "authored") {
        void client.setProperty(nodeId, schemaId, "", row.idx);
      }
    }
  };
  const removeFromNode = (schemaId: string) => {
    for (const row of rows) {
      if (row.propertySchemaId === schemaId && row.source === "authored") {
        void client.unsetProperty(nodeId, schemaId, row.idx);
      }
    }
    // The assignment declaration dies with the row (owner ruling
    // 2026-10-23) — an assigned-but-valueless property disappears instead
    // of lingering as an empty row; unassign never touches authored values
    // (the unset loop above handles those).
    void client.unassignProperty(nodeId, schemaId);
  };

  const menuItems = (schemaId: string) => {
    const bound = isBound(schemaId);
    const readonly = isReadonly(schemaId);
    return [
      { id: "open", label: "Open property", icon: "mdi-open-in-app", onClick: () => setSettingsFor(schemaId) },
      {
        id: "history",
        label: "Value history…",
        icon: "mdi-history",
        onClick: () => setHistoryFor(schemaId),
      },
      {
        id: "empty",
        label: "Empty property",
        icon: "mdi-eraser",
        disabled: readonly,
        onClick: () => emptyProperty(schemaId),
      },
      {
        id: "remove",
        label: "Remove from node",
        icon: "mdi-close-circle-outline",
        danger: true,
        disabled: bound || readonly,
        onClick: () => removeFromNode(schemaId),
      },
    ];
  };


  const groupedRow = (
    type: string | undefined,
    propertySchemaId: string,
    label: string,
    multi: boolean,
    schema: { datePrecision?: DatePrecision | null } | null,
    bindingFilter: string[] | null,
    groupRows: EffectiveProperty[],
  ) => (
    <GroupedPropertyRow
      key={propertySchemaId}
      client={client}
      nodeId={nodeId}
      type={type}
      propertySchemaId={propertySchemaId}
      label={label}
      multi={multi}
      schema={schema}
      bindingFilter={bindingFilter}
      groupRows={groupRows}
      onOpenPage={onOpenPage}
      readOnly={readOnly}
    />
  );

  return (
    <>
      <ul
        className="nt-properties-list"
        onClick={(event) => {
          if (readOnly) return;
          const schemaId = schemaIdFromEvent(event);
          if (schemaId !== null) setSettingsFor(schemaId);
        }}
        onContextMenu={(event) => {
          if (readOnly) return;
          const schemaId = schemaIdFromEvent(event);
          if (schemaId === null) return;
          event.preventDefault();
          event.stopPropagation();
          setMenu({ schemaId, x: event.clientX, y: event.clientY });
        }}
      >
          {/* The alias-side pseudo-property: chrome over the `aliasedNodeId`
              node field itself (null for every ordinary node). */}
          <AliasedNodeRow client={client} nodeId={nodeId} onOpenPage={onOpenPage} readOnly={readOnly} />
          {rendered.map((entry) => {
            if (entry === null) return null;
            if (entry.kind === "grouped") {
              const schema = entry.groupRows[0]?.schema ?? null;
              return groupedRow(
                entry.type,
                entry.propertySchemaId,
                schema?.name ?? entry.propertySchemaId,
                schema?.multi ?? true,
                schema,
                null,
                entry.groupRows,
              );
            }
            const row = entry.row;
            const label = labelOf(row);
            // R4 honest rendering: an authored row on an ineligible schema
            // SURVIVES — dimmed + the ineligible affordance, never hidden.
            const ineligible = row.eligible === false;
            return (
              <li
                key={`${row.propertySchemaId}:${row.idx}`}
                className={`${row.source === "default" ? "nt-property nt-property-default" : "nt-property"} node-metadata-row${ineligible ? " nt-property-ineligible" : ""}`}
                {...(ineligible
                  ? { title: "This node isn’t eligible for this property (its scope excludes it)" }
                  : {})}
              >
                <span className="section-label nt-property-name" data-property-schema-id={row.propertySchemaId}>
                  {label}
                  {row.boundBy !== null && <span className="nt-property-hint" title="From a class">C</span>}
                </span>
                <ScalarPropertyValue client={client} nodeId={nodeId} row={row} onOpenPage={onOpenPage} readOnly={readOnly} />
              </li>
            );
          })}
          {(readOnly ? emptyObjectBindings.filter((binding) =>
              // Read-only: a bound-but-empty binding renders nothing (no add
              // affordance) — skip the row rather than render a bare label.
              rows.some((row) => row.propertySchemaId === binding.propertySchemaId),
            ) : emptyObjectBindings).map((binding) =>
            groupedRow(
              binding.type,
              binding.propertySchemaId,
              binding.name,
              binding.multi,
              { datePrecision: binding.datePrecision },
              binding.targetClassFilter,
              [],
            ),
          )}
      </ul>
      {!readOnly && <AddPropertyRow client={client} nodeId={nodeId} />}
      {menu !== null && (
        <ContextMenu items={menuItems(menu.schemaId)} position={{ x: menu.x, y: menu.y }} onClose={() => setMenu(null)} />
      )}
      {settingsFor !== null && (
        <PropertySettingsModal
          client={client}
          propertySchemaId={settingsFor}
          onClose={() => setSettingsFor(null)}
          onOpenView={() => {
            setViewFor(settingsFor);
            setSettingsFor(null);
          }}
        />
      )}
      {viewFor !== null && (
        <PropertyView
          client={client}
          propertySchemaId={viewFor}
          onClose={() => setViewFor(null)}
          onOpenPage={(id) => {
            setViewFor(null);
            onOpenPage?.(id);
          }}
        />
      )}
      {historyFor !== null && (
        <PropertyHistoryModal
          client={client}
          nodeId={nodeId}
          propertySchemaId={historyFor}
          schemaName={
            client.listPropertySchemas().find((s) => s.id === historyFor)?.name ?? historyFor
          }
          onClose={() => setHistoryFor(null)}
        />
      )}
    </>
  );
}
