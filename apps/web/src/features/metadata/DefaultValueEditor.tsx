/**
 * DefaultValueEditor — the type-aware editor for a property schema's GLOBAL
 * default value (owner ruling 2026-10-20: the default moved from the class
 * binding to the schema — one default per property, the Logseq shape; the
 * class page no longer edits anything inline).
 *
 * Per type (the shared defaultCapable gate — text/number/boolean/select
 * only; node-typed schemas and the rest get NO default editor anywhere):
 *  - text: a plain input;
 *  - number: a numeric input (writes a real number);
 *  - boolean: a None/True/False dropdown (writes a real boolean);
 *  - select: a dropdown of the SCHEMA's options (the option id is the
 *    stored default).
 *
 * "None" writes an explicit null — the wire's keep/clear contract on
 * propertySchema.update (present-null clears; PC2 accepts null for every
 * type). The uncontrolled-controls remount trick (the value in the key)
 * resets a control to the stored value after its patch lands.
 */

import type { ClientPropertyOption } from "@/core/workspace-client/index.js";

export function DefaultValueEditor({
  type,
  value,
  options,
  ariaLabel,
  inputClass,
  id,
  onPatch,
}: {
  type: string;
  /** The current stored default (parsed JSON); null/undefined = none. */
  value: unknown;
  /** The schema's options (select only). */
  options: ReadonlyArray<ClientPropertyOption> | null;
  ariaLabel: string;
  inputClass: string;
  /** The remount key prefix (stable per edited schema). */
  id: string;
  /** value === null clears the default; otherwise the typed wire value. */
  onPatch: (value: unknown) => void;
}) {
  const stored = value === undefined || value === null ? null : value;
  const key = `def:${id}:${stored === null ? "" : JSON.stringify(stored)}`;
  const clear = () => {
    if (stored !== null) onPatch(null);
  };

  if (type === "boolean") {
    return (
      <select
        key={key}
        className={inputClass}
        aria-label={ariaLabel}
        defaultValue={stored === true ? "true" : stored === false ? "false" : ""}
        onChange={(event) => {
          const next = event.target.value;
          if (next === "") clear();
          else if (stored !== (next === "true")) onPatch(next === "true");
        }}
      >
        <option value="">None</option>
        <option value="true">True</option>
        <option value="false">False</option>
      </select>
    );
  }

  if (type === "select") {
    const storedId = typeof stored === "string" ? stored : "";
    return (
      <select
        key={key}
        className={inputClass}
        aria-label={ariaLabel}
        defaultValue={storedId}
        onChange={(event) => {
          const next = event.target.value;
          if (next === "") clear();
          else if (next !== storedId) onPatch(next);
        }}
      >
        <option value="">None</option>
        {(options ?? []).map((option) => (
          <option key={option.id} value={option.id}>
            {option.label}
          </option>
        ))}
      </select>
    );
  }

  if (type === "number") {
    const storedNumber = typeof stored === "number" ? stored : null;
    return (
      <input
        key={key}
        type="number"
        className={inputClass}
        placeholder="None"
        defaultValue={storedNumber ?? ""}
        aria-label={ariaLabel}
        onBlur={(event) => {
          const raw = event.target.value;
          if (raw === "") {
            clear();
            return;
          }
          const next = Number(raw);
          if (!Number.isFinite(next)) return;
          if (storedNumber === null || storedNumber !== next) onPatch(next);
        }}
      />
    );
  }

  // text (the defaultCapable gate keeps this the only remaining type).
  const storedText = typeof stored === "string" ? stored : "";
  return (
    <input
      key={key}
      type="text"
      className={inputClass}
      placeholder="None"
      defaultValue={storedText}
      aria-label={ariaLabel}
      onBlur={(event) => {
        const next = event.target.value;
        if (next === "") {
          clear();
          return;
        }
        if (next !== storedText) onPatch(next);
      }}
    />
  );
}
