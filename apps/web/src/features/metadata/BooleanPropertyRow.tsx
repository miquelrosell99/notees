import { isReadonlyProperty } from "@notees/domain";

import type { EffectiveProperty } from "@/core/workspace-client/index.js";

import { Checkbox } from "../../components/ui/fleet/Checkbox.js";
import type { AnyClient } from "./shared.js";

/**
 * One boolean property: the ported checkbox toggle writes the slot directly.
 */
export function BooleanPropertyRow({
  client,
  nodeId,
  propertySchemaId,
  label,
  rows,
  /** Hide the label/hints (the host chrome carries them — the sidebar). */
  bare = false,
  /** Read-only projection: the checkbox renders disabled. */
  readOnly = false,
  /** Extra li class (the R4 ineligible rendering — " nt-property-ineligible"). */
  rowClassName = "",
}: {
  client: AnyClient;
  nodeId: string;
  propertySchemaId: string;
  label: string;
  rows: EffectiveProperty[];
  bare?: boolean;
  readOnly?: boolean | undefined;
  rowClassName?: string;
}) {
  const ordered = [...rows].sort((a, b) => a.idx - b.idx);
  const allDefault = rows.length > 0 && rows.every((row) => row.source === "default");
  const classSourced = rows.some((row) => row.boundBy !== null);

  return (
    <>
      {ordered.map((row) => (
        <li
          key={`${propertySchemaId}:${row.idx}`}
          className={
            allDefault
              ? `nt-property nt-property-default nt-property-boolean node-metadata-row${rowClassName}`
              : `nt-property nt-property-boolean node-metadata-row${rowClassName}`
          }
        >
          {!bare && (
            <>
              <span className="section-label nt-property-name" data-property-schema-id={propertySchemaId}>{label}{classSourced && <span className="nt-property-hint" title="From a class">C</span>}</span>
            </>
          )}
          <Checkbox
            size="sm"
            checked={row.value === true}
            disabled={readOnly || isReadonlyProperty(propertySchemaId)}
            aria-label={`Property ${label}`}
            onChange={(checked) => {
              void client.setProperty(nodeId, propertySchemaId, checked, row.idx);
            }}
          />
        </li>
      ))}
      {ordered.length === 0 && (
        <li className={`nt-property nt-property-boolean node-metadata-row${rowClassName}`}>
          {!bare && (
            <span className="section-label nt-property-name" data-property-schema-id={propertySchemaId}>{label}</span>
          )}
          <Checkbox
            size="sm"
            checked={false}
            disabled={readOnly}
            aria-label={`Property ${label}`}
            onChange={(checked) => {
              void client.setProperty(nodeId, propertySchemaId, checked, 0);
            }}
          />
        </li>
      )}
    </>
  );
}
