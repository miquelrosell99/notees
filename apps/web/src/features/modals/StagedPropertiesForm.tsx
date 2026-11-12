/**
 * StagedPropertiesForm — the quick-create modal's dynamic properties form
 *: given the picked class's staged bindings (extends-aware,
 * alphabetical by property name — the read-time derivation law), one CONTROLLED
 * row per property holding its value in modal state. NOTHING touches the
 * client until the Create flush — cancel leaves zero log entries.
 *
 * Per-type editors compose the fleet components and mirror the metadata
 * panel's UI: text/url/email ride the TextField (multi schemas are one
 * monoblock input, split on ";" or newline at flush — the authors
 * convention), number rides a numeric TextField and parses at flush, date
 * rides a TextField holding a partial ISO (YYYY / YYYY-MM / YYYY-MM-DD)
 * resolved through the date chain at flush, boolean rides the fleet
 * Checkbox (tri-state: untouched writes no op), and select/multi_select
 * reuse the metadata panel's SelectionPropertyControl — already a purely
 * controlled surface (values + onAdd/onRemove, no client writes), so it
 * stages verbatim. Object/asset properties are excluded (they need a live
 * node's picker surfaces; settable later from the node's metadata panel).
 */

import type {
  StagedPropertyBinding,
  StagedPropertyValue,
} from "./quickCreate.js";
import { stagedLabelOf, stagedTypeOf } from "./quickCreate.js";
import { TextField } from "../../components/ui/kit/TextField.js";
import { Checkbox } from "../../components/ui/kit/Checkbox.js";
import { SelectionPropertyControl } from "../pickers/SelectionPropertyControl.js";
import "./StagedPropertiesForm.css";

export interface StagedPropertiesFormProps {
  /** The picked class's staged bindings (stagedBindingsOf — already filtered + sorted). */
  rows: StagedPropertyBinding[];
  /** The staged values, keyed by property schema id. */
  values: Record<string, StagedPropertyValue>;
  onChange: (propertySchemaId: string, value: StagedPropertyValue) => void;
}

export function StagedPropertiesForm({ rows, values, onChange }: StagedPropertiesFormProps) {
  return (
    <div className="staged-properties-form">
      {rows.map((row) => {
        const propertySchemaId = row.binding.propertySchemaId;
        const value = values[propertySchemaId];
        if (value === undefined) return null;
        const type = stagedTypeOf(row);
        const label = stagedLabelOf(row);
        const multi = row.schema?.multi ?? row.binding.multi;

        if (type === "boolean") {
          return (
            <div className="staged-properties-form__field" key={propertySchemaId}>
              <Checkbox
                size="sm"
                label={label}
                checked={value.kind === "boolean" ? value.value === true : false}
                onChange={(checked) =>
                  onChange(propertySchemaId, { kind: "boolean", value: checked })
                }
              />
            </div>
          );
        }

        if (type === "select" || type === "multi_select") {
          const optionIds = value.kind === "select" ? value.optionIds : [];
          const options = row.schema?.options ?? [];
          return (
            <div className="staged-properties-form__field" key={propertySchemaId}>
              <span className="staged-properties-form__label">{label}</span>
              <SelectionPropertyControl
                options={options}
                values={optionIds}
                multi={type === "multi_select" ? true : multi}
                onAdd={(optionId) =>
                  onChange(propertySchemaId, {
                    kind: "select",
                    optionIds: [optionId],
                  })
                }
                onRemove={() =>
                  onChange(propertySchemaId, { kind: "select", optionIds: [] })
                }
              />
            </div>
          );
        }

        if (type === "number") {
          return (
            <div className="staged-properties-form__field" key={propertySchemaId}>
              <TextField
                label={label}
                value={value.kind === "number" ? value.text : ""}
                onChange={(event) =>
                  onChange(propertySchemaId, { kind: "number", text: event.target.value })
                }
                placeholder="0"
                inputMode="decimal"
                autoComplete="off"
              />
            </div>
          );
        }

        if (type === "datetime") {
          return (
            <div className="staged-properties-form__field" key={propertySchemaId}>
              <TextField
                label={label}
                value={value.kind === "date" ? value.text : ""}
                onChange={(event) =>
                  onChange(propertySchemaId, { kind: "date", text: event.target.value })
                }
                placeholder="YYYY, YYYY-MM, or YYYY-MM-DD"
                autoComplete="off"
              />
            </div>
          );
        }

        // text / url / email — the monoblock editor; multi schemas split at flush.
        return (
          <div className="staged-properties-form__field" key={propertySchemaId}>
            <TextField
              label={label}
              value={value.kind === "text" ? value.text : ""}
              onChange={(event) =>
                onChange(propertySchemaId, { kind: "text", text: event.target.value })
              }
              placeholder={multi ? "Separate entries with ; or a new line" : label}
              autoComplete="off"
            />
          </div>
        );
      })}
    </div>
  );
}
