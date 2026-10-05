/**
 * PropertyConvertModal — blessed delete+recreate type conversion
 * (§34.32 PG3; owner ruling 2026-10-04: the recommendation side of the
 * register — conversion machinery à la Capacities is NOT built; one honest
 * flow instead):
 *
 *   1. pick the new type (the `image` zombie has no defined value shape —
 *      PG14 — and is not offered as a target);
 *   2. the plan computes same-shape copies per authored value (node-ref
 *      family → node-typed targets, scalars → scalar targets, select family
 *      options carry over so option ids keep resolving); every value that
 *      does not map is LISTED, and is dropped only after an explicit
 *      "--yes-style" confirmation (the checkbox);
 *   3. on confirm: create the new schema (fresh UUIDv7 — delete+recreate
 *      under the SAME id would keep the dead type's values visible), copy
 *      the mappable values at their slot idx, rebind every class binding
 *      (sequence/flags; a defaultValue copies only when it type-checks per
 *      PC2), then delete the old schema (soft-delete — the blessed path,
 *      values under it survive in the log);
 *   4. a copy that fails the apply-time validation (PG6: class filter,
 *      target existence, precision) is recorded as dropped with the
 *      applier's reason — the flow never half-writes silently.
 *
 * Result state reports created/copied/dropped; the modal closes on Done.
 */

import { useMemo, useState } from "react";

import { isValidDefaultForType } from "@notees/store";

import type { WorkerClient } from "@/core/worker-client.js";
import type {
  ClientPropertyOption,
  ClientPropertySchema,
  EffectiveProperty,
  WorkspaceClient,
} from "@/core/workspace-client.js";

import { displayNameFromClient } from "../dateDisplay.js";
import { Modal } from "./ui/Modal.js";
import { Button } from "./ui/Button.js";
import { Checkbox } from "./ui/Checkbox.js";
import "./PropertyConvertModal.css";

type AnyClient = WorkspaceClient | WorkerClient;

/** The wire property types offered as conversion targets (no `image`). */
const TARGET_TYPES = [
  "text",
  "number",
  "boolean",
  "date",
  "date_range",
  "url",
  "email",
  "select",
  "multi_select",
  "object",
] as const;

type Conversion =
  | { ok: true; value: unknown }
  | { ok: false; reason: string };

interface DroppedValue {
  nodeLabel: string;
  preview: string;
  reason: string;
}

interface CopiedValue {
  nodeId: string;
  idx: number;
  value: unknown;
}

interface ConvertPlan {
  copied: CopiedValue[];
  dropped: DroppedValue[];
  /** select-family target: the old options carry over verbatim (PG16 colors included). */
  carriedOptions: ClientPropertyOption[] | null;
}

function isNodeRef(value: unknown): value is { nodeId: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { nodeId?: unknown }).nodeId === "string"
  );
}

function isRange(value: unknown): value is { start?: unknown; end?: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Same-shape copy of one value to the target type; null = "no value". */
export function convertValueForType(
  value: unknown,
  from: string,
  to: string,
  targetOptions: ClientPropertyOption[] | null,
): Conversion {
  if (value === null || value === undefined) return { ok: true, value: null };
  const drop = (reason: string): Conversion => ({ ok: false, reason });
  const scalarTarget = to === "text" || to === "url" || to === "email";
  if (scalarTarget) {
    if (typeof value === "string") {
      // select values are option IDS — the honest text is the label.
      if (from === "select" || from === "multi_select") {
        const option = targetOptions?.find((o) => o.id === value);
        return option !== undefined
          ? { ok: true, value: option.label }
          : drop("option id has no label to copy as text");
      }
      return { ok: true, value };
    }
    if (to === "text" && typeof value === "number" && Number.isFinite(value)) {
      return { ok: true, value: String(value) };
    }
    return drop(`a ${typeof value === "object" ? "linked" : from} value has no text form`);
  }
  if (to === "number") {
    if (typeof value === "number" && Number.isFinite(value)) return { ok: true, value };
    if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
      return { ok: true, value: Number(value) };
    }
    return drop("not a number (or a numeric string)");
  }
  if (to === "boolean") {
    return typeof value === "boolean" ? { ok: true, value } : drop("not a boolean");
  }
  if (to === "select") {
    const id = typeof value === "string" ? value : null;
    if (id !== null && targetOptions?.some((o) => o.id === id) === true) {
      return { ok: true, value: id };
    }
    return drop("option id does not exist on the new schema");
  }
  if (to === "multi_select") {
    const ids = Array.isArray(value)
      ? value
      : typeof value === "string" && (from === "select" || from === "multi_select")
        ? [value]
        : null;
    if (ids !== null && ids.every((v) => typeof v === "string")) {
      const kept = (ids as string[]).filter((id) => targetOptions?.some((o) => o.id === id));
      return kept.length > 0
        ? { ok: true, value: kept }
        : drop("no option id exists on the new schema");
    }
    return drop("not an option-id list");
  }
  if (to === "object" || to === "date") {
    return isNodeRef(value)
      ? { ok: true, value }
      : drop("only linked values map to a node-typed schema");
  }
  if (to === "date_range") {
    if (isRange(value)) {
      const start = value.start ?? null;
      const end = value.end ?? null;
      if (
        (start === null || isNodeRef(start)) &&
        (end === null || isNodeRef(end))
      ) {
        return { ok: true, value: { start, end } };
      }
    }
    return drop("only a {start,end} date range maps to date_range");
  }
  return drop(`conversion to ${to} is not supported`);
}

