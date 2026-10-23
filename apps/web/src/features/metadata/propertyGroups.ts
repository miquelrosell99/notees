import { SYSTEM_PROPERTY_UUIDS } from "@notees/domain";

import type {
  ClassBinding,
  PropertyDisplay,
} from "@/core/workspace-client/index.js";
import type { AnyClient } from "./shared.js";

/**
 * The property-rows model shared by the Metadata section (blocks) and the
 * Properties section (pages): effective rows grouped per schema, plus the
 * bound-but-empty grouped bindings that still render an add affordance.
 *
 * `omitDisplayPositions` filters out rows whose SCHEMA carries a
 * bullet/inline value-display position (the render contracts are
 * property-level; the block row surfaces those values itself — the panel
 * must not duplicate them). The same filter applies to the bound-but-empty
 * bindings, whose add affordance the block row's icon button already covers.
 */
export function propertyGroupsOf(
  client: AnyClient,
  nodeId: string,
  omitDisplayPositions?: ReadonlyArray<"bullet" | "inline">,
) {
  const omittedByDisplay = (display: PropertyDisplay | null): boolean =>
    (display === "bullet" || display === "inline") &&
    (omitDisplayPositions?.includes(display) ?? false);
  const node = client.getNode(nodeId);
  // Class pages: the class's has-template values render in the dedicated
  // Templates section — the generic table suppresses that schema row. The
  // cover schema is suppressed EVERYWHERE: the cover is header
  // chrome (PageBanner/AddCover), never a property row.
  const isClassNode = node?.isClass === true;
  const rows = client
    .getEffectiveProperties(nodeId)
    .filter(
      (row) =>
        !(isClassNode && row.propertySchemaId === SYSTEM_PROPERTY_UUIDS.hasTemplate) &&
        row.propertySchemaId !== SYSTEM_PROPERTY_UUIDS.cover &&
        !omittedByDisplay(row.display),
    );

  // Node-typed / datetime / boolean / text schemas render as one
  // grouped row per schema; the `asset` type joins the family with its
  // dedicated row (the upload/link chrome + the multi asset list).
  // Select AND multi_select schemas join them only when they declare
  // options (without options the minimal text editor is the honest editor —
  // there is nothing to pick; the shape routes multi_select to the selection
  // control). Text groups render as a blocks list (the carrier blocks
  // themselves). Grouped rows appear at their first occurrence so the panel
  // order is unchanged.
  const optionsOf = (propertySchemaId: string) =>
    client.listPropertySchemas().find((s) => s.id === propertySchemaId)?.options;
  const isGroupedType = (type: string | undefined, propertySchemaId: string): boolean => {
    if (type === "object" || type === "asset" || type === "datetime" || type === "boolean" || type === "text") {
      return true;
    }
    if (type === "select" || type === "multi_select") {
      const options = optionsOf(propertySchemaId);
      return options !== null && options !== undefined && options.length > 0;
    }
    return false;
  };

  const renderedGroups = new Set<string>();
  const rendered = rows.map((row) => {
    const type = row.schema?.type;
    if (!isGroupedType(type, row.propertySchemaId)) {
      return { kind: "scalar" as const, row };
    }
    if (renderedGroups.has(row.propertySchemaId)) return null;
    renderedGroups.add(row.propertySchemaId);
    return {
      kind: "grouped" as const,
      propertySchemaId: row.propertySchemaId,
      type,
      // An ASSIGNED-EMPTY row (owner ruling 2026-10-23 — property.assign
      // without a value) reduces to the bound-but-empty shape: the grouped
      // row's add/set affordance authors the first value (the store shadows
      // the synthetic row the moment a value exists, so an assigned row
      // never coexists with authored carriers).
      groupRows: rows.filter(
        (r) => r.propertySchemaId === row.propertySchemaId && r.source !== "assigned",
      ),
    };
  });

  // A bound grouped property with no effective rows still renders: the row
  // hosts the add/set affordance (the scalar editor has no way to author a
  // first value). hide-when-empty schemas are the exception: the
  // render contracts are property-level — read from the schema row, not the
  // binding).
  const emptyObjectBindings: ClassBinding[] = [];
  for (const classId of node?.classIds ?? []) {
    for (const binding of client.getClassBindings(classId)) {
      if (!isGroupedType(binding.type, binding.propertySchemaId)) continue;
      if (isClassNode && binding.propertySchemaId === SYSTEM_PROPERTY_UUIDS.hasTemplate) continue;
      if (binding.propertySchemaId === SYSTEM_PROPERTY_UUIDS.cover) continue;
      const schemaRow = client.listPropertySchemas().find((s) => s.id === binding.propertySchemaId);
      if (omittedByDisplay(schemaRow?.display ?? null)) continue;
      if (renderedGroups.has(binding.propertySchemaId)) continue;
      if (emptyObjectBindings.some((b) => b.propertySchemaId === binding.propertySchemaId)) continue;
      if (schemaRow?.hideWhenEmpty === true) continue;
      emptyObjectBindings.push(binding);
    }
  }

  return { rows, rendered, emptyObjectBindings };
}

export type PropertyGroups = ReturnType<typeof propertyGroupsOf>;

/** Visible table rows: scalars + one per grouped schema + empty bindings. */
export function propertiesCountOf(groups: PropertyGroups): number {
  return groups.rendered.filter((entry) => entry !== null).length + groups.emptyObjectBindings.length;
}

/**
 * The node's effective metadata row count — the section's emptiness test.
 * Exported for hosts that gate sibling chrome on it (PageView hides the
 * whole in-flow section, divider included, on empty embedded renders — the
 * journal and calendar day feeds).
 */
export function metadataRowCount(client: AnyClient, nodeId: string): number {
  return propertiesCountOf(propertyGroupsOf(client, nodeId));
}
