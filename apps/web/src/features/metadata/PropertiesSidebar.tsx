import { useState } from "react";

import { isReadonlyProperty } from "@notees/domain";

import type { EffectiveProperty } from "@/core/workspace-client/index.js";

import { Icon } from "../../ui/Icon.js";
import { NodeViewSection } from "../page-sections/NodeViewSection.js";
import { ContextMenu } from "../../components/ui/fleet/ContextMenu.js";
import { PropertyView } from "./PropertyView.js";
import { PropertyHistoryModal } from "./PropertyHistoryModal.js";
import { AliasedNodeRow } from "./AliasedNodeRow.js";
import type { AnyClient } from "./shared.js";
import { propertiesCountOf, propertyGroupsOf } from "./propertyGroups.js";
import { AliasesRow } from "./AliasesRow.js";
import { GroupedPropertyRow } from "./GroupedPropertyRow.js";
import { ScalarPropertyValue } from "./ScalarPropertyValue.js";
import { AddPropertyRow } from "./AddPropertyRow.js";
import { PropertySettingsModal } from "./PropertySettingsModal.js";

/**
 * PropertiesSidebar — the main layout's first column (owner 2026-10-06;
 * renamed "Metadata" + the aliases row on top, owner 2026-10-09):
 * a set of rows, one per property — a property-name row followed by its
 * value-cell row — beside a continuous vertical divider (the sidebar's
 * right edge runs the card's full height, no top or bottom gap). The rows
 * ride a collapsible NodeViewSection (owner 2026-10-09, expanded by
 * default): the section header names the column — dotted-list icon +
 * "Metadata" + the effective row count — and collapsing keeps the
 * column's divider while the rows step aside. The panel's FIRST section is
 * the aliases row (relocated from the title-row button): every alias of the
 * page as pills with an × each, "+ Add alias" riding the pages-only picker
 * (the backward write, exactly like the retired popup). The value cells
 * reuse the properties table's row components verbatim (only their internal
 * label/hints hide — the name row above carries them); only the two-row
 * stacking and the divider are this component's own. Clicking a name row
 * opens the property's settings, like the table's label click.
 */