/** Build the plan: every authored value of the schema, mapped or listed. */
export function buildConvertPlan(
  client: AnyClient,
  schema: ClientPropertySchema,
  targetType: string,
  carryOptions: boolean,
): ConvertPlan {
  const sameOptionFamily =
    (schema.type === "select" || schema.type === "multi_select") &&
    (targetType === "select" || targetType === "multi_select");
  const carriedOptions = sameOptionFamily && carryOptions ? (schema.options ?? []) : null;
  const targetOptions = targetType === "select" || targetType === "multi_select" ? carriedOptions : null;
  const copied: CopiedValue[] = [];
  const dropped: DroppedValue[] = [];
  for (const node of client.getPropertyReferences(schema.id)) {
    const rows = client
      .getEffectiveProperties(node.id)
      .filter(
        (row): row is EffectiveProperty =>
          row.propertySchemaId === schema.id && row.source === "authored",
      );
    const label = displayNameFromClient(client, node.id) ?? node.id;
    for (const row of rows) {
      const result = convertValueForType(row.value, schema.type, targetType, targetOptions);
      const preview = JSON.stringify(row.value);
      if (result.ok) {
        copied.push({ nodeId: node.id, idx: row.idx, value: result.value });
      } else {
        dropped.push({
          nodeLabel: label,
          preview: preview.length > 60 ? `${preview.slice(0, 57)}…` : preview,
          reason: result.reason,
        });
      }
    }
  }
  return { copied, dropped, carriedOptions };
}

