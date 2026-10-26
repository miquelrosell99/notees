import type { DatePrecision } from "@notees/domain";

import type { EffectiveProperty } from "@/core/workspace-client/index.js";

import { TextPropertyRow } from "./TextPropertyRow.js";
import { ObjectPropertyRow } from "./ObjectPropertyRow.js";
import { AssetPropertyRow } from "./AssetPropertyRow.js";
import { DatetimePropertyRow } from "./DatetimePropertyRow.js";
import { SelectPropertyRow } from "./SelectPropertyRow.js";
import { BooleanPropertyRow } from "./BooleanPropertyRow.js";
import type { AnyClient } from "./shared.js";

/**
 * GroupedPropertyRow — one row per grouped schema (node-typed / datetime /
 * boolean / text always; select schemas once they declare options), the
 * per-type value-row component chosen by schema type.
 * Shared by the properties table and the properties sidebar.
 */
export function GroupedPropertyRow({
  client,
  nodeId,
  type,
  propertySchemaId,
  label,
  multi,
  schema,
  bindingFilter,
  groupRows,
  onOpenPage,
  onOpenInSidebar,
  /** Hide the label/hints (the host chrome carries them — the sidebar). */
  bare = false,
  /** Read-only projection: the value renders statically, no mutation UI. */
  readOnly = false,
}: {
  client: AnyClient;
  nodeId: string;
  type: string | undefined;
  propertySchemaId: string;
  label: string;
  multi: boolean;
  schema: { datePrecision?: DatePrecision | null } | null;
  bindingFilter: string[] | null;
  groupRows: EffectiveProperty[];
  onOpenPage?: ((pageId: string) => void) | undefined;
  /** The carrier bullet's Shift+click peek. */
  onOpenInSidebar?: ((pageId: string) => void) | undefined;
  bare?: boolean;
  readOnly?: boolean | undefined;
}) {
  // R4 honest rendering: a grouped schema with an ineligible authored row
  // renders dimmed (the whole group — the schema excludes this node).
  const rowClassName = groupRows.some((row) => row.eligible === false)
    ? " nt-property-ineligible"
    : "";
  if (type === "datetime") {
    return (
      <DatetimePropertyRow
        client={client}
        nodeId={nodeId}
        propertySchemaId={propertySchemaId}
        label={label}
        multi={multi}
        schema={schema}
        rows={groupRows}
        onOpenPage={onOpenPage}
        bare={bare}
        readOnly={readOnly}
        rowClassName={rowClassName}
      />
    );
  }
  if (type === "select" || type === "multi_select") {
    const options =
      client.listPropertySchemas().find((s) => s.id === propertySchemaId)?.options ?? [];
    return (
      <SelectPropertyRow
        client={client}
        nodeId={nodeId}
        propertySchemaId={propertySchemaId}
        label={label}
        multi={type === "multi_select" ? true : multi}
        options={options}
        rows={groupRows}
        bare={bare}
        readOnly={readOnly}
        rowClassName={rowClassName}
      />
    );
  }
  if (type === "boolean") {
    return (
      <BooleanPropertyRow
        client={client}
        nodeId={nodeId}
        propertySchemaId={propertySchemaId}
        label={label}
        rows={groupRows}
        bare={bare}
        readOnly={readOnly}
        rowClassName={rowClassName}
      />
    );
  }
  if (type === "text") {
    return (
      <TextPropertyRow
        client={client}
        nodeId={nodeId}
        propertySchemaId={propertySchemaId}
        label={label}
        multi={multi}
        rows={groupRows}
        onOpenPage={onOpenPage}
        onOpenInSidebar={onOpenInSidebar}
        bare={bare}
        readOnly={readOnly}
        rowClassName={rowClassName}
      />
    );
  }
  if (type === "asset") {
    return (
      <AssetPropertyRow
        client={client}
        nodeId={nodeId}
        propertySchemaId={propertySchemaId}
        label={label}
        multi={multi}
        rows={groupRows}
        bare={bare}
        readOnly={readOnly}
        rowClassName={rowClassName}
      />
    );
  }
  return (
    <ObjectPropertyRow
      client={client}
      nodeId={nodeId}
      propertySchemaId={propertySchemaId}
      label={label}
      multi={multi}
      bindingFilter={bindingFilter}
      rows={groupRows}
      onOpenPage={onOpenPage}
      bare={bare}
      readOnly={readOnly}
      rowClassName={rowClassName}
    />
  );
}
