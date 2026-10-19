import type { EffectiveProperty } from "@/core/workspace-client.js";

import { cssColorFor } from "../../ui/components/ui/colorPresets.js";
import { SelectionPropertyControl, type SelectionOption } from "../../ui/components/pickers/SelectionPropertyControl.js";
import type { AnyClient } from "./shared.js";

/**
 * One select-typed property: the ported options control renders the selected
 * option pills (+ picker) for schemas that declare options; the value ids
 * reference the schema option ids.
 */
export function SelectPropertyRow({
  client,
  nodeId,
  propertySchemaId,
  label,
  multi,
  options,
  rows,
  /** Hide the label/hints (the host chrome carries them — the sidebar). */
  bare = false,
  /** Read-only projection: values render as static pills, no picker. */
  readOnly = false,
}: {
  client: AnyClient;
  nodeId: string;
  propertySchemaId: string;
  label: string;
  multi: boolean;
  options: SelectionOption[];
  rows: EffectiveProperty[];
  bare?: boolean;
  readOnly?: boolean | undefined;
}) {
  const ordered = [...rows].sort((a, b) => a.idx - b.idx);
  const allDefault = rows.length > 0 && rows.every((row) => row.source === "default");
  const classSourced = rows.some((row) => row.boundBy !== null);

  const valuesOf = (row: EffectiveProperty): string[] =>
    Array.isArray(row.value)
      ? row.value.filter((v): v is string => typeof v === "string")
      : typeof row.value === "string" && row.value !== ""
        ? [row.value]
        : [];

  if (readOnly) {
    // Read-only projection: each row's selected options ride static pills
    // (the option's color swatch + label, no control).
    const labelOfOption = (id: string): string =>
      options.find((option) => option.id === id)?.label ?? id;
    const pillRows = ordered.length > 0 ? ordered : rows;
    return (
      <>
        {pillRows.map((row) => (
          <li
            key={`${propertySchemaId}:${row.idx}`}
            className={
              allDefault
                ? "nt-property nt-property-default nt-property-select node-metadata-row"
                : "nt-property nt-property-select node-metadata-row"
            }
          >
            {!bare && (
              <>
                <span className="section-label nt-property-name" data-property-schema-id={propertySchemaId}>{label}{classSourced && <span className="nt-property-hint" title="From a class">C</span>}</span>
              </>
            )}
            <span className="nt-property-chips node-metadata-pills">
              {valuesOf(row).map((id) => {
                const option = options.find((entry) => entry.id === id);
                return (
                  <span
                    key={id}
                    className={row.source === "default" ? "pill pill--default" : "pill"}
                  >
                    <span
                      className="pill__text nt-chip-label"
                      style={
                        option?.color !== undefined && option.color !== null
                          ? { color: cssColorFor(option.color) }
                          : undefined
                      }
                    >
                      {labelOfOption(id)}
                    </span>
                  </span>
                );
              })}
            </span>
          </li>
        ))}
      </>
    );
  }

  const write = async (idx: number, value: unknown): Promise<void> => {
    await client.setProperty(nodeId, propertySchemaId, value, idx);
  };

  const remove = async (row: EffectiveProperty, optionId: string): Promise<void> => {
    const values = valuesOf(row).filter((id) => id !== optionId);
    if (multi && values.length > 0) {
      await write(row.idx, values);
    } else {
      await client.unsetProperty(nodeId, propertySchemaId, row.idx);
    }
  };

  return (
    <>
      {ordered.map((row) => (
        <li
          key={`${propertySchemaId}:${row.idx}`}
          className={
            allDefault
              ? "nt-property nt-property-default nt-property-select node-metadata-row"
              : "nt-property nt-property-select node-metadata-row"
          }
        >
          {!bare && (
            <>
              <span className="section-label nt-property-name" data-property-schema-id={propertySchemaId}>{label}{classSourced && <span className="nt-property-hint" title="From a class">C</span>}</span>
            </>
          )}
          <SelectionPropertyControl
            options={options}
            values={valuesOf(row)}
            multi={multi}
            onAdd={(optionId) => {
              const values = valuesOf(row);
              void write(
                row.idx,
                multi ? [...values.filter((id) => id !== optionId), optionId] : optionId,
              );
            }}
            onRemove={(optionId) => void remove(row, optionId)}
          />
        </li>
      ))}
      {ordered.length === 0 && (
        <li className="nt-property nt-property-select node-metadata-row">
          {!bare && (
            <span className="section-label nt-property-name" data-property-schema-id={propertySchemaId}>{label}</span>
          )}
          <SelectionPropertyControl
            options={options}
            values={[]}
            multi={multi}
            onAdd={(optionId) => void write(nextIdxOf([]), multi ? [optionId] : optionId)}
            onRemove={() => undefined}
          />
        </li>
      )}
    </>
  );
}

/** Next free idx for a schema with no effective rows yet. */
function nextIdxOf(rows: EffectiveProperty[]): number {
  const authoredIdx = rows.filter((row) => row.source === "authored").map((row) => row.idx);
  return authoredIdx.length > 0 ? Math.max(...authoredIdx) + 1 : 0;
}