export function PropertyConvertModal({
  client,
  schema,
  onClose,
}: {
  client: AnyClient;
  schema: ClientPropertySchema;
  onClose: () => void;
}) {
  const [targetType, setTargetType] = useState<string | null>(null);
  const [carryOptions, setCarryOptions] = useState(true);
  const [confirmDrop, setConfirmDrop] = useState(false);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<{ createdId: string; copied: number; dropped: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const plan = useMemo(
    () =>
      targetType === null
        ? null
        : buildConvertPlan(client, schema, targetType, carryOptions),
    [client, schema, targetType, carryOptions],
  );

  /** multi_select is always multi; otherwise the old cardinality carries. */
  const targetMulti = targetType === "multi_select" ? true : schema.multi;

  async function runConversion(): Promise<void> {
    if (targetType === null || plan === null) return;
    setRunning(true);
    setError(null);
    try {
      const createdId = await client.createPropertySchema({
        name: schema.name,
        type: targetType,
        multi: targetMulti,
        scope: schema.scope,
        ...(plan.carriedOptions !== null ? { options: plan.carriedOptions } : {}),
        ...(schema.targetClassFilter !== null && (targetType === "object" || targetType === "date")
          ? { targetClassFilter: schema.targetClassFilter }
          : {}),
        ...(schema.datePrecision !== null && (targetType === "date" || targetType === "date_range")
          ? { datePrecision: schema.datePrecision }
          : {}),
      });
      // §34.90: the render contracts are PROPERTY-level and the create input
      // carries none — patch the new schema with the old row's contracts.
      // Value display only rides types the row button renders (select /
      // multi_select / boolean); read-only and hide-when-empty are
      // type-agnostic.
      const carriesDisplay =
        schema.display !== null &&
        schema.display !== undefined &&
        (targetType === "select" || targetType === "multi_select" || targetType === "boolean");
      if (carriesDisplay || schema.readonly != null || schema.hideWhenEmpty != null) {
        await client.updatePropertySchema(createdId, {
          ...(carriesDisplay ? { display: schema.display } : {}),
          ...(schema.readonly != null ? { readonly: schema.readonly } : {}),
          ...(schema.hideWhenEmpty != null ? { hideWhenEmpty: schema.hideWhenEmpty } : {}),
        });
      }
      // Copy mappable values at their slot idx; a PG6 validation failure
      // lands in the dropped list with the applier's reason.
      let copied = 0;
      let dropped = plan.dropped.length;
      for (const entry of plan.copied) {
        try {
          await client.setProperty(entry.nodeId, createdId, entry.value, entry.idx);
          copied++;
        } catch (err) {
          dropped++;
          plan.dropped.push({
            nodeLabel: displayNameFromClient(client, entry.nodeId) ?? entry.nodeId,
            preview: JSON.stringify(entry.value),
            reason: err instanceof Error ? err.message : String(err),
          });
        }
      }
      // Rebind every class that bound the old schema: create the new
      // binding, then remove the old row (class.property.unset — binding
      // rows survive schema deletion by design, so "rebind" is explicit).
      for (const klass of client.listClasses()) {
        const binding = client
          .getClassBindings(klass.id)
          .find((b) => b.propertySchemaId === schema.id);
        if (binding === undefined) continue;
        await client.setClassProperty(klass.id, createdId, {
          sequence: binding.sequence,
          ...(binding.required !== null ? { required: binding.required } : {}),
          ...(binding.defaultValue !== null && binding.defaultValue !== undefined &&
          isValidDefaultForType(targetType, binding.defaultValue)
            ? { defaultValue: binding.defaultValue }
            : {}),
        });
        await client.unsetClassProperty(klass.id, schema.id);
      }
      await client.deletePropertySchema(schema.id);
      setResult({ createdId, copied, dropped });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  }

  return (
    <Modal isOpen onClose={onClose} size="md" showCloseButton={false} className="nt-property-convert">
      <div className="modal__header">
        <h2 className="modal__title">Convert “{schema.name}”</h2>
        <button
          type="button"
          aria-label="Close modal"
          className="btn btn--ghost btn--sm btn--icon-only modal__close"
          onClick={onClose}
        >
          ×
        </button>
      </div>
      <div className="modal__content">
        {result === null && (
          <>
            <p className="nt-property-convert__intro">
              Conversion creates a new {schema.multi ? "multi " : ""}
              <strong>{schema.type}</strong> schema in place of this one: mappable values copy over,
              class bindings re-point, then the old schema is deleted. Unmappable values are listed
              below and dropped only with your confirmation.
            </p>
            <label className="nt-property-settings__field">
              <span className="nt-property-settings__label">New type</span>
              <select
                className="nt-property-settings__input"
                aria-label="New property type"
                value={targetType ?? ""}
                onChange={(event) => {
                  setTargetType(event.target.value === "" ? null : event.target.value);
                  setConfirmDrop(false);
                }}
              >
                <option value="">Choose a type…</option>
                {TARGET_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {type}
                  </option>
                ))}
              </select>
            </label>
            {plan?.carriedOptions !== null && plan !== null && (
              <label className="nt-property-settings__check">
                <Checkbox
                  checked={carryOptions}
                  onChange={(event) => setCarryOptions(event.target.checked)}
                  aria-label="Carry options over"
                />
                <span>Carry the {plan.carriedOptions?.length ?? 0} options over (ids and colors preserved)</span>
              </label>
            )}
            {plan !== null && (
              <div className="nt-property-convert__plan">
                <p>
                  <strong>{plan.copied.length}</strong> value{plan.copied.length === 1 ? "" : "s"}{" "}
                  will copy to the new schema.
                </p>
                {plan.dropped.length > 0 && (
                  <div className="nt-property-convert__dropped">
                    <p>
                      <strong>{plan.dropped.length}</strong> value
                      {plan.dropped.length === 1 ? "" : "s"} cannot be converted and will be{" "}
                      <strong>dropped</strong>:
                    </p>
                    <ul>
                      {plan.dropped.map((entry, index) => (
                        <li key={index}>
                          <span className="nt-property-convert__dropped-node">{entry.nodeLabel}</span>{" "}
                          <code>{entry.preview}</code> — {entry.reason}
                        </li>
                      ))}
                    </ul>
                    <label className="nt-property-settings__check">
                      <Checkbox
                        checked={confirmDrop}
                        onChange={(event) => setConfirmDrop(event.target.checked)}
                        aria-label="Confirm dropping unmappable values"
                      />
                      <span>I understand these values will be dropped</span>
                    </label>
                  </div>
                )}
              </div>
            )}
            {error !== null && (
              <p role="alert" className="nt-error">
                {error}
              </p>
            )}
          </>
        )}
        {result !== null && (
          <div className="nt-property-convert__result">
            <p>
              Converted <strong>{schema.name}</strong>: {result.copied} value
              {result.copied === 1 ? "" : "s"} copied
              {result.dropped > 0 ? `, ${result.dropped} dropped` : ""}. The old schema was deleted;
              the new schema has a fresh id.
            </p>
          </div>
        )}
      </div>
      <div className="modal__footer">
        {result === null ? (
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={
                targetType === null ||
                running ||
                (plan !== null && plan.dropped.length > 0 && !confirmDrop)
              }
              onClick={() => void runConversion()}
            >
              {running ? "Converting…" : "Convert"}
            </Button>
          </>
        ) : (
          <Button variant="default" onClick={onClose}>
            Done
          </Button>
        )}
      </div>
    </Modal>
  );
}