export function PropertiesSidebar({
  client,
  nodeId,
  onOpenPage,
  onOpenPageRaw = undefined,
}: {
  client: AnyClient;
  nodeId: string;
  onOpenPage?: ((pageId: string) => void) | undefined;
  /** The RAW open for the aliases row's pill (bypasses the alias redirect). */
  onOpenPageRaw?: ((pageId: string) => void) | undefined;
}) {
  const groups = propertyGroupsOf(client, nodeId);
  const { rendered, emptyObjectBindings } = groups;
  const count = propertiesCountOf(groups);
  const [settingsFor, setSettingsFor] = useState<string | null>(null);
  const [viewFor, setViewFor] = useState<string | null>(null);
  const [historyFor, setHistoryFor] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ schemaId: string; x: number; y: number } | null>(null);
  const labelOf = (row: EffectiveProperty): string => row.schema?.name ?? row.propertySchemaId;

  const hintOf = (rows: EffectiveProperty[]): string | null =>
    rows.some((row) => row.boundBy !== null) ? "C" : null;

  // The name row's right-click menu rides the same actions as the table's
  // label (Open property / Value history / Empty / Remove).
  const rowsOf = rendered.flatMap((entry) =>
    entry === null ? [] : entry.kind === "grouped" ? entry.groupRows : [entry.row],
  );
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
    for (const row of rowsOf) {
      if (row.propertySchemaId === schemaId && row.source === "authored") {
        void client.setProperty(nodeId, schemaId, "", row.idx);
      }
    }
  };
  const removeFromNode = (schemaId: string) => {
    for (const row of rowsOf) {
      if (row.propertySchemaId === schemaId && row.source === "authored") {
        void client.unsetProperty(nodeId, schemaId, row.idx);
      }
    }
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
        onClick: () => emptyProperty(schemaId),
        disabled: readonly,
      },
      {
        id: "remove",
        label: "Remove from node",
        icon: "mdi-close-circle-outline",
        onClick: () => removeFromNode(schemaId),
        danger: true,
        disabled: bound || readonly,
      },
    ];
  };

  const nameRow = (propertySchemaId: string, label: string, hint: string | null) => (
    <button
      type="button"
      className="nt-props-sidebar__name nt-property-name"
      data-property-schema-id={propertySchemaId}
      onClick={() => setSettingsFor(propertySchemaId)}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        setMenu({ schemaId: propertySchemaId, x: event.clientX, y: event.clientY });
      }}
    >
      {label}
      {hint !== null && (
        <span className="nt-property-hint" title={hint === "C" ? "From a class" : undefined}>
          {hint}
        </span>
      )}
    </button>
  );

  return (
    <div className="nt-props-sidebar">
      <NodeViewSection
        title="Properties"
        icon={<Icon path="mdi-format-list-bulleted" size={0.9} />}
        count={count}
        className="nt-props-sidebar__section"
        defaultExpanded={true}
      >
        {/* The aliases row is the panel's first section (relocated from the
            title-row button): the node's own aliases as pills + the add
            picker; the raw open keeps the retired popup's NAVIGATE bypass. */}
        <AliasesRow client={client} nodeId={nodeId} onOpenPage={onOpenPage} onOpenPageRaw={onOpenPageRaw} />
        {/* The alias-side pseudo-property rides the sidebar's row stack too
            (only when the node IS an alias — the row renders null otherwise
            and the wrapper must not leave an empty slot). */}
        {client.getNode(nodeId)?.aliasedNodeId != null && (
          <div className="nt-props-sidebar__prop">
            <AliasedNodeRow client={client} nodeId={nodeId} onOpenPage={onOpenPage} />
          </div>
        )}
        {rendered.map((entry) => {
        if (entry === null) return null;
        if (entry.kind === "grouped") {
          const schema = entry.groupRows[0]?.schema ?? null;
          const label = schema?.name ?? entry.propertySchemaId;
          return (
            <div className="nt-props-sidebar__prop" key={entry.propertySchemaId}>
              {nameRow(entry.propertySchemaId, label, hintOf(entry.groupRows))}
              <div className="nt-props-sidebar__value">
                <GroupedPropertyRow
                  client={client}
                  nodeId={nodeId}
                  type={entry.type}
                  propertySchemaId={entry.propertySchemaId}
                  label={label}
                  multi={schema?.multi ?? true}
                  schema={schema}
                  bindingFilter={null}
                  groupRows={entry.groupRows}
                  onOpenPage={onOpenPage}
                  bare
                />
              </div>
            </div>
          );
        }
        const row = entry.row;
        return (
          <div className="nt-props-sidebar__prop" key={`${row.propertySchemaId}:${row.idx}`}>
            {nameRow(
              row.propertySchemaId,
              labelOf(row),
              row.boundBy !== null ? "C" : null,
            )}
            <div className="nt-props-sidebar__value">
              <ScalarPropertyValue client={client} nodeId={nodeId} row={row} onOpenPage={onOpenPage} />
            </div>
          </div>
        );
      })}
      {emptyObjectBindings.map((binding) => (
        <div className="nt-props-sidebar__prop" key={`empty-${binding.propertySchemaId}`}>
          {nameRow(binding.propertySchemaId, binding.name, null)}
          <div className="nt-props-sidebar__value">
            <GroupedPropertyRow
              client={client}
              nodeId={nodeId}
              type={binding.type}
              propertySchemaId={binding.propertySchemaId}
              label={binding.name}
              multi={binding.multi}
              schema={{ datePrecision: binding.datePrecision }}
              bindingFilter={binding.targetClassFilter}
              groupRows={[]}
              onOpenPage={onOpenPage}
              bare
            />
          </div>
        </div>
      ))}
        <AddPropertyRow client={client} nodeId={nodeId} />
      </NodeViewSection>
      {menu !== null && (
        <ContextMenu items={menuItems(menu.schemaId)} position={{ x: menu.x, y: menu.y }} onClose={() => setMenu(null)} />
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
    </div>
  );
}

