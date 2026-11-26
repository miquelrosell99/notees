/**
 * PillsRow — the pill display position (2026-11-26, the display-position
 * program): properties whose schema carries `display: "pill"` render as
 * pills in a dedicated row UNDER the block — including when the value is
 * EMPTY, the pill itself the add/edit affordance (the owner's ask: the
 * task Scheduled/Deadline dates as clickable pills). Each pill is a
 * ButtonWithPanel: the property name + the formatted value (a dim
 * "+ <name>" state when unvalued), the panel mounting the shared
 * GroupedPropertyRow editor (bare) so every type edits through its
 * ordinary control. The properties section omits pill-position properties
 * (the bullet/inline de-duplication precedent); hide-when-empty schemas
 * stay hidden when unvalued (the render contract).
 */

import { useMemo } from "react";

import { ButtonWithPanel } from "../../components/ui/kit/ButtonWithPanel.js";
import type { PropertyRowShell } from "@/core/workspace-client/index.js";
import { propertyDisplayText } from "../collection/propertyDisplay.js";
import { GroupedPropertyRow } from "./GroupedPropertyRow.js";
import { effectivePropertyIcon } from "./propertyIcon.js";
import type { AnyClient } from "./shared.js";
import "./PillsRow.css";

interface PillGroup {
  propertySchemaId: string;
  name: string;
  type: string;
  multi: boolean;
  icon: string;
  /** The shell rows (may be empty — the unvalued pill). */
  rows: PropertyRowShell[];
}

/** The node's pill-position property groups, alphabetical by name. */
function pillGroupsOf(client: AnyClient, nodeId: string, classIds: string[]): PillGroup[] {
  const schemasById = new Map(client.listPropertySchemas().map((schema) => [schema.id, schema]));
  const groups = new Map<string, PillGroup>();
  // Valued + bound/assigned-empty rows ride the shells read (LIGHT values
  // present, the display read is schema-sourced).
  for (const row of client.getPropertyRowShells(nodeId)) {
    if (row.display !== "pill") continue;
    const schema = schemasById.get(row.propertySchemaId);
    const existing = groups.get(row.propertySchemaId);
    if (existing !== undefined) {
      existing.rows.push(row);
      continue;
    }
    groups.set(row.propertySchemaId, {
      propertySchemaId: row.propertySchemaId,
      name: schema?.name ?? row.propertySchemaId,
      type: schema?.type ?? "text",
      multi: schema?.multi ?? false,
      icon: effectivePropertyIcon(schema ?? null),
      rows: [row],
    });
  }
  // The bindings pass covers bound-empty declarations the shells gate out
  // (hide-when-empty) — same gates as the bullet/inline chrome.
  for (const classId of classIds) {
    for (const binding of client.getClassBindings(classId)) {
      if (groups.has(binding.propertySchemaId)) continue;
      const schema = schemasById.get(binding.propertySchemaId);
      if (schema?.display !== "pill") continue;
      if (schema.hideWhenEmpty === true) continue;
      groups.set(binding.propertySchemaId, {
        propertySchemaId: binding.propertySchemaId,
        name: binding.name,
        type: binding.type,
        multi: binding.multi,
        icon: effectivePropertyIcon(schema),
        rows: [],
      });
    }
  }
  return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
}

export function PillsRow({
  client,
  nodeId,
  classIds,
  readOnly = false,
}: {
  client: AnyClient;
  nodeId: string;
  classIds: string[];
  readOnly?: boolean;
}) {
  const groups = useMemo(() => pillGroupsOf(client, nodeId, classIds), [client, nodeId, classIds]);
  if (groups.length === 0) return null;
  return (
    <div className="nt-block-pills">
      {groups.map((group) => (
        <PropertyPill key={group.propertySchemaId} client={client} nodeId={nodeId} group={group} readOnly={readOnly} />
      ))}
    </div>
  );
}

/** One pill: the value summary button + the shared value editor panel. */
function PropertyPill({
  client,
  nodeId,
  group,
  readOnly,
}: {
  client: AnyClient;
  nodeId: string;
  group: PillGroup;
  readOnly: boolean;
}) {
  // The FULL read formats the value (heavy types included) — cheap at pill
  // scale and refreshed by the surrounding view's subscribe re-render.
  const rows = client
    .getEffectiveProperties(nodeId)
    .filter((row) => row.propertySchemaId === group.propertySchemaId);
  const valued = rows.find((row) => row.value !== null && row.value !== undefined);
  const text = valued !== undefined ? propertyDisplayText(client, valued) : "";
  const empty = text === "";
  return (
    <ButtonWithPanel
      variant="ghost"
      size="sm"
      disabled={readOnly}
      buttonClassName={["nt-prop-pill", empty ? "nt-prop-pill--empty" : ""].filter(Boolean).join(" ")}
      buttonText={empty ? `+ ${group.name}` : `${group.name}: ${text}`}
      title={group.name}
      panelPosition="bottom"
      panelAlignment="start"
      panelClassName="nt-prop-pill-panel"
    >
      <GroupedPropertyRow
        client={client}
        nodeId={nodeId}
        type={group.type}
        propertySchemaId={group.propertySchemaId}
        label={group.name}
        multi={group.multi}
        schema={null}
        bindingFilter={null}
        groupRows={rows}
        bare
        readOnly={readOnly}
        icon={group.icon}
      />
    </ButtonWithPanel>
  );
}
